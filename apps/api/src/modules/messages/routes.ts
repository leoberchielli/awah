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
 * `chatId` accepted in both forms: the protocol's full JID or just the number.
 * Whoever integrates rarely has the JID at hand.
 */
function normalizeChatId(input: string): string {
  const trimmed = input.trim()
  if (trimmed.includes('@')) return trimmed

  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 8) {
    throw badRequest(
      'Invalid chatId. Use the number with country code (5511999999999) or the full JID.',
    )
  }
  return `${digits}@s.whatsapp.net`
}

export async function messageRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  /**
   * Queues a send. Answers 202, not 200.
   *
   * The code says what actually happened: the message was accepted and
   * persisted, not delivered yet. Promising delivery in a synchronous response
   * would be a lie — WhatsApp may be down, the session may have dropped, and
   * from wave 3 on the risk engine may hold the send on purpose. The real state
   * lives in `GET /v1/outbox/:id` and in the webhooks.
   */
  route.post(
    '/v1/sessions/:id/messages',
    {
      preHandler: app.requirePermission('message:send'),
      schema: {
        tags: ['messages'],
        summary: 'Queue a text send',
        description:
          'Persists to the outbox and returns immediately. Delivery is handled by the scheduler, preserving per-conversation order.',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          chatId: z.string().min(8).describe('Number with country code or full JID.'),
          text: z.string().min(1).max(65536),
          clientMessageId: z
            .string()
            .min(8)
            .max(128)
            .optional()
            .describe('Idempotency key. Resending the same value does not duplicate the send.'),
        }),
        response: {
          202: z.object({
            outboxId: z.string(),
            clientMessageId: z.string(),
            status: z.string(),
            duplicate: z
              .boolean()
              .describe(
                'true when the clientMessageId already existed and nothing was queued again.',
              ),
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const sessionId = request.params.id

      if (auth.sessionScope && !auth.sessionScope.includes(sessionId)) {
        throw notFound('Session not found.')
      }

      const session = await new SessionRepository(app.db, auth.orgId).findById(sessionId)
      if (!session) throw notFound('Session not found.')

      /**
       * Risk engine override. It lives in the payload, not in a column,
       * because it is an attribute of the send and not of the queue — and it
       * gets written to `risk_events` like any other decision, so that use of
       * the bypass is auditable.
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
        tags: ['messages'],
        summary: 'Send queue',
        description: 'Includes the DLQ — filter by status=dead to see what exhausted its attempts.',
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
        tags: ['messages'],
        summary: 'Send state',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: outboxSchema },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const row = await new OutboxRepository(app.db, auth.orgId).findById(request.params.id)
      if (!row) throw notFound('Send not found.')
      return row
    },
  )

  route.post(
    '/v1/outbox/:id/retry',
    {
      preHandler: app.requirePermission('message:send'),
      schema: {
        tags: ['messages'],
        summary: 'Reprocess a dead send',
        description:
          'Returns a send that exhausted its attempts to the queue, resetting the counter.',
        params: z.object({ id: z.string().uuid() }),
        response: { 202: z.object({ outboxId: z.string(), status: z.string() }) },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const revived = await new OutboxRepository(app.db, auth.orgId).retry(request.params.id)
      if (!revived) {
        throw notFound('Send not found in the dead queue.')
      }
      return reply.code(202).send({ outboxId: request.params.id, status: 'queued' })
    },
  )

  route.get(
    '/v1/messages',
    {
      preHandler: app.requirePermission('message:read'),
      schema: {
        tags: ['messages'],
        summary: 'Message history',
        description:
          'The body comes back null after the organization retention expires; the metadata remains.',
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
