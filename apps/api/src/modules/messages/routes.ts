import { randomUUID } from 'node:crypto'
import { and, desc, eq, schema } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../../auth/plugin'
import { badRequest, notFound } from '../../lib/errors'
import { OutboxRepository } from '../../repos/outbox'
import { SessionRepository } from '../../repos/sessions'

const outboxSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  chatId: z.string(),
  clientMessageId: z.string(),
  type: z.string(),
  status: z.enum(['queued', 'held', 'sending', 'sent', 'failed', 'dead']),
  attempts: z.number(),
  maxAttempts: z.number(),
  availableAt: z.date(),
  heldReason: z.string().nullable(),
  lastError: z.string().nullable(),
  engineMessageId: z.string().nullable(),
  createdAt: z.date(),
  sentAt: z.date().nullable(),
})

/**
 * `chatId` aceito nas duas formas: o JID completo do protocolo ou só o número.
 * Quem integra raramente tem o JID em mãos.
 */
function normalizeChatId(input: string): string {
  const trimmed = input.trim()
  if (trimmed.includes('@')) return trimmed

  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 8) {
    throw badRequest(
      'chatId inválido. Use o número com código do país (5511999999999) ou o JID completo.',
    )
  }
  return `${digits}@s.whatsapp.net`
}

export async function messageRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  /**
   * Enfileira um envio. Responde 202, não 200.
   *
   * O código diz o que aconteceu de fato: a mensagem foi aceita e persistida,
   * ainda não entregue. Prometer entrega numa resposta síncrona seria mentira —
   * o WhatsApp pode estar fora do ar, a sessão pode ter caído, e a partir da
   * onda 3 o motor de risco pode segurar o envio de propósito. O estado real
   * vive em `GET /v1/outbox/:id` e nos webhooks.
   */
  route.post(
    '/v1/sessions/:id/messages',
    {
      preHandler: app.requirePermission('message:send'),
      schema: {
        tags: ['mensagens'],
        summary: 'Enfileirar envio de texto',
        description:
          'Persiste no outbox e devolve imediatamente. A entrega é feita pelo scheduler, respeitando a ordem por conversa.',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          chatId: z.string().min(8).describe('Número com código do país ou JID completo.'),
          text: z.string().min(1).max(65536),
          clientMessageId: z
            .string()
            .min(8)
            .max(128)
            .optional()
            .describe('Chave de idempotência. Reenviar o mesmo valor não duplica o envio.'),
        }),
        response: {
          202: z.object({
            outboxId: z.string(),
            clientMessageId: z.string(),
            status: z.string(),
            duplicate: z
              .boolean()
              .describe('true quando o clientMessageId já existia e nada foi enfileirado de novo.'),
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const sessionId = request.params.id

      if (auth.sessionScope && !auth.sessionScope.includes(sessionId)) {
        throw notFound('Sessão não encontrada.')
      }

      const session = await new SessionRepository(app.db, auth.orgId).findById(sessionId)
      if (!session) throw notFound('Sessão não encontrada.')

      /**
       * Override do motor de risco. Fica no payload, não numa coluna, porque é
       * atributo do envio e não da fila — e vai gravado em `risk_events` como
       * qualquer outra decisão, para que o uso do bypass seja auditável.
       */
      const bypassRisk = request.headers['x-awah-bypass-risk'] === 'true'

      const { row, created } = await new OutboxRepository(app.db, auth.orgId).enqueue({
        sessionId,
        chatId: normalizeChatId(request.body.chatId),
        clientMessageId: request.body.clientMessageId ?? randomUUID(),
        type: 'text',
        payload: bypassRisk
          ? { text: request.body.text, bypassRisk: true }
          : { text: request.body.text },
        maxAttempts: app.env.OUTBOX_MAX_ATTEMPTS,
      })

      return reply.code(202).send({
        outboxId: row.id,
        clientMessageId: row.clientMessageId,
        status: row.status,
        duplicate: !created,
      })
    },
  )

  route.get(
    '/v1/outbox',
    {
      preHandler: app.requirePermission('message:read'),
      schema: {
        tags: ['mensagens'],
        summary: 'Fila de envio',
        description: 'Inclui a DLQ — filtre por status=dead para ver o que esgotou as tentativas.',
        querystring: z.object({
          sessionId: z.string().uuid().optional(),
          status: z.enum(['queued', 'held', 'sending', 'sent', 'failed', 'dead']).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: { 200: z.object({ items: z.array(outboxSchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const items = await new OutboxRepository(app.db, auth.orgId).list(request.query)
      return { items }
    },
  )

  route.get(
    '/v1/outbox/:id',
    {
      preHandler: app.requirePermission('message:read'),
      schema: {
        tags: ['mensagens'],
        summary: 'Estado de um envio',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: outboxSchema },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const row = await new OutboxRepository(app.db, auth.orgId).findById(request.params.id)
      if (!row) throw notFound('Envio não encontrado.')
      return row
    },
  )

  route.post(
    '/v1/outbox/:id/retry',
    {
      preHandler: app.requirePermission('message:send'),
      schema: {
        tags: ['mensagens'],
        summary: 'Reprocessar envio morto',
        description: 'Devolve à fila um envio que esgotou as tentativas, zerando o contador.',
        params: z.object({ id: z.string().uuid() }),
        response: { 202: z.object({ outboxId: z.string(), status: z.string() }) },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const revived = await new OutboxRepository(app.db, auth.orgId).retry(request.params.id)
      if (!revived) {
        throw notFound('Envio não encontrado na fila morta.')
      }
      return reply.code(202).send({ outboxId: request.params.id, status: 'queued' })
    },
  )

  route.get(
    '/v1/messages',
    {
      preHandler: app.requirePermission('message:read'),
      schema: {
        tags: ['mensagens'],
        summary: 'Histórico de mensagens',
        description:
          'O corpo vem nulo depois que a retenção da organização expira; os metadados permanecem.',
        querystring: z.object({
          sessionId: z.string().uuid().optional(),
          chatId: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(50),
        }),
        response: {
          200: z.object({
            messages: z.array(
              z.object({
                id: z.string(),
                sessionId: z.string(),
                chatId: z.string(),
                engineMessageId: z.string(),
                direction: z.enum(['inbound', 'outbound']),
                type: z.string(),
                status: z.string(),
                body: z.string().nullable(),
                fromJid: z.string().nullable(),
                occurredAt: z.date(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const conditions = [eq(schema.messages.orgId, auth.orgId)]

      if (request.query.sessionId) {
        conditions.push(eq(schema.messages.sessionId, request.query.sessionId))
      }
      if (request.query.chatId) {
        conditions.push(eq(schema.messages.chatId, normalizeChatId(request.query.chatId)))
      }

      const messages = await app.db
        .select({
          id: schema.messages.id,
          sessionId: schema.messages.sessionId,
          chatId: schema.messages.chatId,
          engineMessageId: schema.messages.engineMessageId,
          direction: schema.messages.direction,
          type: schema.messages.type,
          status: schema.messages.status,
          body: schema.messages.body,
          fromJid: schema.messages.fromJid,
          occurredAt: schema.messages.occurredAt,
        })
        .from(schema.messages)
        .where(and(...conditions))
        .orderBy(desc(schema.messages.occurredAt))
        .limit(request.query.limit)

      return { messages }
    },
  )
}
