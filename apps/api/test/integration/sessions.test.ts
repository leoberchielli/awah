import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { loadEnv } from '../../src/env'
import { createApiKey, createSession, type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

describe.skipIf(!hasInfra)('rotas de sessão', () => {
  let app: FastifyInstance
  let org: SeededOrg

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  beforeAll(async () => {
    app = await buildApp(loadEnv())
    await app.ready()
    org = await seedOrg(app.db)
  })

  afterAll(async () => {
    await org?.cleanup()
    await app?.close()
  })

  it('cria, lê e lista uma sessão', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(org.token),
      payload: { name: 'atendimento', engine: 'baileys' },
    })

    expect(created.statusCode).toBe(201)
    const session = created.json()
    expect(session.status).toBe('created')
    expect(session.running).toBe(false)
    expect(session.phoneNumber).toBeNull()

    const read = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${session.id}`,
      headers: auth(org.token),
    })
    expect(read.statusCode).toBe(200)
    expect(read.json().name).toBe('atendimento')

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: auth(org.token),
    })
    expect(listed.json().sessions.some((s: { id: string }) => s.id === session.id)).toBe(true)
  })

  it('recusa nome duplicado dentro da organização', async () => {
    const payload = { name: 'duplicada', engine: 'baileys' }
    await app.inject({ method: 'POST', url: '/v1/sessions', headers: auth(org.token), payload })

    const again = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(org.token),
      payload,
    })

    expect(again.statusCode).toBe(409)
    expect(again.json()).toHaveProperty('error.code', 'conflict')
  })

  it('recusa iniciar a engine oficial sem credenciais', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(org.token),
      payload: { name: 'oficial', engine: 'cloud_api' },
    })
    expect(created.statusCode).toBe(201)

    const started = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${created.json().id}/start`,
      headers: auth(org.token),
    })

    expect(started.statusCode).toBe(400)
    expect(started.json().error.message).toMatch(/credentials/i)
  })

  it('recusa engine ainda não implementada', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: auth(org.token),
      payload: { name: 'nao-oficial', engine: 'wwebjs' },
    })
    expect(created.statusCode).toBe(201)

    const started = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${created.json().id}/start`,
      headers: auth(org.token),
    })

    expect(started.statusCode).toBe(400)
    expect(started.json().error.message).toMatch(/not implemented/)
  })

  describe('credenciais da Cloud API', () => {
    async function criarOficial(): Promise<string> {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: auth(org.token),
        payload: { name: `oficial-${Math.random().toString(36).slice(2, 8)}`, engine: 'cloud_api' },
      })
      return created.json().id
    }

    const credenciais = {
      phoneNumberId: '109876543210987',
      accessToken: 'EAAG'.padEnd(48, 'x'),
      verifyToken: 'segredo-do-handshake',
      appSecret: 'segredo-do-app',
    }

    it('guarda e devolve a URL do webhook', async () => {
      const sessionId = await criarOficial()

      const salvo = await app.inject({
        method: 'PUT',
        url: `/v1/sessions/${sessionId}/credentials`,
        headers: auth(org.token),
        payload: credenciais,
      })

      expect(salvo.statusCode).toBe(200)
      expect(salvo.json().webhookUrl).toContain(`/webhooks/meta/${sessionId}`)
    })

    /**
     * O token nunca deve reaparecer em leitura: quem tem `session:read` pode
     * listar sessões sem por isso poder enviar mensagem em nome da empresa.
     */
    it('não devolve o token em nenhuma leitura da sessão', async () => {
      const sessionId = await criarOficial()

      await app.inject({
        method: 'PUT',
        url: `/v1/sessions/${sessionId}/credentials`,
        headers: auth(org.token),
        payload: credenciais,
      })

      const lida = await app.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}`,
        headers: auth(org.token),
      })

      expect(lida.body).not.toContain(credenciais.accessToken)
      expect(lida.body).not.toContain(credenciais.appSecret)
    })

    it('recusa credenciais da Meta em sessão do Baileys', async () => {
      const sessionId = await createSession(app.db, org.orgId)

      const resposta = await app.inject({
        method: 'PUT',
        url: `/v1/sessions/${sessionId}/credentials`,
        headers: auth(org.token),
        payload: credenciais,
      })

      expect(resposta.statusCode).toBe(400)
      expect(resposta.json().error.message).toMatch(/cloud_api/)
    })
  })

  it('não devolve QR quando não há pareamento em curso', async () => {
    const sessionId = await createSession(app.db, org.orgId)

    const qr = await app.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/qr`,
      headers: auth(org.token),
    })

    expect(qr.statusCode).toBe(404)
  })

  it('parar uma sessão que não está rodando é operação idempotente', async () => {
    const sessionId = await createSession(app.db, org.orgId)

    const stopped = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/stop`,
      headers: auth(org.token),
    })

    expect(stopped.statusCode).toBe(200)
  })

  it('publica a matriz de capacidades das engines', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/engines',
      headers: auth(org.token),
    })

    const engines = response.json().engines
    const baileys = engines.find((e: { engine: string }) => e.engine === 'baileys')
    const cloud = engines.find((e: { engine: string }) => e.engine === 'cloud_api')

    expect(baileys.available).toBe(true)
    expect(baileys.capabilities.groups).toBe(true)

    // A oficial existe desde a onda 7, mas com um recorte bem menor.
    expect(cloud.available).toBe(true)
    expect(cloud.capabilities.groups).toBe(false)
    expect(cloud.capabilities.qrPairing).toBe(false)
  })

  describe('isolamento entre organizações', () => {
    it('não enxerga sessão de outra org', async () => {
      const outra = await seedOrg(app.db)
      const alheia = await createSession(app.db, outra.orgId)

      try {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/sessions/${alheia}`,
          headers: auth(org.token),
        })

        expect(response.statusCode).toBe(404)
      } finally {
        await outra.cleanup()
      }
    })
  })

  describe('escopo de sessão da chave', () => {
    let permitida: string
    let proibida: string
    let escopado: string

    beforeAll(async () => {
      permitida = await createSession(app.db, org.orgId)
      proibida = await createSession(app.db, org.orgId)
      escopado = await createApiKey(app.db, org.orgId, {
        role: 'operator',
        sessionScope: [permitida],
      })
    })

    it('lista apenas as sessões do escopo', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: auth(escopado),
      })

      const ids = response.json().sessions.map((s: { id: string }) => s.id)
      expect(ids).toEqual([permitida])
    })

    /**
     * Fora do escopo responde 404 e não 403 de propósito: 403 confirmaria que a
     * sessão existe, e a existência já é informação que a chave não deve ter.
     */
    it('esconde sessão fora do escopo com 404, não 403', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/sessions/${proibida}`,
        headers: auth(escopado),
      })

      expect(response.statusCode).toBe(404)
      expect(response.json()).toHaveProperty('error.code', 'not_found')
    })

    it('bloqueia operar sessão fora do escopo', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${proibida}/stop`,
        headers: auth(escopado),
      })

      expect(response.statusCode).toBe(404)
    })

    it('permite operar a sessão do escopo', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${permitida}/stop`,
        headers: auth(escopado),
      })

      expect(response.statusCode).toBe(200)
    })

    it('não deixa uma chave de operator criar sessão', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: auth(escopado),
        payload: { name: 'nao-deveria', engine: 'baileys' },
      })

      expect(response.statusCode).toBe(403)
    })
  })
})

