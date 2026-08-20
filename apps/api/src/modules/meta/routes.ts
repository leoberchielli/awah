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

      const [sessao] = await app.db
        .select({ id: schema.sessions.id, orgId: schema.sessions.orgId })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId))
        .limit(1)

      if (!sessao) throw notFound('Session not found.')

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
      const corpo = request.rawBody
      if (!corpo) {
        throw forbidden('Raw body unavailable to check the signature.')
      }

      if (
        !verificarAssinatura(corpo, credenciais.appSecret, request.headers['x-hub-signature-256'])
      ) {
        throw forbidden('Invalid event signature.')
      }

      // Answer first, process after. Our error must not become a Meta redelivery.
      void processarEvento(app, sessao.orgId, sessionId, request.body).catch((error) => {
        app.log.error({ err: error, sessionId }, 'failed to process Meta event')
      })

      return reply.send({ received: true })
    },
  )
}

function verificarAssinatura(
  corpo: Buffer,
  appSecret: string,
  assinatura: string | string[] | undefined,
): boolean {
  const recebida = Array.isArray(assinatura) ? assinatura[0] : assinatura
  if (!recebida) return false

  const esperada = `sha256=${createHmac('sha256', appSecret).update(corpo).digest('hex')}`
  const a = Buffer.from(esperada)
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

  for (const entrada of envelope?.entry ?? []) {
    for (const mudanca of entrada.changes ?? []) {
      const valor = mudanca.value
      if (!valor) continue

      for (const mensagem of valor.messages ?? []) {
        if (!mensagem.id || !mensagem.from) continue

        const conteudo =
          mensagem.text?.body ??
          mensagem.image?.caption ??
          mensagem.video?.caption ??
          mensagem.document?.filename ??
          null

        await recordMessage(app.db, app.retention, {
          orgId,
          sessionId,
          chatId: mensagem.from,
          engineMessageId: mensagem.id,
          direction: 'inbound',
          type: traduzirTipo(mensagem.type),
          body: conteudo,
          fromJid: mensagem.from,
          status: 'delivered',
          occurredAt: mensagem.timestamp ? new Date(Number(mensagem.timestamp) * 1000) : new Date(),
        })

        app.metrics.messagesReceived.inc({ session: sessionId })

        await emitWebhook(app.db, {
          orgId,
          sessionId,
          event: 'message.received',
          data: {
            sessionId,
            messageId: mensagem.id,
            chatId: mensagem.from,
            from: mensagem.from,
            type: traduzirTipo(mensagem.type),
            body: conteudo,
            timestamp: new Date().toISOString(),
          },
        })
      }

      for (const status of valor.statuses ?? []) {
        if (!status.id || !status.status) continue

        const mapeado = mapStatus(STATUS_META[status.status])
        if (!mapeado) continue

        const avancou = await recordStatus(app.db, {
          orgId,
          sessionId,
          engineMessageId: status.id,
          status: mapeado,
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
            status: mapeado,
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
