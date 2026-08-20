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
    const response = await app.inject({ method: 'GET', url: '/health' })
    const raw = String(response.headers['content-security-policy'] ?? '')

    return Object.fromEntries(
      raw
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const [name, ...values] = part.split(' ')
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
    const directives = await csp()
    expect(directives['script-src']).toBe("'self'")
    expect(directives['script-src']).not.toContain('unsafe-inline')
  })

  it('proíbe ser embutida em iframe e falar com outra origem', async () => {
    const directives = await csp()
    expect(directives['frame-ancestors']).toBe("'none'")
    expect(directives['connect-src']).toBe("'self'")
    expect(directives['object-src']).toBe("'none'")
  })

  it('mantém os demais cabeçalhos do helmet', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['strict-transport-security']).toContain('max-age=')
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
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(4096) }),
    })

    expect(response.statusCode).toBe(413)
  })
})