describe.skipIf(!hasInfra)('primeira execução', () => {
  let app: FastifyInstance

  /**
   * A organização é criada aqui, e não herdada da suíte.
   *
   * A primeira versão deste teste assumia que "sempre existe alguma org porque
   * os outros arquivos criam" — e passava na minha máquina, onde o banco de
   * desenvolvimento tem uma permanente. No CI, com banco limpo e cada arquivo
   * limpando o que criou, a suposição caiu na primeira execução.
   */
  let org: SeededOrg

  beforeAll(async () => {
    app = await buildApp(loadEnv())
    await app.ready()
    org = await seedOrg(app.db)
  })

  afterAll(async () => {
    await org?.cleanup()
    await app?.close()
  })

  /**
   * Sem esta rota o painel não tinha como saber que deve mostrar a tela de
   * setup, e o primeiro acesso caía num login que ninguém conseguia usar — com
   * a saída escondida num curl do README.
   */
  it('responde sem credencial nenhuma', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/v1/auth/bootstrap' })

    expect(resposta.statusCode).toBe(200)
    expect(resposta.json()).toHaveProperty('needsSetup')
    expect(resposta.json()).toHaveProperty('openRegistration')
  })

  it('diz que já foi inicializada quando existe organização', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/v1/auth/bootstrap' })
    expect(resposta.json().needsSetup).toBe(false)
  })

  it('o registro fica fechado depois da primeira organização', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        organizationName: 'Tentativa',
        name: 'Alguém',
        email: `tarde-${Date.now()}@exemplo.com`,
        password: 'uma-senha-bem-longa-mesmo',
      },
    })

    expect(resposta.statusCode).toBe(403)
  })
})
