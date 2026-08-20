import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from 'fastify'
import fp from 'fastify-plugin'
import { hashToken, safeEqual } from '../lib/crypto'
import { badRequest, forbidden, unauthorized } from '../lib/errors'
import { findApiKeyByPrefix, touchApiKey } from '../repos/api-keys'
import { IdentityRepository } from '../repos/identity'
import { bearerFrom, parseApiKey } from './api-key'
import { apiKeyCan, can, type Permission, type Role } from './rbac'

export const SESSION_COOKIE = 'awah_session'
/** Picks the organization when the user belongs to more than one. */
export const ORG_HEADER = 'x-awah-org'

export interface AuthContext {
  kind: 'user' | 'api_key'
  orgId: string
  role: Role
  userId: string | null
  apiKeyId: string | null
  /** Sessions the credential reaches. Null means every session in the org. */
  sessionScope: string[] | null
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
  }
  interface FastifyInstance {
    /** Requires a valid credential and populates `request.auth`. */
    authenticate: preHandlerHookHandler
    /** Requires a valid credential that satisfies the permission. */
    requirePermission: (permission: Permission) => preHandlerHookHandler
  }
}

async function authFromApiKey(app: FastifyInstance, token: string): Promise<AuthContext | null> {
  const parsed = parseApiKey(token)
  if (!parsed) return null

  const record = await findApiKeyByPrefix(app.db, parsed.prefix)
  if (!record) return null

  /**
   * SHA-256 and not argon2, on purpose. The secret carries 24 bytes of random
   * entropy, so there is no dictionary attack to make expensive — and a 19 MiB
   * argon2 per request would turn the gateway into a CPU bottleneck on exactly
   * the hot path of a send. A user password is a different case: there argon2
   * is mandatory.
   */
  if (!safeEqual(hashToken(parsed.secret), record.secretHash)) return null

  if (record.revokedAt) return null
  if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) return null

  // Off the critical path: a failure here does not invalidate the request.
  void touchApiKey(app.db, record.id).catch((error) => {
    app.log.warn({ err: error, apiKeyId: record.id }, 'failed to record API key usage')
  })

  return {
    kind: 'api_key',
    orgId: record.orgId,
    role: record.role,
    userId: null,
    apiKeyId: record.id,
    sessionScope: record.sessionScope,
  }
}

async function authFromSession(
  app: FastifyInstance,
  request: FastifyRequest,
  rawCookie: string,
): Promise<AuthContext | null> {
  const identity = new IdentityRepository(app.db)
  const found = await identity.findSessionUser(hashToken(rawCookie))
  if (!found) return null

  const memberships = await identity.listMemberships(found.userId)
  if (memberships.length === 0) {
    throw forbidden('Your account does not belong to any organization.')
  }

  const requested = request.headers[ORG_HEADER]
  const wanted = Array.isArray(requested) ? requested[0] : requested

  let membership = memberships[0]
  if (wanted) {
    membership = memberships.find((m) => m.orgId === wanted || m.orgSlug === wanted) ?? undefined
    if (!membership) {
      throw forbidden('You do not belong to the organization you named.')
    }
  } else if (memberships.length > 1) {
    throw badRequest(
      `You belong to more than one organization. Name which one in the ${ORG_HEADER} header.`,
      { organizations: memberships.map((m) => ({ id: m.orgId, slug: m.orgSlug })) },
    )
  }

  if (!membership) return null

  void identity.touchSession(found.sessionId).catch((error) => {
    app.log.warn({ err: error }, 'failed to update session last_seen')
  })

  return {
    kind: 'user',
    orgId: membership.orgId,
    role: membership.role,
    userId: found.userId,
    apiKeyId: null,
    sessionScope: null,
  }
}

async function resolveAuth(
  app: FastifyInstance,
  request: FastifyRequest,
): Promise<AuthContext | null> {
  const bearer = bearerFrom(request.headers.authorization)
  if (bearer) {
    return authFromApiKey(app, bearer)
  }

  const cookie = request.cookies[SESSION_COOKIE]
  if (cookie) {
    const unsigned = request.unsignCookie(cookie)
    if (!unsigned.valid || !unsigned.value) return null
    return authFromSession(app, request, unsigned.value)
  }

  return null
}

export const authPlugin = fp(
  async (app: FastifyInstance) => {
    app.decorateRequest('auth', null)

    app.decorate('authenticate', async function authenticate(request) {
      const context = await resolveAuth(app, request)
      if (!context) throw unauthorized()
      request.auth = context
    } satisfies preHandlerHookHandler)

    app.decorate('requirePermission', (permission: Permission): preHandlerHookHandler => {
      return async function checkPermission(request) {
        const context = request.auth ?? (await resolveAuth(app, request))
        if (!context) throw unauthorized()
        request.auth = context

        const allowed =
          context.kind === 'api_key'
            ? apiKeyCan(context.role, permission)
            : can(context.role, permission)

        if (!allowed) {
          throw forbidden(
            context.kind === 'api_key'
              ? 'API keys do not run this operation — use a user session.'
              : `Your role (${context.role}) does not cover this operation.`,
          )
        }
      }
    })
  },
  { name: 'awah-auth' },
)

/** Reads the auth context, making sure the preHandler ran first. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) {
    throw unauthorized()
  }
  return request.auth
}
