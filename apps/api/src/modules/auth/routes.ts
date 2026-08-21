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
const passwordField = z.string().min(12, 'use at least 12 characters').max(200, 'password too long')

/**
 * What a public demo says about itself.
 *
 * It is nullable rather than absent so a client can branch on one field instead
 * of on the shape of the response — and so the panel's demo banner is a
 * property of the API's answer, not a build-time flag someone can forget to
 * flip.
 */
const demoSchema = z
  .object({
    email: z.string(),
    password: z.string(),
    apiKey: z.string(),
    orgSlug: z.string(),
    resetMinutes: z.number().describe('How often the demo returns to its baseline. 0 is never.'),
  })
  .nullable()

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
   * Whether the instance still needs to be initialized.
   *
   * Public on purpose, and it leaks nothing: anyone who reaches the port would
   * find out the same by trying to register. It exists so the panel can show
   * the first-run screen instead of a login form nobody can use yet — the
   * alternative was the user reading the README and putting together a curl.
   */
  route.get(
    '/v1/auth/bootstrap',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['authentication'],
        summary: 'Has the instance been initialized?',
        response: {
          200: z.object({
            needsSetup: z.boolean().describe('true while no organization exists.'),
            openRegistration: z.boolean().describe('false when ALLOW_OPEN_REGISTRATION is off.'),
            /**
             * Present only on a public demo, and it carries the password.
             *
             * That is not a leak: the credentials are printed on the login
             * screen and in the README, because a demo whose password has to be
             * asked for is not a demo. Anywhere else this field is null.
             */
            demo: demoSchema,
          }),
        },
      },
    },
    async () => ({
      needsSetup: (await identity.organizationCount()) === 0,
      openRegistration: app.env.ALLOW_OPEN_REGISTRATION,
      demo: app.demo,
    }),
  )

  /**
   * Instance bootstrap: creates the first organization and its owner.
   *
   * It closes itself as soon as any organization exists — even with
   * ALLOW_OPEN_REGISTRATION on. An instance exposed to the internet with
   * permanently open registration is a way in, not a convenience. After the
   * bootstrap, new users arrive by invite (POST /v1/org/members).
   */
  route.post(
    '/v1/auth/register',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
      schema: {
        tags: ['authentication'],
        summary: 'Create the first organization',
        description:
          'Available only while the instance has no organization. Creates the org, the user, and the owner membership.',
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
        throw forbidden('Open registration is off on this instance.')
      }

      if ((await identity.organizationCount()) > 0) {
        throw forbidden('This instance is already initialized. Ask an administrator for an invite.')
      }

      const { organizationName, name, email, password } = request.body
      const slug = slugify(organizationName)

      if (await identity.findUserByEmail(email)) {
        throw conflict('A user with this email already exists.')
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
        tags: ['authentication'],
        summary: 'Sign in',
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
       * Verifies the password even when the user does not exist, against a
       * throwaway hash. Without this, the time difference between "no such
       * email" and "wrong password" becomes an account-enumeration oracle.
       */
      const digest = user?.passwordHash ?? (await decoyHash())
      const ok = await verifyPassword(digest, password)

      if (!user || !ok) {
        throw unauthorized('Incorrect email or password.')
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
        tags: ['authentication'],
        summary: 'Sign out',
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
        tags: ['authentication'],
        summary: 'Current credential context',
        response: {
          200: z.object({
            kind: z.enum(['user', 'api_key']),
            organizationId: z.string(),
            role: z.string(),
            userId: z.string().nullable(),
            apiKeyId: z.string().nullable(),
            sessionScope: z.array(z.string()).nullable(),
            /** Repeated from the bootstrap so a signed-in panel can say so too. */
            demo: demoSchema,
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
        demo: app.demo,
      }
    },
  )
}

/**
 * A decoy hash over a random password, computed on demand and reused.
 *
 * It has to come from the same argon2 with the same parameters — a literal
 * written by hand will not do: if the digest is invalid, `verifyPassword` falls
 * into the catch and returns early, which is exactly the timing difference this
 * code exists to eliminate.
 */
let decoyHashPromise: Promise<string> | null = null
function decoyHash(): Promise<string> {
  decoyHashPromise ??= hashPassword(randomToken(16))
  return decoyHashPromise
}
