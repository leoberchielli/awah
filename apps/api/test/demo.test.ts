import { randomBytes } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { demoRefusalFor } from '../src/demo/guard'
import { DEMO_USER_ID } from '../src/demo/seed'
import { scenarioFromConfig } from '../src/engines/simulator/scenario'
import { loadEnv } from '../src/env'

const valid = {
  DATABASE_URL: 'postgres://awah:awah@localhost:5432/awah',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  COOKIE_SECRET: randomBytes(48).toString('base64'),
}

/** Only the three fields the guard reads. */
function request(method: string, url: string, body?: unknown): FastifyRequest {
  return { method, url, body } as FastifyRequest
}

describe('demo mode in the environment', () => {
  it('is off unless it is asked for', () => {
    const env = loadEnv(valid)
    expect(env.DEMO_MODE).toBe(false)
    expect(env.DEMO_RESET_MINUTES).toBe(180)
  })

  it('refuses to start a demo with no engine to run it', () => {
    expect(() => loadEnv({ ...valid, DEMO_MODE: 'true' })).toThrow('SIMULATOR_ENABLED')
  })

  it('keeps the simulator banned in production on its own', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', SIMULATOR_ENABLED: 'true' })).toThrow(
      'SIMULATOR_ENABLED',
    )
  })

  /**
   * The exception, and the reason it is not a hole: what the ban protects
   * against is a fake engine nobody knows is fake, and a demo announces itself
   * on the login screen, in `/v1/auth/me` and in a banner over every panel.
   */
  it('allows the simulator in production when the instance declares itself a demo', () => {
    const env = loadEnv({
      ...valid,
      NODE_ENV: 'production',
      SIMULATOR_ENABLED: 'true',
      DEMO_MODE: 'true',
    })

    expect(env.DEMO_MODE).toBe(true)
    expect(env.SIMULATOR_ENABLED).toBe(true)
    expect(env.DEMO_EMAIL).toBe('admin@awah.demo')
  })

  it('still refuses the published development secrets in production', () => {
    expect(() =>
      loadEnv({
        ...valid,
        NODE_ENV: 'production',
        SIMULATOR_ENABLED: 'true',
        DEMO_MODE: 'true',
        COOKIE_SECRET: 'awah-dev-cookie-secret-change-before-production',
      }),
    ).toThrow('COOKIE_SECRET')
  })
})

describe('what a visitor to the demo cannot do', () => {
  it('leaves reading alone', () => {
    expect(demoRefusalFor(request('GET', '/v1/kpi/delivery?hours=24'))).toBeNull()
    expect(demoRefusalFor(request('GET', `/v1/org/members/${DEMO_USER_ID}`))).toBeNull()
  })

  it('lets the ordinary operator work', () => {
    expect(demoRefusalFor(request('POST', '/v1/sessions', { engine: 'simulator' }))).toBeNull()
    expect(demoRefusalFor(request('POST', '/v1/messages', { text: 'hi' }))).toBeNull()
    expect(demoRefusalFor(request('POST', '/v1/keys', { name: 'mine' }))).toBeNull()
    expect(demoRefusalFor(request('DELETE', '/v1/org/members/9f1e-not-the-demo-user'))).toBeNull()
  })

  it('protects the account printed on the login screen', () => {
    expect(demoRefusalFor(request('DELETE', `/v1/org/members/${DEMO_USER_ID}`))).toContain(
      'cannot be changed or removed',
    )
    expect(
      demoRefusalFor(request('PATCH', `/v1/org/members/${DEMO_USER_ID}`, { role: 'viewer' })),
    ).toContain('cannot be changed or removed')
    // A trailing slash is the same URL, and used to walk straight past this.
    expect(demoRefusalFor(request('DELETE', `/v1/org/members/${DEMO_USER_ID}/`))).not.toBeNull()
  })

  /**
   * The instance runs with published secrets, and `ENCRYPTION_KEY` is what
   * protects a paired number's auth state at rest. Pairing a real phone here
   * would hand that number to anyone who read the compose file.
   */
  it('refuses every engine but the simulator', () => {
    expect(demoRefusalFor(request('POST', '/v1/sessions', { engine: 'baileys' }))).toContain(
      'only runs the simulator engine',
    )
    expect(demoRefusalFor(request('POST', '/v1/sessions', { engine: 'cloud_api' }))).toContain(
      'only runs the simulator engine',
    )
    // The field defaults to `baileys` in the route, so omitting it is a real number too.
    expect(demoRefusalFor(request('POST', '/v1/sessions', { name: 'mine' }))).toContain(
      'only runs the simulator engine',
    )
    expect(
      demoRefusalFor(request('PUT', '/v1/sessions/8a7b/credentials', { token: 'x' })),
    ).not.toBeNull()
  })

  it('keeps the organization from deleting itself', () => {
    expect(demoRefusalFor(request('DELETE', '/v1/org'))).toContain('cannot be deleted')
    expect(demoRefusalFor(request('PATCH', '/v1/org', { name: 'Anything' }))).toBeNull()
  })
})

describe('simulator scenario from the session config', () => {
  it('reads a named scenario', () => {
    expect(scenarioFromConfig({ simulator: { scenario: 'degraded' } })?.deliveryRate).toBe(0.4)
  })

  it('lets a field override the named base', () => {
    const scenario = scenarioFromConfig({
      simulator: { scenario: 'mature', phoneNumber: '5511999990001', ageDays: 47 },
    })

    expect(scenario?.ageDays).toBe(47)
    expect(scenario?.phoneNumber).toBe('5511999990001')
  })

  it('ignores an unknown name instead of failing the session', () => {
    expect(scenarioFromConfig({ simulator: { scenario: 'nope', ageDays: 5 } })).toEqual({
      ageDays: 5,
    })
  })

  it('says nothing when the config has nothing to say', () => {
    expect(scenarioFromConfig({})).toBeNull()
    expect(scenarioFromConfig(null)).toBeNull()
    expect(scenarioFromConfig({ limits: { perMinute: 4 } })).toBeNull()
  })
})
