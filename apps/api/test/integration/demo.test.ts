import { eq, schema, sql } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { DEMO_API_KEY, DEMO_ORG_ID, DEMO_USER_ID } from '../../src/demo/seed'
import { loadEnv } from '../../src/env'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

/**
 * The demo, built for real and then read back through the API.
 *
 * The seed is the one piece of this feature that cannot be checked by reading
 * it: eight thousand rows either add up to a dashboard or they do not, and the
 * difference only shows through the same endpoints the panel calls. It runs
 * against the same Postgres as the rest of the integration suite, and cleans up
 * after itself — the demo organization has a fixed id precisely so it is
 * findable.
 */
describe.skipIf(!hasInfra)('public demo', () => {
  let app: FastifyInstance
  let cookie: string

  beforeAll(async () => {
    app = await buildApp({
      ...loadEnv(),
      DEMO_MODE: true,
      SIMULATOR_ENABLED: true,
      // The reset has its own clock; a test that waited on it would be a sleep.
      DEMO_RESET_MINUTES: 0,
      /*
       * The sessions are seeded as `desired_state = 'running'` and the failover
       * scanner adopts them within seconds. Here that would mean three
       * simulators emitting inbound traffic into the assertions below, so the
       * scan is pushed past the life of the test.
       */
      FAILOVER_SCAN_MS: 300_000,
    })
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'admin@awah.demo', password: 'admin' },
    })
    expect(login.statusCode).toBe(200)
    cookie = login.headers['set-cookie']?.toString().split(';')[0] ?? ''
  }, 120_000)

  afterAll(async () => {
    await app.db.delete(schema.orgs).where(eq(schema.orgs.id, DEMO_ORG_ID))
    await app.db.delete(schema.users).where(eq(schema.users.id, DEMO_USER_ID))
    await app.close()
  })

  it('publishes its credentials to whoever asks', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/bootstrap' })
    const body = response.json()

    expect(body.needsSetup).toBe(false)
    expect(body.demo).toMatchObject({ email: 'admin@awah.demo', password: 'admin' })
  })

  it('signs in with the published credentials', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { cookie },
    })

    expect(response.json()).toMatchObject({ role: 'owner', organizationId: DEMO_ORG_ID })
    expect(response.json().demo).not.toBeNull()
  })

  it('answers the published API key', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${DEMO_API_KEY}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().sessions).toHaveLength(3)
  })

  it('opens on a dashboard and not on an empty state', async () => {
    const delivery = await app
      .inject({ method: 'GET', url: '/v1/kpi/delivery?hours=720', headers: { cookie } })
      .then((r) => r.json())

    expect(delivery.funnel.sent).toBeGreaterThan(1000)
    expect(delivery.funnel.delivered).toBeGreaterThan(0)
    expect(delivery.funnel.read).toBeGreaterThan(0)
    // A failure with no event on the trail is a message nobody accounts for.
    expect(delivery.funnel.failed).toBeGreaterThan(0)
    expect(delivery.latencyMs.p50).toBeGreaterThan(0)
    // The dead-letter queue is a claim this project makes; it has to be visible.
    expect(delivery.queue.dead).toBeGreaterThan(0)
    expect(delivery.webhooks.delivered).toBeGreaterThan(0)

    const risk = await app
      .inject({ method: 'GET', url: '/v1/kpi/risk?hours=720', headers: { cookie } })
      .then((r) => r.json())

    expect(risk.decisions.allowed).toBeGreaterThan(0)
    expect(risk.decisions.held).toBeGreaterThan(0)
    expect(risk.newContacts).toBeGreaterThan(0)

    const business = await app
      .inject({ method: 'GET', url: '/v1/kpi/business?hours=720', headers: { cookie } })
      .then((r) => r.json())

    expect(business.activeChats).toBeGreaterThan(0)
    expect(business.responseRate).toBeGreaterThan(0)
    expect(business.firstResponseSeconds.p50).toBeGreaterThan(0)
    expect(business.topChats.length).toBeGreaterThan(0)
  })

  /**
   * Restarting the process must not double the month of traffic. A demo that
   * grows by eight thousand messages per deploy stops being the thing the
   * README describes.
   */
  it('does not write its history twice', async () => {
    /*
     * Counted from the table and not from the funnel: the KPI window slides
     * with the clock, so the oldest hourly bucket falls out of a 720-hour read
     * between two calls a few seconds apart — which looks exactly like the
     * thing this test is checking for, only backwards.
     */
    const sent = async () => {
      const [row] = await app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.messages)
        .where(eq(schema.messages.orgId, DEMO_ORG_ID))
      return Number(row?.total ?? 0)
    }

    const before = await sent()

    const second = await buildApp({
      ...loadEnv(),
      DEMO_MODE: true,
      SIMULATOR_ENABLED: true,
      DEMO_RESET_MINUTES: 0,
      FAILOVER_SCAN_MS: 300_000,
    })
    await second.ready()
    await second.close()

    expect(await sent()).toBe(before)
  }, 120_000)

  it('refuses to pair a real number', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { cookie },
      payload: { name: 'my number', engine: 'baileys' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.message).toContain('simulator')
  })

  it('creates a session on the simulator, like any operator would', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { cookie },
      payload: { name: 'visitor session', engine: 'simulator' },
    })

    expect(response.statusCode).toBe(201)
  })

  it('refuses to give away its own front door', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/org/members/${DEMO_USER_ID}`,
      headers: { cookie },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error.message).toContain('demo')
  })
})
