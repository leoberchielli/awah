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
        tags: ['chaves de API'],
        summary: 'Listar chaves',
        description: 'O segredo nunca é devolvido — só o prefixo público.',
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
        tags: ['chaves de API'],
        summary: 'Criar chave',
        description:
          'O token completo aparece uma única vez nesta resposta. Guarde-o: o servidor só retém o hash.',
        body: z.object({
          name: z.string().min(2).max(120),
          role: z.enum(ROLES).default('operator'),
          sessionScope: z
            .array(z.string().uuid())
            .nullish()
            .describe(
              'Restringe a chave a estas sessões. Omita para a chave valer em toda a organização — o UUID que este formulário sugere é só um exemplo de formato, não um id real.',
            ),
          expiresInDays: z.number().int().positive().max(3650).nullish(),
        }),
        response: {
          201: z.object({
            key: keySchema,
            token: z.string().describe('Mostrado apenas nesta resposta.'),
          }),
        },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const { name, role, sessionScope, expiresInDays } = request.body

      /**
       * Ninguém emite uma chave mais poderosa do que o próprio papel — caso
       * contrário um admin fabricaria uma chave de owner e escalaria sozinho.
       */
      if (!roleAtLeast(auth.role, role)) {
        throw forbidden(`Você não pode emitir uma chave com papel acima do seu (${auth.role}).`)
      }

      /**
       * Escopo precisa apontar para sessão que existe nesta organização.
       *
       * Sem esta conferência dá para emitir uma chave que não alcança nada, e a
       * falha só aparece no primeiro envio — como um 404 dizendo "sessão não
       * encontrada", que culpa a sessão em vez da chave e manda o operador
       * procurar no lugar errado. O caso real foi alguém usar o "Try it" da
       * documentação e deixar no campo o UUID de exemplo que o formulário
       * sugere.
       *
       * Conferir aqui não vaza nada: são as sessões da própria organização de
       * quem está emitindo a chave.
       */
      if (sessionScope) {
        if (sessionScope.length === 0) {
          throw badRequest(
            'Escopo vazio não alcança nenhuma sessão. Omita `sessionScope` para a chave valer em toda a organização.',
          )
        }

        const existentes = await new SessionRepository(app.db, auth.orgId).list(sessionScope)
        const conhecidas = new Set(existentes.map((sessao) => sessao.id))
        const ausentes = sessionScope.filter((id) => !conhecidas.has(id))

        if (ausentes.length > 0) {
          throw badRequest(
            `Escopo aponta para sessão que não existe nesta organização: ${ausentes.join(', ')}.`,
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
        tags: ['chaves de API'],
        summary: 'Revogar chave',
        description: 'A revogação vale imediatamente — a próxima requisição com ela recebe 401.',
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const auth = requireAuth(request)
      const revoked = await new ApiKeyRepository(app.db, auth.orgId).revoke(request.params.id)
      if (!revoked) throw notFound('Chave não encontrada ou já revogada.')
      return reply.code(204).send(null)
    },
  )
}
