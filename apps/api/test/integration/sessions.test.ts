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
    async function createOfficialSession(): Promise<string> {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: auth(org.token),
        payload: { name: `oficial-${Math.random().toString(36).slice(2, 8)}`, engine: 'cloud_api' },
      })
      return created.json().id
    }

    const credentials = {
      phoneNumberId: '109876543210987',
      accessToken: 'EAAG'.padEnd(48, 'x'),
      verifyToken: 'segredo-do-handshake',
      appSecret: 'segredo-do-app',
    }

    it('guarda e devolve a URL do webhook', async () => {
      const sessionId = await createOfficialSession()

      const saved = await app.inject({
        method: 'PUT',
        url: `/v1/sessions/${sessionId}/credentials`,
        headers: auth(org.token),
        payload: credentials,
      })

      expect(saved.statusCode).toBe(200)
      expect(saved.json().webhookUrl).toContain(`/webhooks/meta/${sessionId}`)
    })

    /**
     * The token must never reappear on a read: someone with `session:read` can
     * list sessions without thereby being able to send messages in the
     * company's name.
     */
    it('não devolve o token em nenhuma leitura da sessão', async () => {
      const sessionId = await createOfficialSession()

      await app.inject({
        method: 'PUT',
        url: `/v1/sessions/${sessionId}/credentials`,
        headers: auth(org.token),
        payload: credentials,
      })

      const readBack = await app.inject({
        method: 'GET',
        url: `/v1/sessions/${sessionId}`,
        headers: auth(org.token),
      })

      expect(readBack.body).not.toContain(credentials.accessToken)
      expect(readBack.body).not.toContain(credentials.appSecret)
    })

    it('recusa credenciais da Meta em sessão do Baileys', async () => {
      const sessionId = await createSession(app.db, org.orgId)

      const response = await app.inject({
        method: 'PUT',
        url: `/v1/sessions/${sessionId}/credentials`,
        headers: auth(org.token),
        payload: credentials,
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error.message).toMatch(/cloud_api/)
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

    // The official one has been around since wave 7, with a much smaller slice.
    expect(cloud.available).toBe(true)
    expect(cloud.capabilities.groups).toBe(false)
    expect(cloud.capabilities.qrPairing).toBe(false)
  })

  describe('isolamento entre organizações', () => {
    it('não enxerga sessão de outra org', async () => {
      const other = await seedOrg(app.db)
      const foreign = await createSession(app.db, other.orgId)

      try {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/sessions/${foreign}`,
          headers: auth(org.token),
        })

        expect(response.statusCode).toBe(404)
      } finally {
        await other.cleanup()
      }
    })
  })

  describe('escopo de sessão da chave', () => {
    let allowed: string
    let forbidden: string
    let scopedKey: string

    beforeAll(async () => {
      allowed = await createSession(app.db, org.orgId)
      forbidden = await createSession(app.db, org.orgId)
      scopedKey = await createApiKey(app.db, org.orgId, {
        role: 'operator',
        sessionScope: [allowed],
      })
    })

    it('lista apenas as sessões do escopo', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: auth(scopedKey),
      })

      const ids = response.json().sessions.map((s: { id: string }) => s.id)
      expect(ids).toEqual([allowed])
    })

    /**
     * Out of scope answers 404 and not 403 on purpose: a 403 would confirm the
     * session exists, and its existence is already information this key must
     * not have.
     */
    it('esconde sessão fora do escopo com 404, não 403', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/sessions/${forbidden}`,
        headers: auth(scopedKey),
      })

      expect(response.statusCode).toBe(404)
      expect(response.json()).toHaveProperty('error.code', 'not_found')
    })

    it('bloqueia operar sessão fora do escopo', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${forbidden}/stop`,
        headers: auth(scopedKey),
      })

      expect(response.statusCode).toBe(404)
    })

    it('permite operar a sessão do escopo', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/sessions/${allowed}/stop`,
        headers: auth(scopedKey),
      })

      expect(response.statusCode).toBe(200)
    })

    it('não deixa uma chave de operator criar sessão', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: auth(scopedKey),
        payload: { name: 'nao-deveria', engine: 'baileys' },
      })

      expect(response.statusCode).toBe(403)
    })
  })
})

describe.skipIf(!hasInfra)('primeira execução', () => {
  let app: FastifyInstance

  /**
   * The organization is created here, not inherited from the suite.
   *
   * The first version of this test assumed "there is always some org because
   * the other files create one" — and it passed on my machine, where the dev
   * database has a permanent one. On CI, with a clean database and every file
   * cleaning up what it created, the assumption fell on the first run.
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
   * Without this route the panel had no way to know it should show the setup
   * screen, and the first visit landed on a login nobody could use — with the
   * way out buried in a curl command in the README.
   */
  it('responde sem credencial nenhuma', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/bootstrap' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toHaveProperty('needsSetup')
    expect(response.json()).toHaveProperty('openRegistration')
  })

  it('diz que já foi inicializada quando existe organização', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/auth/bootstrap' })
    expect(response.json().needsSetup).toBe(false)
  })

  it('o registro fica fechado depois da primeira organização', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        organizationName: 'Tentativa',
        name: 'Alguém',
        email: `tarde-${Date.now()}@exemplo.com`,
        password: 'uma-senha-bem-longa-mesmo',
      },
    })

    expect(response.statusCode).toBe(403)
  })
})
