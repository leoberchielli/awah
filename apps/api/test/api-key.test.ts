import { describe, expect, it } from 'vitest'
import { bearerFrom, generateApiKey, parseApiKey } from '../src/auth/api-key'

describe('geração de chave', () => {
  it('faz round-trip de prefixo e segredo', () => {
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
  it('sobrevive a segredo contendo underscore', () => {
    const generated = generateApiKey()
    expect(generated.prefix).toMatch(/^[0-9a-f]{16}$/)

    const parsed = parseApiKey(`awah_${generated.prefix}_abc_def-ghi_jkl`)
    expect(parsed?.prefix).toBe(generated.prefix)
    expect(parsed?.secret).toBe('abc_def-ghi_jkl')
  })

  it('gera valores distintos a cada chamada', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(a.prefix).not.toBe(b.prefix)
    expect(a.secret).not.toBe(b.secret)
  })
})

describe('parse de chave malformada', () => {
  it.each([
    ['esquema errado', 'waha_deadbeefdeadbeef_segredo'],
    ['sem separador', 'awah_deadbeefdeadbeefsegredo'.replace('_', '')],
    ['prefixo vazio', 'awah__segredo'],
    ['segredo vazio', 'awah_deadbeefdeadbeef_'],
    ['prefixo não hex', 'awah_ZZZZ_segredo'],
    ['string vazia', ''],
    ['só o esquema', 'awah_'],
  ])('rejeita %s', (_label, token) => {
    expect(parseApiKey(token)).toBeNull()
  })
})

describe('header Authorization', () => {
  it('extrai o token do esquema Bearer, sem diferenciar caixa', () => {
    expect(bearerFrom('Bearer abc123')).toBe('abc123')
    expect(bearerFrom('bearer abc123')).toBe('abc123')
    expect(bearerFrom('BEARER abc123')).toBe('abc123')
  })

  it('ignora header ausente ou de outro esquema', () => {
    expect(bearerFrom(undefined)).toBeNull()
    expect(bearerFrom('Basic abc123')).toBeNull()
    expect(bearerFrom('Bearer')).toBeNull()
    expect(bearerFrom('Bearer   ')).toBeNull()
  })
})
