import { sql } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

const startedAt = Date.now()

/**
 * Build identity, baked into the image.
 *
 * The first question in any support case is "which version are you running",
 * and until now the only way to answer was to open the container. It comes from
 * the Dockerfile via ARG; outside it, `dev`, which is the truth.
 */
const VERSAO = process.env.AWAH_VERSION ?? 'dev'
const REVISAO = process.env.AWAH_REVISION ?? 'unknown'

export async function healthRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  /** Liveness: only claims the process answers. Never touches a dependency. */
  route.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness',
        description: 'Answers while the process is alive. Does not query dependencies.',
        response: {
          200: z.object({
            status: z.literal('ok'),
            version: z.string().describe('Image version. "dev" when running from source.'),
            revision: z.string().describe('Commit the image was built from.'),
            nodeId: z.string(),
            uptimeSeconds: z.number(),
          }),
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      version: VERSAO,
      revision: REVISAO,
      nodeId: app.env.NODE_ID,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  )

  /**
   * Readiness: only returns 200 when Postgres and Redis answer. This is the
   * route the orchestrator should ask before sending traffic to the replica.
   */
  route.get(
    '/health/ready',
    {
      schema: {
        tags: ['system'],
        summary: 'Readiness',
        description: 'Checks Postgres and Redis. Returns 503 if any dependency fails.',
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
