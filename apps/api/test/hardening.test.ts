import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env'

const BASE = {
  DATABASE_URL: 'postgres://awah:awah@localhost:5432/awah',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'YXdhaC1kZXYta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=',
  COOKIE_SECRET: 'awah-dev-cookie-secret-change-before-production',
}

/** Real keys, generated for the test — not the ones in the repository. */
const OWN_SECRETS = {
  ENCRYPTION_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
  COOKIE_SECRET: 'x'.repeat(48),
}

/**
 * The simulator is not a WhatsApp client: it accepts every send and reports it
 * delivered without anything reaching a phone. Left on in production it fails
 * silently, looks healthy on every screen, and is discovered by the customer
 * who never got an answer — which is why the process refuses to start instead
 * of warning.
 */
describe('the simulator engine in production', () => {
  it('is off by default', () => {
    expect(loadEnv({ ...BASE, ...OWN_SECRETS }).SIMULATOR_ENABLED).toBe(false)
  })

  it('is allowed outside production', () => {
    expect(() =>
      loadEnv({ ...BASE, NODE_ENV: 'development', SIMULATOR_ENABLED: 'true' }),
    ).not.toThrow()
  })

  it('brings the process down in production', () => {
    expect(() =>
      loadEnv({ ...BASE, ...OWN_SECRETS, NODE_ENV: 'production', SIMULATOR_ENABLED: 'true' }),
    ).toThrow(/SIMULATOR_ENABLED/)
  })

  it('the message says what the danger actually is', () => {
    try {
      loadEnv({ ...BASE, ...OWN_SECRETS, NODE_ENV: 'production', SIMULATOR_ENABLED: 'true' })
      expect.unreachable('should have thrown')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('not a WhatsApp client')
      expect(message).toContain('delivered')
    }
  })

  it('production with the flag off starts normally', () => {
    expect(() => loadEnv({ ...BASE, ...OWN_SECRETS, NODE_ENV: 'production' })).not.toThrow()
  })
})

describe('development secrets', () => {
  it('pass outside production', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'development' })).not.toThrow()
  })

  /**
   * These values ship in this repository's docker-compose and .env.example.
   * Anyone who goes to production with them hands session cookie forgery and
   * auth state decryption to whoever reads the project.
   */
  it('bring the process down in production', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'production' })).toThrow(/development secrets/i)
  })

  it('the message says which ones they are and how to generate your own', () => {
    try {
      loadEnv({ ...BASE, NODE_ENV: 'production' })
      expect.unreachable('should have thrown')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('ENCRYPTION_KEY')
      expect(message).toContain('COOKIE_SECRET')
      expect(message).toContain('openssl rand')
    }
  })

  it('points only at what is actually weak', () => {
    try {
      loadEnv({
        ...BASE,
        NODE_ENV: 'production',
        ENCRYPTION_KEY: OWN_SECRETS.ENCRYPTION_KEY,
      })
      expect.unreachable('should have thrown')
    } catch (error) {
      // The first line is the accusation; the rest is the recipe, which names both.
      const receipt = (error as Error).message.split('\n')[0] ?? ''
      expect(receipt).toContain('COOKIE_SECRET')
      expect(receipt).not.toContain('ENCRYPTION_KEY')
    }
  })

  it('your own secrets boot in production', () => {
    expect(() => loadEnv({ ...BASE, ...OWN_SECRETS, NODE_ENV: 'production' })).not.toThrow()
  })
})

describe('proxy trust', () => {
  /**
   * The default matters: the per-IP rate limit uses `request.ip`, and trusting
   * `X-Forwarded-For` with no proxy in front lets any client change IP on every
   * request and never hit the limit.
   */
  it('does not trust by default', () => {
    expect(loadEnv(BASE).TRUST_PROXY).toBe(false)
  })

  it('understands the spellings of a boolean', () => {
    expect(loadEnv({ ...BASE, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true)
    expect(loadEnv({ ...BASE, TRUST_PROXY: 'yes' }).TRUST_PROXY).toBe(true)
    expect(loadEnv({ ...BASE, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false)
    expect(loadEnv({ ...BASE, TRUST_PROXY: '' }).TRUST_PROXY).toBe(false)
  })

  it('accepts a number of hops', () => {
    expect(loadEnv({ ...BASE, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2)
  })

  /** The safe form behind a proxy: trust only the addresses that are the proxy. */
  it('accepts a list of CIDRs', () => {
    expect(loadEnv({ ...BASE, TRUST_PROXY: '10.0.0.0/8,172.16.0.0/12' }).TRUST_PROXY).toBe(
      '10.0.0.0/8,172.16.0.0/12',
    )
  })
})

describe('public address', () => {
  it('is optional', () => {
    expect(loadEnv(BASE).PUBLIC_URL).toBeUndefined()
  })

  it('drops the trailing slash so no URL comes out with a double slash', () => {
    expect(loadEnv({ ...BASE, PUBLIC_URL: 'https://awah.example.com/' }).PUBLIC_URL).toBe(
      'https://awah.example.com',
    )
  })

  it('refuses a value that is not a URL', () => {
    expect(() => loadEnv({ ...BASE, PUBLIC_URL: 'awah.example.com' })).toThrow(/PUBLIC_URL/)
  })
})

describe('request body ceiling', () => {
  it('comes with 1 MiB', () => {
    expect(loadEnv(BASE).BODY_LIMIT_BYTES).toBe(1_048_576)
  })

  it('refuses an absurd ceiling', () => {
    expect(() => loadEnv({ ...BASE, BODY_LIMIT_BYTES: '999999999' })).toThrow(/BODY_LIMIT_BYTES/)
  })
})
