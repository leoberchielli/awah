import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decrypt, encrypt, hashToken, randomToken, safeEqual } from '../src/lib/crypto'

const key = randomBytes(32)

describe('cifra do auth state', () => {
  it('faz round-trip', () => {
    const secret = JSON.stringify({ noiseKey: 'abc', signedIdentityKey: 'def' })
    expect(decrypt(encrypt(secret, key), key)).toBe(secret)
  })

  it('gera ciphertext diferente a cada chamada', () => {
    // Random IV: the same text must not produce the same payload twice.
    expect(encrypt('mesmo texto', key)).not.toBe(encrypt('mesmo texto', key))
  })

  it('preserva unicode', () => {
    const texto = 'sessão ativa · 中文 · emoji 🔐'
    expect(decrypt(encrypt(texto, key), key)).toBe(texto)
  })

  it('recusa a chave errada', () => {
    const payload = encrypt('credencial', key)
    expect(() => decrypt(payload, randomBytes(32))).toThrow()
  })

  /** GCM is authenticated: a tampered ciphertext must fail, not decrypt wrong. */
  it('detecta adulteração do ciphertext', () => {
    const [iv, tag, data] = encrypt('credencial', key).split('.') as [string, string, string]
    const corrupted = Buffer.from(data, 'base64url')
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff

    expect(() => decrypt(`${iv}.${tag}.${corrupted.toString('base64url')}`, key)).toThrow()
  })

  it('rejeita payload malformado', () => {
    expect(() => decrypt('sem-separador', key)).toThrow('malformed')
    expect(() => decrypt('a.b', key)).toThrow('malformed')
    expect(() => decrypt('a.b.c', key)).toThrow('malformed')
  })
})

describe('hash de token', () => {
  it('é determinístico', () => {
    expect(hashToken('token')).toBe(hashToken('token'))
  })

  it('separa entradas diferentes', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'))
  })
})

describe('comparação segura', () => {
  it('reconhece iguais e diferentes', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
  })

  it('não estoura com tamanhos diferentes', () => {
    expect(safeEqual('curto', 'muito mais longo')).toBe(false)
  })
})

describe('randomToken', () => {
  it('gera valores únicos e url-safe', () => {
    const token = randomToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(token).not.toBe(randomToken())
  })
})
