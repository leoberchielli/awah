import { and, desc, eq, schema } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../../auth/plugin'
import { randomToken } from '../../lib/crypto'
import { notFound } from '../../lib/errors'
import { assertPublicTarget } from '../../lib/net-guard'
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
        summary: 'List subscriptions',
        description: 'The signing secret is never returned after creation.',
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
        summary: 'Create subscription',
        description:
          'The secret appears only once, in this response. Use it to validate the x-awah-signature header.',
        body: z.object({
          url: z.string().url(),
          events: z.array(eventField).min(1).describe('Use "*" to receive all of them.'),
          sessionScope: z.array(z.string().uuid()).nullish(),
        }),
        response: { 201: z.object({ webhook: webhookSchema, secret: z.string() }) },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      await assertPublicTarget(request.body.url, {
        allowPrivate: app.env.ALLOW_PRIVATE_INTEGRATION_TARGETS,
      })
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

      if (!webhook) throw new Error('failed to create webhook')
      return reply.code(201).send({ webhook, secret })
    },
  )

  route.patch(
    '/v1/webhooks/:id',
    {
      preHandler: app.requirePermission('webhook:write'),
      schema: {
        tags: ['webhooks'],
        summary: 'Update subscription',
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
      // A subscription that starts public and is edited to point inside would
      // walk straight past a check that only ran on creation.
      if (request.body.url) {
        await assertPublicTarget(request.body.url, {
          allowPrivate: app.env.ALLOW_PRIVATE_INTEGRATION_TARGETS,
        })
      }

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

      if (!updated) throw notFound('Webhook not found.')
      return updated
    },
  )

  route.delete(
    '/v1/webhooks/:id',
    {
      preHandler: app.requirePermission('webhook:write'),
      schema: {
        tags: ['webhooks'],
        summary: 'Delete subscription',
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

      if (rows.length === 0) throw notFound('Webhook not found.')
      return reply.code(204).send(null)
    },
  )

  route.get(
    '/v1/webhooks/deliveries',
    {
      preHandler: app.requirePermission('webhook:read'),
      schema: {
        tags: ['webhooks'],
        summary: 'Deliveries and dead queue',
        description: 'Filter by status=dead to see what exhausted its attempts.',
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
        summary: 'Reprocess dead queue',
        description:
          'With no body, requeues every dead delivery in the organization. With ids, only the ones given.',
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
