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
 * Liga os processos de fundo: scheduler de envio, entrega de webhooks e expurgo
 * de conteúdo vencido.
 *
 * Todos rodam dentro do processo da API nesta versão. Extrair para um worker
 * separado é possível sem mudar nada disto — o acoplamento é só o banco, e o
 * claim já tolera vários consumidores concorrentes.
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
     * Mensagens que chegam pela engine: persiste e publica.
     *
     * O handler nunca deixa uma falha escapar para o gerenciador de sessão —
     * webhook com problema não pode derrubar a conexão do WhatsApp.
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

        // Eco de mensagem enviada por outro dispositivo do mesmo número não é
        // "mensagem recebida" para quem integra.
        if (event.fromMe) return

        app.metrics.messagesReceived.inc({ session: context.sessionId })

        /**
         * Ferramentas externas vêm depois da persistência e antes do webhook.
         *
         * Depois da persistência porque a mensagem precisa estar salva mesmo se
         * o Chatwoot estiver fora do ar; o dispatcher engole as próprias falhas
         * justamente para que uma delas não derrube o restante do tratamento.
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

      // Só publica quando o estado realmente avançou: ACK repetido não é evento.
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
     * Mudança de estado da sessão vira webhook. É o sinal que permite ao
     * integrador reagir a uma queda sem ficar consultando a API em laço — e o
     * `rawCode` vai junto porque a diferença entre 428 e 401 muda a reação.
     */
    app.sessions.onStatusChange(async (context, payload) => {
      if (payload.status === 'disconnected' || payload.status === 'logged_out') {
        // A causa traduzida vira rótulo: distingue queda de rede de número banido.
        app.metrics.sessionDisconnects.inc({ cause: payload.cause ?? 'desconhecida' })
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
       * Toda decisão vira linha em `risk_events`, inclusive as de liberação.
       * Guardar só o que foi bloqueado deixaria o histórico enviesado e
       * impediria comparar comportamento antes e depois de um ajuste de limite.
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

    // Expurgo do conteúdo vencido pela política de retenção da organização.
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
