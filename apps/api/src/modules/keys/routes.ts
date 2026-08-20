import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { generateApiKey } from '../../auth/api-key'
import { requireAuth } from '../../auth/plugin'
import { ROLES, roleAtLeast } from '../../auth/rbac'
import { hashToken } from '../../lib/crypto'
import { badRequest, forbidden, notFound } from '../../lib/errors'
import { ApiKeyRepository } from '../../repos/api-keys'
import { SessionRepository } from '../../repos/sessions'

const keySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  role: z.enum(ROLES),
  sessionScope: z.array(z.string()).nullable(),
  lastUsedAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
  createdAt: z.date(),
})

export async function apiKeyRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  route.get(
    '/v1/keys',
    {
      preHandler: app.requirePermission('apikey:read'),
      schema: {
        tags: ['api keys'],
        summary: 'List keys',
        description: 'The secret is never returned — only the public prefix.',
        response: { 200: z.object({ keys: z.array(keySchema) }) },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const keys = await new ApiKeyRepository(app.db, auth.orgId).list()
      return { keys }
    },
  )

  route.post(
    '/v1/keys',
    {
      preHandler: app.requirePermission('apikey:write'),
      schema: {
        tags: ['api keys'],
        summary: 'Create key',
        description:
          'The full token appears only once in this response. Save it: the server keeps only the hash.',
        body: z.object({
          name: z.string().min(2).max(120),
          role: z.enum(ROLES).default('operator'),
          sessionScope: z
            .array(z.string().uuid())
            .nullish()
            .describe(
              'Restricts the key to these sessions. Omit it for the key to cover the whole organization — the UUID this form suggests is only a format example, not a real id.',
            ),
          expiresInDays: z.number().int().positive().max(3650).nullish(),
        }),
        response: {
          201: z.object({
            key: keySchema,
            token: z.string().describe('Shown only in this response.'),
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const { name, role, sessionScope, expiresInDays } = request.body

      /**
       * Nobody issues a key more powerful than their own role — otherwise an
       * admin would forge an owner key and escalate on their own.
       */
      if (!roleAtLeast(auth.role, role)) {
        throw forbidden(`You cannot issue a key with a role above your own (${auth.role}).`)
      }

      /**
       * The scope has to point at a session that exists in this organization.
       *
       * Without this check you can issue a key that reaches nothing, and the
       * failure only shows up on the first send — as a 404 saying "session not
       * found", which blames the session instead of the key and sends the
       * operator looking in the wrong place. The real case was someone using
       * the "Try it" in the documentation and leaving the example UUID the
       * form suggests in the field.
       *
       * Checking here leaks nothing: these are the sessions of the very
       * organization of whoever is issuing the key.
       */
      if (sessionScope) {
        if (sessionScope.length === 0) {
          throw badRequest(
            'Empty scope reaches no session. Omit `sessionScope` for the key to cover the whole organization.',
          )
        }

        const existentes = await new SessionRepository(app.db, auth.orgId).list(sessionScope)
        const conhecidas = new Set(existentes.map((session) => session.id))
        const ausentes = sessionScope.filter((id) => !conhecidas.has(id))

        if (ausentes.length > 0) {
          throw badRequest(
            `Scope points to a session that does not exist in this organization: ${ausentes.join(', ')}.`,
          )
        }
      }

      const generated = generateApiKey()
      const key = await new ApiKeyRepository(app.db, auth.orgId).create({
        name,
        role,
        prefix: generated.prefix,
        secretHash: hashToken(generated.secret),
        sessionScope: sessionScope ?? null,
        expiresAt: expiresInDays
          ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
          : null,
        createdByUserId: auth.userId,
      })

      return reply.code(201).send({ key, token: generated.token })
    },
  )

  route.delete(
    '/v1/keys/:id',
    {
      preHandler: app.requirePermission('apikey:write'),
      schema: {
        tags: ['api keys'],
        summary: 'Revoke key',
        description: 'Revocation takes effect immediately — the next request using it gets 401.',
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const revoked = await new ApiKeyRepository(app.db, auth.orgId).revoke(request.params.id)
      if (!revoked) throw notFound('Key not found or already revoked.')
      return reply.code(204).send(null)
    },
  )
}
