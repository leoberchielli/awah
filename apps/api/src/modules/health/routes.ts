import { sql } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'

const startedAt = Date.now()

/**
 * Identidade do build, gravada na imagem.
 *
 * A primeira pergunta de qualquer suporte é "qual versão você está rodando", e
 * até agora a única resposta possível era abrir o contêiner. Vem do Dockerfile
 * via ARG; fora dele fica `dev`, que é a verdade.
 */
const VERSAO = process.env.AWAH_VERSION ?? 'dev'
const REVISAO = process.env.AWAH_REVISION ?? 'unknown'

export async function healthRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  /** Liveness: só afirma que o processo responde. Nunca toca dependência. */
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
   * Readiness: só devolve 200 quando Postgres e Redis respondem. É esta rota que
   * o orquestrador deve consultar antes de mandar tráfego para a réplica.
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
