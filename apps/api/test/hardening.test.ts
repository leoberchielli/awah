import { describe, expect, it } from 'vitest'
import { loadEnv } from '../src/env'

const BASE = {
  DATABASE_URL: 'postgres://awah:awah@localhost:5432/awah',
  REDIS_URL: 'redis://localhost:6379',
  ENCRYPTION_KEY: 'YXdhaC1kZXYta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=',
  COOKIE_SECRET: 'awah-dev-cookie-secret-trocar-antes-de-ir-a-producao',
}

/** Real keys, generated for the test — not the ones in the repository. */
const PROPRIAS = {
  ENCRYPTION_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
  COOKIE_SECRET: 'x'.repeat(48),
}

describe('segredos de desenvolvimento', () => {
  it('passam fora de produção', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'development' })).not.toThrow()
  })

  /**
   * These values ship in this repository's docker-compose and .env.example.
   * Anyone who goes to production with them hands session cookie forgery and
   * auth state decryption to whoever reads the project.
   */
  it('derrubam o processo em produção', () => {
    expect(() => loadEnv({ ...BASE, NODE_ENV: 'production' })).toThrow(/development secrets/i)
  })

  it('a mensagem diz quais são e como gerar os próprios', () => {
    try {
      loadEnv({ ...BASE, NODE_ENV: 'production' })
      expect.unreachable('deveria ter lançado')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('ENCRYPTION_KEY')
      expect(message).toContain('COOKIE_SECRET')
      expect(message).toContain('openssl rand')
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
    } catch (error) {
      // The first line is the accusation; the rest is the recipe, which names both.
      const receipt = (error as Error).message.split('\n')[0] ?? ''
      expect(receipt).toContain('COOKIE_SECRET')
      expect(receipt).not.toContain('ENCRYPTION_KEY')
    }
  })

  it('segredos próprios sobem em produção', () => {
    expect(() => loadEnv({ ...BASE, ...PROPRIAS, NODE_ENV: 'production' })).not.toThrow()
  })
})

describe('confiança em proxy', () => {
  /**
   * The default matters: the per-IP rate limit uses `request.ip`, and trusting
   * `X-Forwarded-For` with no proxy in front lets any client change IP on every
   * request and never hit the limit.
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

  /** The safe form behind a proxy: trust only the addresses that are the proxy. */
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
