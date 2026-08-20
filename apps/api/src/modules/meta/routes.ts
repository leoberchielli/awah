import { createHmac, timingSafeEqual } from 'node:crypto'
import { eq, schema } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { mapStatus } from '../../engines/baileys/mapping'
import { loadCloudApiCredentials } from '../../engines/cloud-api/credentials'
import { forbidden, notFound } from '../../lib/errors'
import { recordMessage, recordStatus } from '../../messaging/persistence'
import { emitWebhook } from '../../webhooks/emit'

/**
 * Meta's callback.
 *
 * Unlike Baileys, the official engine keeps no stream: messages arrive as a
 * POST from Meta on this endpoint. It is necessarily public — the caller is
 * their infrastructure, without our API key — and so the authentication is the
 * signature of the body, not a bearer.
 */
export async function metaRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  const encryptionKey = Buffer.from(app.env.ENCRYPTION_KEY, 'base64')

  /**
   * Verification handshake.
   *
   * Meta calls once when the webhook is configured and expects the
   * `hub.challenge` back, but only if the `hub.verify_token` matches what the
   * owner registered. It is what stops someone from pointing another account's
   * webhook at this instance.
   */
  route.get(
    '/webhooks/meta/:sessionId',
    {
      schema: {
        tags: ['system'],
        summary: 'Meta webhook verification',
        hide: true,
        params: z.object({ sessionId: z.string().uuid() }),
        querystring: z.object({
          'hub.mode': z.string().optional(),
          'hub.verify_token': z.string().optional(),
          'hub.challenge': z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const credenciais = await loadCloudApiCredentials(
        app.db,
        request.params.sessionId,
        encryptionKey,
      ).catch(() => null)

      if (!credenciais) throw notFound('Session not found or without credentials.')

      const query = request.query
      if (
        query['hub.mode'] !== 'subscribe' ||
        query['hub.verify_token'] !== credenciais.verifyToken
      ) {
        throw forbidden('Invalid verification token.')
      }

      return reply.type('text/plain').send(query['hub.challenge'] ?? '')
    },
  )

  /**
   * Event intake.
   *
   * Answers 200 whenever the signature checks out, even if the processing
   * fails: Meta redelivers on error, and a 500 here would turn into a storm of
   * redeliveries exactly when something is already broken. The processing
   * stays off the response path.
   */
  route.post(
    '/webhooks/meta/:sessionId',
    {
      schema: {
        tags: ['system'],
        summary: 'Cloud API events',
        hide: true,
        params: z.object({ sessionId: z.string().uuid() }),
      },
    },
    async (request, reply) => {
      const { sessionId } = request.params

      const [session] = await app.db
        .select({ id: schema.sessions.id, orgId: schema.sessions.orgId })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1)

      if (!session) throw notFound('Session not found.')

      const credenciais = await loadCloudApiCredentials(app.db, sessionId, encryptionKey).catch(
        () => null,
      )
      if (!credenciais) throw notFound('Session without configured credentials.')

      /**
       * The **raw** body, not the reserialized one.
       *
       * `JSON.stringify(request.body)` produces similar bytes, not identical
       * ones: key order, escapes and spacing can differ from what Meta signed,
       * and the HMAC would fail intermittently and inexplicably. The parser in
       * `app.ts` keeps the original buffer for this use.
       */
      const body = request.rawBody
      if (!body) {
        throw forbidden('Raw body unavailable to check the signature.')
      }

      if (!verifySignature(body, credenciais.appSecret, request.headers['x-hub-signature-256'])) {
        throw forbidden('Invalid event signature.')
      }

      // Answer first, process after. Our error must not become a Meta redelivery.
      void processarEvento(app, session.orgId, sessionId, request.body).catch((error) => {
        app.log.error({ err: error, sessionId }, 'failed to process Meta event')
      })

      return reply.send({ received: true })
    },
  )
}

function verifySignature(
  body: Buffer,
  appSecret: string,
  signature: string | string[] | undefined,
): boolean {
  const recebida = Array.isArray(signature) ? signature[0] : signature
  if (!recebida) return false

  const expected = `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`
  const a = Buffer.from(expected)
  const b = Buffer.from(recebida)

  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

interface MetaEnvelope {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string
          from?: string
          timestamp?: string
          type?: string
          text?: { body?: string }
          image?: { caption?: string }
          video?: { caption?: string }
          document?: { filename?: string }
        }>
        statuses?: Array<{
          id?: string
          status?: string
          timestamp?: string
          recipient_id?: string
        }>
      }
    }>
  }>
}

/** Cloud API states mapped onto the same ones the rest of the system uses. */
const STATUS_META: Record<string, number> = {
  sent: 2,
  delivered: 3,
  read: 4,
}

async function processarEvento(
  app: FastifyInstance,
  orgId: string,
  sessionId: string,
  payload: unknown,
): Promise<void> {
  const envelope = payload as MetaEnvelope

  for (const input of envelope?.entry ?? []) {
    for (const change of input.changes ?? []) {
      const value = change.value
      if (!value) continue

      for (const message of value.messages ?? []) {
        if (!message.id || !message.from) continue

        const conteudo =
          message.text?.body ??
          message.image?.caption ??
          message.video?.caption ??
          message.document?.filename ??
          null

        await recordMessage(app.db, app.retention, {
          orgId,
          sessionId,
          chatId: message.from,
          engineMessageId: message.id,
          direction: 'inbound',
          type: traduzirTipo(message.type),
          body: conteudo,
          fromJid: message.from,
          status: 'delivered',
          occurredAt: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date(),
        })

        app.metrics.messagesReceived.inc({ session: sessionId })

        await emitWebhook(app.db, {
          orgId,
          sessionId,
          event: 'message.received',
          data: {
            sessionId,
            messageId: message.id,
            chatId: message.from,
            from: message.from,
            type: traduzirTipo(message.type),
            body: conteudo,
            timestamp: new Date().toISOString(),
          },
        })
      }

      for (const status of value.statuses ?? []) {
        if (!status.id || !status.status) continue

        const mapped = mapStatus(STATUS_META[status.status])
        if (!mapped) continue

        const avancou = await recordStatus(app.db, {
          orgId,
          sessionId,
          engineMessageId: status.id,
          status: mapped,
          occurredAt: status.timestamp ? new Date(Number(status.timestamp) * 1000) : new Date(),
        })

        if (!avancou) continue

        await emitWebhook(app.db, {
          orgId,
          sessionId,
          event: 'message.status',
          data: {
            sessionId,
            messageId: status.id,
            chatId: status.recipient_id ?? '',
            status: mapped,
            timestamp: new Date().toISOString(),
          },
        })
      }
    }
  }
}

function traduzirTipo(tipo: string | undefined) {
  switch (tipo) {
    case 'text':
      return 'text' as const
    case 'image':
      return 'image' as const
    case 'video':
      return 'video' as const
    case 'audio':
      return 'audio' as const
    case 'document':
      return 'document' as const
    case 'sticker':
      return 'sticker' as const
    case 'location':
      return 'location' as const
    case 'contacts':
      return 'contact' as const
    case 'reaction':
      return 'reaction' as const
    default:
      return 'system' as const
  }
}
