import { describe, expect, it } from 'vitest'
import { slugify } from '../src/lib/slug'

describe('slug de organização', () => {
  it('normaliza acentos e espaços', () => {
    expect(slugify('Soluções Integradas')).toBe('solucoes-integradas')
    expect(slugify('AÇÃO & Cia')).toBe('acao-cia')
  })

  it('descarta símbolos e colapsa separadores', () => {
    expect(slugify('  Loja //  do  João!! ')).toBe('loja-do-joao')
  })

  it('nunca devolve vazio', () => {
    expect(slugify('')).toBe('org')
    expect(slugify('!!!')).toBe('org')
    expect(slugify('   ')).toBe('org')
  })

  it('limita o tamanho', () => {
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(48)
  })

  it('já está em forma canônica quando recebe um slug', () => {
    expect(slugify('minha-org')).toBe('minha-org')
  })
})
