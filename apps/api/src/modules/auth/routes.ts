import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { hashPassword, verifyPassword } from '../../auth/password'
import { requireAuth, SESSION_COOKIE } from '../../auth/plugin'
import { hashToken, randomToken } from '../../lib/crypto'
import { conflict, forbidden, unauthorized } from '../../lib/errors'
import { slugify } from '../../lib/slug'
import { IdentityRepository, normalizeEmail } from '../../repos/identity'

const emailField = z.string().email().max(254)
const passwordField = z
  .string()
  .min(12, 'use pelo menos 12 caracteres')
  .max(200, 'senha longa demais')

export async function authRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()
  const identity = new IdentityRepository(app.db)

  const sessionTtlMs = app.env.SESSION_TTL_HOURS * 60 * 60 * 1000

  function issueSession(reply: FastifyReply, token: string) {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: app.env.NODE_ENV === 'production',
      signed: true,
      path: '/',
      maxAge: Math.floor(sessionTtlMs / 1000),
    })
  }

  /**
   * Bootstrap da instância: cria a primeira organização e o seu owner.
   *
   * Fecha sozinho assim que existir qualquer organização — mesmo com
   * ALLOW_OPEN_REGISTRATION ligado. Uma instância exposta na internet com
   * registro aberto permanente é uma porta de entrada, não uma conveniência.
   * Depois do bootstrap, novos usuários entram por convite (POST /v1/org/members).
   */
  route.post(
    '/v1/auth/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: {
        tags: ['autenticação'],
        summary: 'Criar a primeira organização',
        description:
          'Disponível apenas enquanto a instância não tiver nenhuma organização. Cria a org, o usuário e a membership de owner.',
        body: z.object({
          organizationName: z.string().min(2).max(120),
          name: z.string().min(2).max(120),
          email: emailField,
          password: passwordField,
        }),
        response: {
          201: z.object({
            organization: z.object({ id: z.string(), slug: z.string() }),
            user: z.object({ id: z.string(), email: z.string() }),
          }),
        },
      },
    },
    async (request, reply) => {
      if (!app.env.ALLOW_OPEN_REGISTRATION) {
        throw forbidden('Registro aberto está desligado nesta instância.')
      }

      if ((await identity.organizationCount()) > 0) {
        throw forbidden('Esta instância já foi inicializada. Peça um convite a um administrador.')
      }

      const { organizationName, name, email, password } = request.body
      const slug = slugify(organizationName)

      if (await identity.findUserByEmail(email)) {
        throw conflict('Já existe um usuário com este e-mail.')
      }

      const created = await identity.createOrgWithOwner({
        orgName: organizationName,
        orgSlug: slug,
        userName: name,
        email,
        passwordHash: await hashPassword(password),
      })

      const token = randomToken()
      await identity.createSession({
        userId: created.userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + sessionTtlMs),
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      })
      issueSession(reply, token)

      return reply.code(201).send({
        organization: { id: created.orgId, slug },
        user: { id: created.userId, email: normalizeEmail(email) },
      })
    },
  )

  route.post(
    '/v1/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
      schema: {
        tags: ['autenticação'],
        summary: 'Entrar',
        body: z.object({ email: emailField, password: z.string().min(1).max(200) }),
        response: {
          200: z.object({
            user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
            organizations: z.array(
              z.object({ id: z.string(), slug: z.string(), name: z.string(), role: z.string() }),
            ),
          }),
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body
      const user = await identity.findUserByEmail(email)

      /**
       * Verifica a senha mesmo quando o usuário não existe, contra um hash
       * descartável. Sem isso, a diferença de tempo entre "e-mail inexistente" e
       * "senha errada" vira um oráculo de enumeração de contas.
       */
      const digest = user?.passwordHash ?? (await decoyHash())
      const ok = await verifyPassword(digest, password)

      if (!user || !ok) {
        throw unauthorized('E-mail ou senha incorretos.')
      }

      const token = randomToken()
      await identity.createSession({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + sessionTtlMs),
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      })
      await identity.recordLogin(user.id)
      issueSession(reply, token)

      const memberships = await identity.listMemberships(user.id)

      return reply.send({
        user: { id: user.id, email: user.email, name: user.name },
        organizations: memberships.map((m) => ({
          id: m.orgId,
          slug: m.orgSlug,
          name: m.orgName,
          role: m.role,
        })),
      })
    },
  )

  route.post(
    '/v1/auth/logout',
    {
      schema: {
        tags: ['autenticação'],
        summary: 'Sair',
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const cookie = request.cookies[SESSION_COOKIE]
      if (cookie) {
        const unsigned = request.unsignCookie(cookie)
        if (unsigned.valid && unsigned.value) {
          await identity.deleteSession(hashToken(unsigned.value))
        }
      }
      reply.clearCookie(SESSION_COOKIE, { path: '/' })
      return reply.code(204).send(null)
    },
  )

  route.get(
    '/v1/auth/me',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['autenticação'],
        summary: 'Contexto da credencial atual',
        response: {
          200: z.object({
            kind: z.enum(['user', 'api_key']),
            organizationId: z.string(),
            role: z.string(),
            userId: z.string().nullable(),
            apiKeyId: z.string().nullable(),
            sessionScope: z.array(z.string()).nullable(),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      return {
        kind: auth.kind,
        organizationId: auth.orgId,
        role: auth.role,
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        sessionScope: auth.sessionScope,
      }
    },
  )
}

/**
 * Hash-isca sobre uma senha aleatória, calculado sob demanda e reaproveitado.
 *
 * Precisa ser gerado pelo mesmo argon2 com os mesmos parâmetros — um literal
 * escrito à mão não serve: se o digest for inválido, `verifyPassword` cai no
 * catch e retorna cedo, que é exatamente a diferença de tempo que este código
 * existe para eliminar.
 */
let decoyHashPromise: Promise<string> | null = null
function decoyHash(): Promise<string> {
  decoyHashPromise ??= hashPassword(randomToken(16))
  return decoyHashPromise
}
