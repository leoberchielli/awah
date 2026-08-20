import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env'

const BASE = {
  DATABASE_URL: 'postgres://awah:awah@localhost:5432/awah',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'YXdhaC1kZXYta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=',
  COOKIE_SECRET: 'awah-dev-cookie-secret-trocar-antes-de-ir-a-producao',
}

/** Chaves reais, geradas para o teste — não são as do repositório. */
const PROPRIAS = {
  ENCRYPTION_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
  COOKIE_SECRET: 'x'.repeat(48),
}

describe('segredos de desenvolvimento', () => {
  it('passam fora de produção', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'development' })).not.toThrow()
  })

  /**
   * Estes valores estão no docker-compose e no .env.example deste repositório.
   * Quem subir em produção com eles entrega a forja de cookie de sessão e a
   * decifragem do auth state a qualquer um que leia o projeto.
   */
  it('derrubam o processo em produção', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'production' })).toThrow(/development secrets/i)
  })

  it('a mensagem diz quais são e como gerar os próprios', () => {
    try {
      loadEnv({ ...BASE, NODE_ENV: 'production' })
      expect.unreachable('deveria ter lançado')
    } catch (erro) {
      const mensagem = (erro as Error).message
      expect(mensagem).toContain('ENCRYPTION_KEY')
      expect(mensagem).toContain('COOKIE_SECRET')
      expect(mensagem).toContain('openssl rand')
    }
  })

  it('aponta só o que de fato é fraco', () => {
    try {
      loadEnv({
        ...BASE,
        NODE_ENV: 'production',
        ENCRYPTION_KEY: PROPRIAS.ENCRYPTION_KEY,
      })
      expect.unreachable('deveria ter lançado')
    } catch (erro) {
      // A primeira linha é a acusação; o resto é a receita, que cita os dois.
      const acusacao = (erro as Error).message.split('\n')[0] ?? ''
      expect(acusacao).toContain('COOKIE_SECRET')
      expect(acusacao).not.toContain('ENCRYPTION_KEY')
    }
  })

  it('segredos próprios sobem em produção', () => {
    expect(() => loadEnv({ ...BASE, ...PROPRIAS, NODE_ENV: 'production' })).not.toThrow()
  })
})

describe('confiança em proxy', () => {
  /**
   * O padrão importa: o rate limit por IP usa `request.ip`, e confiar em
   * `X-Forwarded-For` sem proxy na frente deixa qualquer cliente trocar de IP a
   * cada requisição e nunca bater no limite.
   */
  it('não confia por padrão', () => {
    expect(loadEnv(BASE).TRUST_PROXY).toBe(false)
  })

  it('entende as grafias de booleano', () => {
    expect(loadEnv({ ...BASE, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true)
    expect(loadEnv({ ...BASE, TRUST_PROXY: 'yes' }).TRUST_PROXY).toBe(true)
    expect(loadEnv({ ...BASE, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false)
    expect(loadEnv({ ...BASE, TRUST_PROXY: '' }).TRUST_PROXY).toBe(false)
  })

  it('aceita número de saltos', () => {
    expect(loadEnv({ ...BASE, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2)
  })

  /** A forma segura atrás de proxy: confiar só nos endereços que são o proxy. */
  it('aceita lista de CIDRs', () => {
    expect(loadEnv({ ...BASE, TRUST_PROXY: '10.0.0.0/8,172.16.0.0/12' }).TRUST_PROXY).toBe(
      '10.0.0.0/8,172.16.0.0/12',
    )
  })
})

describe('endereço público', () => {
  it('é opcional', () => {
    expect(loadEnv(BASE).PUBLIC_URL).toBeUndefined()
  })

  it('descarta a barra final para não gerar URL com barra dupla', () => {
    expect(loadEnv({ ...BASE, PUBLIC_URL: 'https://awah.exemplo.com/' }).PUBLIC_URL).toBe(
      'https://awah.exemplo.com',
    )
  })

  it('recusa valor que não é URL', () => {
    expect(() => loadEnv({ ...BASE, PUBLIC_URL: 'awah.exemplo.com' })).toThrow(/PUBLIC_URL/)
  })
})

describe('teto do corpo da requisição', () => {
  it('vem com 1 MiB', () => {
    expect(loadEnv(BASE).BODY_LIMIT_BYTES).toBe(1_048_576)
  })

  it('recusa teto absurdo', () => {
    expect(() => loadEnv({ ...BASE, BODY_LIMIT_BYTES: '999999999' })).toThrow(/BODY_LIMIT_BYTES/)
  })
})
