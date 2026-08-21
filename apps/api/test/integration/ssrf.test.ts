import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { loadEnv } from '../../src/env'
import { type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

/**
 * The three places where a URL the caller chooses becomes a request this server
 * makes.
 *
 * Each one was reachable: the connector's test button returned the body of a
 * LAN router's home page from the public demo, and the webhook subscription
 * would have posted a signed payload anywhere the machine could reach. The
 * checks live in the routes, so this exercises them through the routes.
 */
describe.skipIf(!hasInfra)('URLs pointing into the private network', () => {
  let app: FastifyInstance
  let org: SeededOrg

  beforeAll(async () => {
    app = await buildApp({ ...loadEnv(), ALLOW_PRIVATE_INTEGRATION_TARGETS: false })
    await app.ready()
    org = await seedOrg(app.db, { role: 'admin' })
  })

  afterAll(async () => {
    await org.cleanup()
    await app.close()
  })

  const auth = () => ({ authorization: `Bearer ${org.token}` })

  it('refuses a webhook aimed at loopback', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(),
      payload: { url: 'http://127.0.0.1:20247/metrics', events: ['message.status'] },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain("inside this server's own network")
  })

  it('refuses a webhook aimed at the LAN', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(),
      payload: { url: 'http://192.168.10.1/', events: ['*'] },
    })

    expect(response.statusCode).toBe(400)
  })

  it('accepts a webhook aimed at the internet', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(),
      payload: { url: 'https://example.com/awah', events: ['*'] },
    })

    expect(response.statusCode).toBe(201)
  })

  /** Editing a subscription is the other way in, and it used to be unguarded. */
  it('refuses to redirect an existing webhook inward', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(),
      payload: { url: 'https://example.com/awah-2', events: ['*'] },
    })
    const id = created.json().webhook.id

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/${id}`,
      headers: auth(),
      payload: { url: 'http://169.254.169.254/latest/meta-data/' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('refuses the connector test that reads the answer back', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/integrations/http/test',
      headers: auth(),
      payload: { url: 'http://127.0.0.1:2900/v1/auth/bootstrap' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toContain('ALLOW_PRIVATE_INTEGRATION_TARGETS')
  })

  it('refuses Chatwoot discovery pointed at an internal address', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/integrations/chatwoot/discover',
      headers: auth(),
      payload: { baseUrl: 'http://10.0.0.7:3000', apiAccessToken: 'token-that-is-long-enough' },
    })

    expect(response.statusCode).toBe(400)
  })

  it('refuses a scheme that is not http', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth(),
      payload: { url: 'file:///etc/passwd', events: ['*'] },
    })

    // Zod rejects some of these before the guard does; either way it stops here.
    expect(response.statusCode).toBe(400)
  })
})
