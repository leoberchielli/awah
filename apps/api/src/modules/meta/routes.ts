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
 * Callback da Meta.
 *
 * Diferente do Baileys, a engine oficial não mantém stream: as mensagens chegam
 * como POST da Meta neste endpoint. Ele é necessariamente público — quem chama
 * é a infraestrutura deles, sem a nossa chave de API — e por isso a
 * autenticação é a assinatura do corpo, não um bearer.
 */
export async function metaRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  const encryptionKey = Buffer.from(app.env.ENCRYPTION_KEY, 'base64')

  /**
   * Handshake de verificação.
   *
   * A Meta chama uma vez ao configurar o webhook e espera receber de volta o
   * `hub.challenge`, mas só se o `hub.verify_token` bater com o que o dono
   * cadastrou. É o que impede alguém de apontar o webhook de outra conta para
   * esta instância.
   */
  route.get(
    '/webhooks/meta/:sessionId',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Verificação do webhook da Meta',
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

      if (!credenciais) throw notFound('Sessão não encontrada ou sem credenciais.')

      const query = request.query
      if (
        query['hub.mode'] !== 'subscribe' ||
        query['hub.verify_token'] !== credenciais.verifyToken
      ) {
        throw forbidden('Token de verificação inválido.')
      }

      return reply.type('text/plain').send(query['hub.challenge'] ?? '')
    },
  )

  /**
   * Recebimento de eventos.
   *
   * Responde 200 sempre que a assinatura confere, mesmo se o processamento
   * falhar: a Meta reentrega em caso de erro, e um 500 aqui viraria uma
   * tempestade de reentregas justamente quando algo já está quebrado. O
   * processamento fica fora do caminho da resposta.
   */
  route.post(
    '/webhooks/meta/:sessionId',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Eventos da Cloud API',
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

      if (!sessao) throw notFound('Sessão não encontrada.')

      const credenciais = await loadCloudApiCredentials(app.db, sessionId, encryptionKey).catch(
        () => null,
      )
      if (!credenciais) throw notFound('Sessão sem credenciais configuradas.')

      /**
       * O corpo **cru**, não o reserializado.
       *
       * `JSON.stringify(request.body)` produz bytes parecidos, não idênticos:
       * ordem de chaves, escapes e espaçamento podem diferir do que a Meta
       * assinou, e o HMAC falharia de forma intermitente e inexplicável. O
       * parser em `app.ts` guarda o buffer original para este uso.
       */
      const corpo = request.rawBody
      if (!corpo) {
        throw forbidden('Corpo cru indisponível para conferir a assinatura.')
      }

      if (
        !verificarAssinatura(corpo, credenciais.appSecret, request.headers['x-hub-signature-256'])
      ) {
        throw forbidden('Assinatura do evento inválida.')
      }

      // Responde primeiro; processa depois. Erro nosso não vira reentrega da Meta.
      void processarEvento(app, sessao.orgId, sessionId, request.body).catch((error) => {
        app.log.error({ err: error, sessionId }, 'falha ao processar evento da Meta')
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

/** Estados da Cloud API mapeados para os mesmos do restante do sistema. */
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
