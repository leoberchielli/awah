import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decrypt, encrypt, hashToken, randomToken, safeEqual } from '../src/lib/crypto'

const key = randomBytes(32)

describe('auth state cipher', () => {
  it('round-trips', () => {
    const secret = JSON.stringify({ noiseKey: 'abc', signedIdentityKey: 'def' })
    expect(decrypt(encrypt(secret, key), key)).toBe(secret)
  })

  it('produces a different ciphertext on every call', () => {
    // Random IV: the same text must not produce the same payload twice.
    expect(encrypt('same text', key)).not.toBe(encrypt('same text', key))
  })

  /* Three scripts and an emoji on purpose: this is the assertion. */
  it('preserves unicode', () => {
    const text = 'sessão ativa · 中文 · emoji 🔐'
    expect(decrypt(encrypt(text, key), key)).toBe(text)
  })

  it('refuses the wrong key', () => {
    const payload = encrypt('credencial', key)
    expect(() => decrypt(payload, randomBytes(32))).toThrow()
  })

  /** GCM is authenticated: a tampered ciphertext must fail, not decrypt wrong. */
  it('detects a tampered ciphertext', () => {
    const [iv, tag, data] = encrypt('credencial', key).split('.') as [string, string, string]
    const corrupted = Buffer.from(data, 'base64url')
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff

    expect(() => decrypt(`${iv}.${tag}.${corrupted.toString('base64url')}`, key)).toThrow()
  })

  it('rejects a malformed payload', () => {
    expect(() => decrypt('no-separator', key)).toThrow('malformed')
    expect(() => decrypt('a.b', key)).toThrow('malformed')
    expect(() => decrypt('a.b.c', key)).toThrow('malformed')
  })
})

describe('token hash', () => {
  it('is deterministic', () => {
    expect(hashToken('token')).toBe(hashToken('token'))
  })

  it('separates different inputs', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'))
  })
})

describe('safe comparison', () => {
  it('recognizes equal and different values', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
  })

  it('does not blow up on different lengths', () => {
    expect(safeEqual('curto', 'much longer')).toBe(false)
  })
})

describe('randomToken', () => {
  it('generates unique url-safe values', () => {
    const token = randomToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token).not.toBe(randomToken())
  })
})
