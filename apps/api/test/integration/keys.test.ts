import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { loadEnv } from '../../src/env'
import { createSession, type SeededOrg, seedOrg, seedUser } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

/** The example UUID Swagger UI suggests for any `format: uuid` field. */
const UUID_DE_EXEMPLO = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

describe.skipIf(!hasInfra)('criação de chave de API', () => {
  let app: FastifyInstance
  let org: SeededOrg
  let sessao: string
  /**
   * A user session cookie, not an API key: issuing a key is identity
   * administration, and an API key does not do that, by design.
   */
  let sessaoDoUsuario: string

  const auth = () => ({ cookie: sessaoDoUsuario })

  beforeAll(async () => {
    app = await buildApp(loadEnv())
    await app.ready()
    org = await seedOrg(app.db)
    sessao = await createSession(app.db, org.orgId)

    const usuario = await seedUser(app.db, org.orgId)
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: usuario.email, password: usuario.password },
    })
    if (login.statusCode !== 200) {
      throw new Error(`login falhou no setup: ${login.statusCode} ${login.body}`)
    }
    sessaoDoUsuario = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  })

  afterAll(async () => {
    await org?.cleanup()
    await app?.close()
  })

  it('cria chave sem escopo, valendo em toda a organização', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: auth(),
      payload: { name: 'sem escopo', role: 'operator' },
    })

    expect(resposta.statusCode).toBe(201)
    expect(resposta.json().key.sessionScope).toBeNull()
    expect(resposta.json().token).toMatch(/^awah_/)
  })

  it('cria chave com escopo em sessão que existe', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: auth(),
      payload: { name: 'com escopo', role: 'operator', sessionScope: [sessao] },
    })

    expect(resposta.statusCode).toBe(201)
    expect(resposta.json().key.sessionScope).toEqual([sessao])
  })

  /**
   * The regression this test prevents: a key issued against the example UUID
   * from the docs form is born valid and reaches nothing. The error only
   * showed up on the first send, as "Session not found." — which blames the
   * session and sends whoever is integrating looking in the wrong place.
   */
  it('recusa escopo apontando para sessão inexistente', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: auth(),
      payload: { name: 'escopo fantasma', role: 'operator', sessionScope: [UUID_DE_EXEMPLO] },
    })

    expect(resposta.statusCode).toBe(400)
    expect(resposta.json().error.message).toContain(UUID_DE_EXEMPLO)
  })

  it('recusa escopo vazio, que não alcançaria nenhuma sessão', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: auth(),
      payload: { name: 'escopo vazio', role: 'operator', sessionScope: [] },
    })

    expect(resposta.statusCode).toBe(400)
    expect(resposta.json().error.message).toContain('Omit')
  })

  /**
   * Scope is per organization. A session that exists, but in another org, is
   * as unreachable as one that does not exist — and the message must not tell
   * the two cases apart, or it becomes an existence probe across tenants.
   */
  it('recusa sessão de outra organização', async () => {
    const outra = await seedOrg(app.db)
    const alheia = await createSession(app.db, outra.orgId)

    try {
      const resposta = await app.inject({
        method: 'POST',
        url: '/v1/keys',
        headers: auth(),
        payload: { name: 'escopo alheio', role: 'operator', sessionScope: [alheia] },
      })

      expect(resposta.statusCode).toBe(400)
      expect(resposta.json().error.message).toContain(alheia)
    } finally {
      await outra.cleanup()
    }
  })
})
