import { sql } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

const startedAt = Date.now()

export async function healthRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  /** Liveness: só afirma que o processo responde. Nunca toca dependência. */
  route.get(
    '/health',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Liveness',
        description: 'Responde enquanto o processo estiver vivo. Não consulta dependências.',
        response: {
          200: z.object({
            status: z.literal('ok'),
            nodeId: z.string(),
            uptimeSeconds: z.number(),
          }),
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      nodeId: app.env.NODE_ID,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  )

  /**
   * Readiness: só devolve 200 quando Postgres e Redis respondem. É esta rota que
   * o orquestrador deve consultar antes de mandar tráfego para a réplica.
   */
  route.get(
    '/health/ready',
    {
      schema: {
        tags: ['sistema'],
        summary: 'Readiness',
        description: 'Verifica Postgres e Redis. Devolve 503 se alguma dependência falhar.',
        response: {
          200: z.object({
            status: z.literal('ready'),
            checks: z.object({ database: z.boolean(), redis: z.boolean() }),
          }),
          503: z.object({
            status: z.literal('degraded'),
            checks: z.object({ database: z.boolean(), redis: z.boolean() }),
          }),
        },
      },
    },
    async (_request, reply) => {
      const [database, redis] = await Promise.all([
        app.db
          .execute(sql`select 1`)
          .then(() => true)
          .catch(() => false),
        app.redis
          .ping()
          .then(() => true)
          .catch(() => false),
      ])

      const checks = { database, redis }
      if (database && redis) {
        return reply.send({ status: 'ready' as const, checks })
      }
      return reply.code(503).send({ status: 'degraded' as const, checks })
    },
  )
}
