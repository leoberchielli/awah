import { describe, expect, it } from 'vitest'
import { bearerFrom, generateApiKey, parseApiKey } from '../src/auth/api-key'

describe('key generation', () => {
  it('round-trips prefix and secret', () => {
    const generated = generateApiKey()
    const parsed = parseApiKey(generated.token)

    expect(parsed).not.toBeNull()
    expect(parsed?.prefix).toBe(generated.prefix)
    expect(parsed?.secret).toBe(generated.secret)
  })

  /**
   * The secret is base64url and can contain `_`. Since the parse splits on the
   * first separator after the scheme, the prefix has to be hex — this test
   * pins that assumption down.
   */
  it('survives a secret containing an underscore', () => {
    const generated = generateApiKey()
    expect(generated.prefix).toMatch(/^[0-9a-f]{16}$/)

    const parsed = parseApiKey(`awah_${generated.prefix}_abc_def-ghi_jkl`)
    expect(parsed?.prefix).toBe(generated.prefix)
    expect(parsed?.secret).toBe('abc_def-ghi_jkl')
  })

  it('generates distinct values on every call', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(a.prefix).not.toBe(b.prefix)
    expect(a.secret).not.toBe(b.secret)
  })
})

describe('parsing a malformed key', () => {
  it.each([
    ['wrong scheme', 'waha_deadbeefdeadbeef_segredo'],
    ['no separator', 'awah_deadbeefdeadbeefsegredo'.replace('_', '')],
    ['empty prefix', 'awah__segredo'],
    ['empty secret', 'awah_deadbeefdeadbeef_'],
    ['non-hex prefix', 'awah_ZZZZ_segredo'],
    ['empty string', ''],
    ['scheme only', 'awah_'],
  ])('rejects %s', (_label, token) => {
    expect(parseApiKey(token)).toBeNull()
  })
})

describe('Authorization header', () => {
  it('extracts the token from the Bearer scheme, case-insensitively', () => {
    expect(bearerFrom('Bearer abc123')).toBe('abc123')
    expect(bearerFrom('bearer abc123')).toBe('abc123')
    expect(bearerFrom('BEARER abc123')).toBe('abc123')
  })

  it('ignores a missing header or another scheme', () => {
    expect(bearerFrom(undefined)).toBeNull()
    expect(bearerFrom('Basic abc123')).toBeNull()
    expect(bearerFrom('Bearer')).toBeNull()
    expect(bearerFrom('Bearer   ')).toBeNull()
  })
})
