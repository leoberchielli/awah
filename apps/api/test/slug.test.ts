import { describe, expect, it } from 'vitest'
import { slugify } from '../src/lib/slug'

/*
 * The Portuguese inputs below are the subject of these tests, not a leftover:
 * `slugify` exists to fold accents, and an ASCII-only fixture would assert
 * nothing about the case it was written for.
 */
describe('organization slug', () => {
  it('normalizes accents and spaces', () => {
    expect(slugify('Soluções Integradas')).toBe('solucoes-integradas')
    expect(slugify('AÇÃO & Cia')).toBe('acao-cia')
  })

  it('drops symbols and collapses separators', () => {
    expect(slugify('  Loja //  do  João!! ')).toBe('loja-do-joao')
  })

  it('never returns empty', () => {
    expect(slugify('')).toBe('org')
    expect(slugify('!!!')).toBe('org')
    expect(slugify('   ')).toBe('org')
  })

  it('caps the length', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(48)
  })

  it('is already canonical when it receives a slug', () => {
    expect(slugify('minha-org')).toBe('minha-org')
  })
})
