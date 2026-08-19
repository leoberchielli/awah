import { and, desc, eq, schema } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../../auth/plugin'
import { randomToken } from '../../lib/crypto'
import { notFound } from '../../lib/errors'
import { replayDeadDeliveries, WEBHOOK_EVENTS } from '../../webhooks/emit'

const webhookSchema = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  sessionScope: z.array(z.string()).nullable(),
  active: z.boolean(),
  createdAt: z.date(),
})

const eventField = z.enum([...WEBHOOK_EVENTS, '*'])

export async function webhookRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  route.get(
    '/v1/webhooks',
    {
      preHandler: app.requirePermission('webhook:read'),
      schema: {
        tags: ['webhooks'],
        summary: 'Listar assinaturas',
        description: 'O segredo de assinatura nunca é devolvido depois da criação.',
        response: { 200: z.object({ webhooks: z.array(webhookSchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const webhooks = await app.db
        .select({
          id: schema.webhooks.id,
          url: schema.webhooks.url,
          events: schema.webhooks.events,
          sessionScope: schema.webhooks.sessionScope,
          active: schema.webhooks.active,
          createdAt: schema.webhooks.createdAt,
        })
        .from(schema.webhooks)
        .where(eq(schema.webhooks.orgId, auth.orgId))
        .orderBy(desc(schema.webhooks.createdAt))

      return { webhooks }
    },
  )

  route.post(
    '/v1/webhooks',
    {
      preHandler: app.requirePermission('webhook:write'),
      schema: {
        tags: ['webhooks'],
        summary: 'Criar assinatura',
        description:
          'O segredo aparece uma única vez nesta resposta. Use-o para validar o header x-awah-signature.',
        body: z.object({
          url: z.string().url(),
          events: z.array(eventField).min(1).describe('Use "*" para receber todos.'),
          sessionScope: z.array(z.string().uuid()).nullish(),
        }),
        response: { 201: z.object({ webhook: webhookSchema, secret: z.string() }) },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const secret = randomToken(32)

      const [webhook] = await app.db
        .insert(schema.webhooks)
        .values({
          orgId: auth.orgId,
          url: request.body.url,
          secret,
          events: request.body.events,
          sessionScope: request.body.sessionScope ?? null,
        })
        .returning({
          id: schema.webhooks.id,
          url: schema.webhooks.url,
          events: schema.webhooks.events,
          sessionScope: schema.webhooks.sessionScope,
          active: schema.webhooks.active,
          createdAt: schema.webhooks.createdAt,
        })

      if (!webhook) throw new Error('falha ao criar webhook')
      return reply.code(201).send({ webhook, secret })
    },
  )

  route.patch(
    '/v1/webhooks/:id',
    {
      preHandler: app.requirePermission('webhook:write'),
      schema: {
        tags: ['webhooks'],
        summary: 'Atualizar assinatura',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          url: z.string().url().optional(),
          events: z.array(eventField).min(1).optional(),
          active: z.boolean().optional(),
          sessionScope: z.array(z.string().uuid()).nullish(),
        }),
        response: { 200: webhookSchema },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const [updated] = await app.db
        .update(schema.webhooks)
        .set({ ...request.body, updatedAt: new Date() })
        .where(
          and(eq(schema.webhooks.id, request.params.id), eq(schema.webhooks.orgId, auth.orgId)),
        )
        .returning({
          id: schema.webhooks.id,
          url: schema.webhooks.url,
          events: schema.webhooks.events,
          sessionScope: schema.webhooks.sessionScope,
          active: schema.webhooks.active,
          createdAt: schema.webhooks.createdAt,
        })

      if (!updated) throw notFound('Webhook não encontrado.')
      return updated
    },
  )

  route.delete(
    '/v1/webhooks/:id',
    {
      preHandler: app.requirePermission('webhook:write'),
      schema: {
        tags: ['webhooks'],
        summary: 'Excluir assinatura',
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const rows = await app.db
        .delete(schema.webhooks)
        .where(
          and(eq(schema.webhooks.id, request.params.id), eq(schema.webhooks.orgId, auth.orgId)),
        )
        .returning({ id: schema.webhooks.id })

      if (rows.length === 0) throw notFound('Webhook não encontrado.')
      return reply.code(204).send(null)
    },
  )

  route.get(
    '/v1/webhooks/deliveries',
    {
      preHandler: app.requirePermission('webhook:read'),
      schema: {
        tags: ['webhooks'],
        summary: 'Entregas e fila morta',
        description: 'Filtre por status=dead para ver o que esgotou as tentativas.',
        querystring: z.object({
          status: z.enum(['pending', 'delivering', 'delivered', 'retrying', 'dead']).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: {
          200: z.object({
            deliveries: z.array(
              z.object({
                id: z.string(),
                webhookId: z.string(),
                eventType: z.string(),
                status: z.string(),
                attempts: z.number(),
                responseStatus: z.number().nullable(),
                lastError: z.string().nullable(),
                createdAt: z.date(),
                deliveredAt: z.date().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const conditions = [eq(schema.webhookDeliveries.orgId, auth.orgId)]
      if (request.query.status) {
        conditions.push(eq(schema.webhookDeliveries.status, request.query.status))
      }

      const deliveries = await app.db
        .select({
          id: schema.webhookDeliveries.id,
          webhookId: schema.webhookDeliveries.webhookId,
          eventType: schema.webhookDeliveries.eventType,
          status: schema.webhookDeliveries.status,
          attempts: schema.webhookDeliveries.attempts,
          responseStatus: schema.webhookDeliveries.responseStatus,
          lastError: schema.webhookDeliveries.lastError,
          createdAt: schema.webhookDeliveries.createdAt,
          deliveredAt: schema.webhookDeliveries.deliveredAt,
        })
        .from(schema.webhookDeliveries)
        .where(and(...conditions))
        .orderBy(desc(schema.webhookDeliveries.createdAt))
        .limit(request.query.limit)

      return { deliveries }
    },
  )

  route.post(
    '/v1/webhooks/deliveries/replay',
    {
      preHandler: app.requirePermission('webhook:write'),
      schema: {
        tags: ['webhooks'],
        summary: 'Reprocessar fila morta',
        description:
          'Sem corpo, recoloca todas as entregas mortas da organização. Com ids, apenas as informadas.',
        body: z
          .object({ ids: z.array(z.string().uuid()).optional() })
          .optional()
          .default({}),
        response: { 202: z.object({ replayed: z.number() }) },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const replayed = await replayDeadDeliveries(app.db, auth.orgId, request.body?.ids)
      return reply.code(202).send({ replayed })
    },
  )
}
