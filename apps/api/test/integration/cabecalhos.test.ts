import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { loadEnv } from '../../src/env'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

describe.skipIf(!hasInfra)('cabeçalhos de segurança', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp(loadEnv())
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  async function csp(): Promise<Record<string, string>> {
    const resposta = await app.inject({ method: 'GET', url: '/health' })
    const bruto = String(resposta.headers['content-security-policy'] ?? '')

    return Object.fromEntries(
      bruto
        .split(';')
        .map((parte) => parte.trim())
        .filter(Boolean)
        .map((parte) => {
          const [name, ...values] = parte.split(' ')
          return [name ?? '', values.join(' ')]
        }),
    )
  }

  it('publica CSP também fora de produção', async () => {
    // Production-only would mean finding the breakage at deploy, not in dev.
    expect(Object.keys(await csp()).length).toBeGreaterThan(0)
  })

  /**
   * The policy's three exceptions exist for concrete reasons in the panel. If
   * someone tightens the CSP without knowing that, one of these tests falls
   * first — before the deploy does.
   */
  it('permite o QR de pareamento, que chega como data: URI', async () => {
    expect((await csp())['img-src']).toContain('data:')
  })

  it('permite estilo inline, que o Swagger UI e as barras do painel usam', async () => {
    expect((await csp())['style-src']).toContain("'unsafe-inline'")
  })

  it('não permite script inline', async () => {
    const diretivas = await csp()
    expect(diretivas['script-src']).toBe("'self'")
    expect(diretivas['script-src']).not.toContain('unsafe-inline')
  })

  it('proíbe ser embutida em iframe e falar com outra origem', async () => {
    const diretivas = await csp()
    expect(diretivas['frame-ancestors']).toBe("'none'")
    expect(diretivas['connect-src']).toBe("'self'")
    expect(diretivas['object-src']).toBe("'none'")
  })

  it('mantém os demais cabeçalhos do helmet', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health' })

    expect(resposta.headers['x-content-type-options']).toBe('nosniff')
    expect(resposta.headers['strict-transport-security']).toContain('max-age=')
  })
})

describe.skipIf(!hasInfra)('teto do corpo da requisição', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp({ ...loadEnv(), BODY_LIMIT_BYTES: 2048 })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('recusa corpo acima do teto antes de qualquer processamento', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(4096) }),
    })

    expect(resposta.statusCode).toBe(413)
  })
})
