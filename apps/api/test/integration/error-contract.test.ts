import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { loadEnv } from '../../src/env'

/**
 * Integration: needs a real Postgres and Redis. Outside CI and the compose
 * stack, the suite is skipped instead of failing.
 */
const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

describe.skipIf(!hasInfra)('error shape contract', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp(loadEnv())
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  /**
   * This suite exists because of a real bug: `setErrorHandler` on the root is
   * only inherited by plugin contexts created after it. With the routes
   * registered before it, the whole API answered in Fastify's default shape
   * (`{statusCode, code, error, message}`) while the docs promised
   * `{error: {code, message}}`. Nothing broke — the contract was just wrong.
   */
  it('returns 401 in the AWAH envelope, not in the Fastify default', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/me' })
    const body = response.json()

    expect(response.statusCode).toBe(401)
    expect(body).toHaveProperty('error.code', 'unauthorized')
    expect(body).toHaveProperty('error.message')
    // Fastify's own envelope must not leak at the root level.
    expect(body).not.toHaveProperty('statusCode')
    expect(body).not.toHaveProperty('error.statusCode')
    expect(typeof body.error).toBe('object')
  })

  it('uses the same envelope on a route that does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' })
    const body = response.json()

    expect(response.statusCode).toBe(404)
    expect(body).toHaveProperty('error.code', 'not_found')
    expect(body).not.toHaveProperty('statusCode')
  })

  it('uses the same envelope on a validation failure', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'not-an-email', password: '' },
    })
    const body = response.json()

    expect(response.statusCode).toBe(400)
    expect(body).toHaveProperty('error.code', 'validation_failed')
    expect(Array.isArray(body.error.details)).toBe(true)
    expect(body).not.toHaveProperty('statusCode')
  })

  it('keeps liveness outside authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('status', 'ok')
  })
})
