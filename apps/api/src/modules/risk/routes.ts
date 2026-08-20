import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../../auth/plugin'
import { notFound } from '../../lib/errors'
import { RiskRepository } from '../../repos/risk'
import { SessionRepository } from '../../repos/sessions'
import { DEFAULT_LIMITS } from '../../risk/limits'

export async function riskRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  route.get(
    '/v1/sessions/:id/risk',
    {
      preHandler: app.requirePermission('metrics:read'),
      schema: {
        tags: ['risk'],
        summary: 'Session score and budget',
        description:
          'Score 0–100 with the contribution of each signal, window consumption, and the limits in effect after warm-up.',
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            score: z.object({
              value: z.number(),
              factors: z.array(
                z.object({
                  name: z.string(),
                  points: z.number(),
                  max: z.number(),
                  detail: z.string(),
                }),
              ),
            }),
            usage: z.object({
              minute: z.number(),
              hour: z.number(),
              day: z.number(),
              newContactsToday: z.number(),
            }),
            limits: z
              .object({
                perMinute: z.number(),
                perHour: z.number(),
                perDay: z.number(),
                newContactsPerDay: z.number(),
              })
              .describe('Already reduced by the warm-up curve.'),
            baseLimits: z.object({
              perMinute: z.number(),
              perHour: z.number(),
              perDay: z.number(),
              newContactsPerDay: z.number(),
            }),
            warmup: z.object({
              ageInDays: z.number(),
              factor: z.number().describe('Fraction of the limits released by the session age.'),
            }),
            throttleFactor: z.number().describe('1 = normal pace; below that, the brake is on.'),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      if (auth.sessionScope && !auth.sessionScope.includes(request.params.id)) {
        throw notFound('Session not found.')
      }

      const session = await new SessionRepository(app.db, auth.orgId).findById(request.params.id)
      if (!session) throw notFound('Session not found.')

      const snapshot = await app.risk.snapshot(request.params.id)
      if (!snapshot) throw notFound('Session not found.')

      return {
        score: snapshot.score,
        usage: snapshot.usage,
        limits: snapshot.limits,
        baseLimits: snapshot.baseLimits,
        warmup: {
          ageInDays: Number(snapshot.ageInDays.toFixed(2)),
          factor: Number(snapshot.warmupFactor.toFixed(3)),
        },
        throttleFactor: snapshot.throttleFactor,
      }
    },
  )

  route.put(
    '/v1/sessions/:id/risk/limits',
    {
      preHandler: app.requirePermission('session:write'),
      schema: {
        tags: ['risk'],
        summary: 'Adjust session limits',
        description:
          'Sets the ceilings before warm-up. The warm-up curve still applies on top of these values — a new session does not send at the ceiling on day one, however high it is.',
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          perMinute: z.number().int().min(1).max(600).optional(),
          perHour: z.number().int().min(1).max(20_000).optional(),
          perDay: z.number().int().min(1).max(200_000).optional(),
          newContactsPerDay: z.number().int().min(1).max(50_000).optional(),
        }),
        response: {
          200: z.object({
            perMinute: z.number(),
            perHour: z.number(),
            perDay: z.number(),
            newContactsPerDay: z.number(),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const repo = new SessionRepository(app.db, auth.orgId)

      const session = await repo.findById(request.params.id)
      if (!session) throw notFound('Session not found.')

      const atuais = await app.risk.snapshot(request.params.id)
      const limits = {
        ...(atuais?.baseLimits ?? DEFAULT_LIMITS),
        ...request.body,
      }

      await repo.updateConfig(request.params.id, { limits: limits })
      return limits
    },
  )

  route.get(
    '/v1/risk/events',
    {
      preHandler: app.requirePermission('metrics:read'),
      schema: {
        tags: ['risk'],
        summary: 'Decision history',
        description:
          'Every risk engine evaluation, with a snapshot of the budget at the moment of the decision. Answers why a specific send was delayed.',
        querystring: z.object({
          sessionId: z.string().uuid().optional(),
          action: z.enum(['allowed', 'delayed', 'held', 'throttled', 'blocked']).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: {
          200: z.object({
            events: z.array(
              z.object({
                id: z.string(),
                sessionId: z.string(),
                outboxId: z.string().nullable(),
                action: z.string(),
                score: z.number(),
                reason: z.string(),
                delayMs: z.number().nullable(),
                budget: z.unknown(),
                createdAt: z.date(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const events = await new RiskRepository(app.db, auth.orgId).list(request.query)
      return { events }
    },
  )
}
