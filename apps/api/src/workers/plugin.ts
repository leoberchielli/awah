import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { IntegrationDispatcher } from '../integrations/dispatcher'
import { OutboxDispatcher } from '../messaging/dispatcher'
import { purgeExpiredContent, recordMessage, recordStatus } from '../messaging/persistence'
import { RetentionResolver } from '../messaging/retention'
import { RiskRepository } from '../repos/risk'
import { BudgetTracker } from '../risk/budget'
import { RiskEngine } from '../risk/engine'
import { WebhookDispatcher } from '../webhooks/dispatcher'
import { emitWebhook } from '../webhooks/emit'

declare module 'fastify' {
  interface FastifyInstance {
    retention: RetentionResolver
    risk: RiskEngine
    integrations: IntegrationDispatcher
  }
}

/**
 * Starts the background processes: the send scheduler, webhook delivery and the
 * purge of expired content.
 *
 * All of them run inside the API process in this version. Pulling them out into
 * a separate worker is possible without changing any of this — the only coupling
 * is the database, and the claim already tolerates several concurrent consumers.
 */
export const workersPlugin = fp(
  async (app: FastifyInstance) => {
    const retention = new RetentionResolver(app.db)
    app.decorate('retention', retention)

    const risk = new RiskEngine({
      db: app.db,
      budget: new BudgetTracker(app.redis, app.db),
      enabled: app.env.RISK_ENGINE_ENABLED,
    })
    app.decorate('risk', risk)

    const integrations = new IntegrationDispatcher({
      db: app.db,
      encryptionKey: Buffer.from(app.env.ENCRYPTION_KEY, 'base64'),
      logger: app.log,
      maxAttempts: app.env.OUTBOX_MAX_ATTEMPTS,
    })
    app.decorate('integrations', integrations)

    if (!app.env.RISK_ENGINE_ENABLED) {
      app.log.warn(
        'RISK ENGINE OFF — the gateway will blast messages at the full speed of the queue. Use only with a disposable number.',
      )
    }

    /**
     * Messages arriving from the engine: persist, then publish.
     *
     * The handler never lets a failure escape to the session manager — a broken
     * webhook must not bring down the WhatsApp connection.
     */
    app.sessions.onMessageEvent(async (context, event) => {
      if (event.type === 'message.received') {
        await recordMessage(app.db, retention, {
          orgId: context.orgId,
          sessionId: context.sessionId,
          chatId: event.chatId,
          engineMessageId: event.engineMessageId,
          direction: event.fromMe ? 'outbound' : 'inbound',
          type: event.messageType,
          body: event.body,
          fromJid: event.fromJid,
          toJid: event.fromMe ? event.chatId : null,
          status: event.fromMe ? 'sent' : 'delivered',
          occurredAt: event.occurredAt,
        })

        // An echo of a message sent from another device on the same number is
        // not a "received message" to whoever is integrating.
        if (event.fromMe) return

        app.metrics.messagesReceived.inc({ session: context.sessionId })

        /**
         * External tools come after persistence and before the webhook.
         *
         * After persistence because the message has to be saved even if Chatwoot
         * is down; the dispatcher swallows its own failures precisely so that one
         * of them cannot bring down the rest of the handling.
         */
        await app.integrations.aoReceber({
          orgId: context.orgId,
          sessionId: context.sessionId,
          chatId: event.chatId,
          engineMessageId: event.engineMessageId,
          body: event.body,
          fromJid: event.fromJid,
          occurredAt: event.occurredAt,
        })

        await emitWebhook(app.db, {
          orgId: context.orgId,
          sessionId: context.sessionId,
          event: 'message.received',
          data: {
            sessionId: context.sessionId,
            messageId: event.engineMessageId,
            chatId: event.chatId,
            from: event.fromJid,
            type: event.messageType,
            body: event.body,
            timestamp: event.occurredAt.toISOString(),
          },
        })
        return
      }

      const advanced = await recordStatus(app.db, {
        orgId: context.orgId,
        sessionId: context.sessionId,
        engineMessageId: event.engineMessageId,
        status: event.status,
        occurredAt: event.occurredAt,
      })

      // Only publish when the state really moved: a repeated ACK is not an event.
      if (!advanced) return

      await emitWebhook(app.db, {
        orgId: context.orgId,
        sessionId: context.sessionId,
        event: 'message.status',
        data: {
          sessionId: context.sessionId,
          messageId: event.engineMessageId,
          chatId: event.chatId,
          status: event.status,
          timestamp: event.occurredAt.toISOString(),
        },
      })
    })

    /**
     * A session state change becomes a webhook. It is the signal that lets the
     * integrator react to a drop without polling the API in a loop — and the
     * `rawCode` goes with it because 428 and 401 call for different reactions.
     */
    app.sessions.onStatusChange(async (context, payload) => {
      if (payload.status === 'disconnected' || payload.status === 'logged_out') {
        // The translated cause becomes a label: network drop versus banned number.
        app.metrics.sessionDisconnects.inc({ cause: payload.cause ?? 'unknown' })
      }

      await emitWebhook(app.db, {
        orgId: context.orgId,
        sessionId: context.sessionId,
        event: 'session.status',
        data: {
          sessionId: context.sessionId,
          status: payload.status,
          cause: payload.cause ?? null,
          rawCode: payload.rawCode ?? null,
          timestamp: new Date().toISOString(),
        },
      })
    })

    const outbox = new OutboxDispatcher({
      db: app.db,
      sessions: app.sessions,
      risk,
      logger: app.log,
      observeSend: (result, seconds) => app.metrics.sendDuration.observe({ result }, seconds),
      intervalMs: app.env.OUTBOX_POLL_MS,
      batchSize: app.env.OUTBOX_BATCH_SIZE,
      maxConcurrent: app.env.OUTBOX_MAX_CONCURRENT,
      stuckAfterMs: app.env.OUTBOX_STUCK_AFTER_MS,

      /**
       * Every decision becomes a row in `risk_events`, including the ones that
       * let a message through. Storing only what was blocked would bias the
       * history and make it impossible to compare behavior before and after a
       * limit is adjusted.
       */
      onRiskDecision: async (job, decision) => {
        app.metrics.riskDecisions.inc({ action: decision.action })

        await new RiskRepository(app.db, job.orgId).record({
          sessionId: job.sessionId,
          outboxId: job.id,
          action: decision.action,
          score: decision.score,
          reason: decision.reason,
          delayMs: decision.delayMs,
          budget: {
            usage: decision.usage,
            limits: decision.limits,
            isNewContact: decision.isNewContact,
          },
        })
      },

      onDelivered: async (job, engineMessageId, sentAt) => {
        app.metrics.messagesSent.inc({ session: job.sessionId })

        await recordMessage(app.db, retention, {
          orgId: job.orgId,
          sessionId: job.sessionId,
          chatId: job.chatId,
          engineMessageId,
          direction: 'outbound',
          type: job.type,
          body: typeof job.payload.text === 'string' ? job.payload.text : null,
          toJid: job.chatId,
          outboxId: job.id,
          status: 'sent',
          occurredAt: sentAt,
        })

        await emitWebhook(app.db, {
          orgId: job.orgId,
          sessionId: job.sessionId,
          event: 'message.sent',
          data: {
            sessionId: job.sessionId,
            outboxId: job.id,
            clientMessageId: job.clientMessageId,
            messageId: engineMessageId,
            chatId: job.chatId,
            timestamp: sentAt.toISOString(),
          },
        })
      },

      onDead: async (job, error) => {
        app.metrics.messagesFailed.inc({ session: job.sessionId })

        await emitWebhook(app.db, {
          orgId: job.orgId,
          sessionId: job.sessionId,
          event: 'message.failed',
          data: {
            sessionId: job.sessionId,
            outboxId: job.id,
            clientMessageId: job.clientMessageId,
            chatId: job.chatId,
            error,
            attempts: job.attempts + 1,
          },
        })
      },
    })

    const webhooks = new WebhookDispatcher({
      db: app.db,
      logger: app.log,
      intervalMs: app.env.WEBHOOK_POLL_MS,
      batchSize: app.env.WEBHOOK_BATCH_SIZE,
      requestTimeoutMs: app.env.WEBHOOK_TIMEOUT_MS,
      observeDelivery: (outcome, seconds) => {
        app.metrics.webhookDeliveries.inc({ outcome })
        app.metrics.webhookDuration.observe({ outcome }, seconds)
      },
    })

    // Purge of content expired under the organization's retention policy.
    const sweep = setInterval(() => {
      void purgeExpiredContent(app.db)
        .then((purged) => {
          if (purged > 0) app.log.info({ purged }, 'expired content deleted')
        })
        .catch((error) => app.log.error({ err: error }, 'retention purge failed'))
    }, app.env.RETENTION_SWEEP_MS)
    sweep.unref()

    outbox.start()
    webhooks.start()

    app.addHook('onClose', async () => {
      clearInterval(sweep)
      await Promise.allSettled([outbox.stop(), webhooks.stop()])
    })
  },
  { name: 'awah-workers', dependencies: ['awah-sessions'] },
)
