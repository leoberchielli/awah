import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { loadEnv } from '../../src/env'
import { createSession, type SeededOrg, seedOrg, seedUser } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

/** UUID de exemplo que o Swagger UI sugere para qualquer campo `format: uuid`. */
const UUID_DE_EXEMPLO = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

describe.skipIf(!hasInfra)('criação de chave de API', () => {
  let app: FastifyInstance
  let org: SeededOrg
  let sessao: string
  /**
   * Cookie de sessão de usuário, e não chave de API: emitir chave é
   * administração de identidade, e chave de API não faz isso por design.
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
   * A regressão que este teste impede: uma chave emitida contra o UUID de
   * exemplo do formulário da documentação nasce válida e não alcança nada. O
   * erro só aparecia no primeiro envio, como "Sessão não encontrada" — que
   * culpa a sessão e manda quem está integrando procurar no lugar errado.
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
   * Escopo é por organização. Uma sessão que existe, mas em outra org, é tão
   * inalcançável quanto uma que não existe — e a mensagem não deve distinguir
   * os dois casos, senão vira sonda de existência entre inquilinos.
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
