import { randomUUID } from 'node:crypto'
import { and, createDb, type Database, eq, schema } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { loadEnv } from '../../src/env'
import { MetricsAggregator } from '../../src/telemetry/aggregator'
import { createApiKey, createSession, type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

const silencioso = { info: () => {}, warn: () => {}, error: () => {} }

describe.skipIf(!hasInfra)('telemetria', () => {
  let handle: ReturnType<typeof createDb>
  let db: Database
  let org: SeededOrg
  let sessionId: string
  let token: string
  let app: FastifyInstance

  /** One hour ago: falls in a closed bucket, not hostage to the clock's edge. */
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

  beforeAll(async () => {
    handle = createDb({ url: process.env.DATABASE_URL as string, max: 3 })
    db = handle.db
    org = await seedOrg(db)
    sessionId = await createSession(db, org.orgId)
    token = await createApiKey(db, org.orgId, { role: 'admin' })

    // Two outbound and one inbound, with a delivery ACK to yield a latency figure.
    const sent = await db
      .insert(schema.messages)
      .values([
        {
          orgId: org.orgId,
          sessionId,
          chatId: '5511900000001@s.whatsapp.net',
          engineMessageId: randomUUID(),
          direction: 'outbound',
          type: 'text',
          status: 'delivered',
          occurredAt: oneHourAgo,
        },
        {
          orgId: org.orgId,
          sessionId,
          chatId: '5511900000002@s.whatsapp.net',
          engineMessageId: randomUUID(),
          direction: 'outbound',
          type: 'text',
          status: 'sent',
          occurredAt: oneHourAgo,
        },
        {
          orgId: org.orgId,
          sessionId,
          chatId: '5511900000001@s.whatsapp.net',
          engineMessageId: randomUUID(),
          direction: 'inbound',
          type: 'text',
          status: 'delivered',
          occurredAt: new Date(oneHourAgo.getTime() - 60_000),
        },
      ])
      .returning({ id: schema.messages.id })

    const first = sent[0]
    if (first) {
      await db.insert(schema.messageStatusEvents).values({
        orgId: org.orgId,
        messageId: first.id,
        status: 'delivered',
        // Five seconds to delivery.
        occurredAt: new Date(oneHourAgo.getTime() + 5000),
      })
    }

    await db.insert(schema.riskEvents).values({
      orgId: org.orgId,
      sessionId,
      action: 'held',
      score: 62,
      reason: 'Teto por minuto atingido',
      createdAt: oneHourAgo,
    })

    await db.insert(schema.sessionEvents).values({
      orgId: org.orgId,
      sessionId,
      type: 'disconnected',
      rawCode: 428,
      cause: 'Connection closed',
      createdAt: oneHourAgo,
    })

    await new MetricsAggregator({
      db,
      logger: silencioso,
      intervalMs: 999_999,
      lookbackHours: 6,
    }).aggregate()

    app = await buildApp(loadEnv())
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await org?.cleanup()
    await handle?.close()
  })

  const metric = async (name: string) => {
    const [row] = await db
      .select({ value: schema.metricsHourly.value })
      .from(schema.metricsHourly)
      .where(and(eq(schema.metricsHourly.orgId, org.orgId), eq(schema.metricsHourly.metric, name)))
    return row?.value ?? null
  }

  describe('agregação horária', () => {
    it('conta o volume por direção', async () => {
      expect(await metric('messages.outbound')).toBe(2)
      expect(await metric('messages.inbound')).toBe(1)
    })

    it('conta a trilha de ACK', async () => {
      expect(await metric('status.delivered')).toBe(1)
    })

    it('calcula percentis de latência', async () => {
      // A single ACK, five seconds: every percentile comes out the same.
      expect(await metric('latency.delivered.p50')).toBe(5000)
      expect(await metric('latency.delivered.p95')).toBe(5000)
    })

    it('conta decisões de risco e o score médio', async () => {
      expect(await metric('risk.held')).toBe(1)
      expect(await metric('risk.score.avg')).toBe(62)
    })

    it('conta quedas de sessão', async () => {
      expect(await metric('session.disconnected')).toBe(1)
    })

    it('conta contatos novos pela primeira saída de cada conversa', async () => {
      expect(await metric('contacts.new')).toBe(2)
    })

    /**
     * The property that lets every replica aggregate the same window without
     * coordination, and that makes a missed pass fix itself on the next one.
     */
    it('reprocessar a mesma janela não duplica nada', async () => {
      await new MetricsAggregator({
        db,
        logger: silencioso,
        intervalMs: 999_999,
        lookbackHours: 6,
      }).aggregate()

      expect(await metric('messages.outbound')).toBe(2)

      const rows = await db
        .select({ id: schema.metricsHourly.id })
        .from(schema.metricsHourly)
        .where(
          and(
            eq(schema.metricsHourly.orgId, org.orgId),
            eq(schema.metricsHourly.metric, 'messages.outbound'),
          ),
        )
      expect(rows).toHaveLength(1)
    })
  })

  describe('rotas de KPI', () => {
    const auth = () => ({ authorization: `Bearer ${token}` })

    it('entregabilidade traz funil, latência e fila', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/kpi/delivery?hours=6',
        headers: auth(),
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.funnel.sent).toBe(2)
      expect(body.funnel.delivered).toBe(1)
      expect(body.funnel.deliveryRate).toBe(0.5)
      expect(body.latencyMs.p95).toBe(5000)
      expect(body.queue).toHaveProperty('dead')
    })

    it('risco traz decisões e séries', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/kpi/risk?hours=6',
        headers: auth(),
      })

      const body = res.json()
      expect(body.decisions.held).toBe(1)
      expect(body.newContacts).toBe(2)
      expect(Array.isArray(body.scoreSeries)).toBe(true)
    })

    it('saúde de sessão traz quedas com causa traduzida', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/kpi/sessions?hours=6',
        headers: auth(),
      })

      const session = res
        .json()
        .sessions.find((s: { sessionId: string }) => s.sessionId === sessionId)
      expect(session.disconnects).toBe(1)
      expect(session.lastCause).toBe('Connection closed')
      expect(session.mtbfMinutes).toBeGreaterThan(0)
    })

    it('negócio traz conversas ativas e tempo de primeira resposta', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/kpi/business?hours=6',
        headers: auth(),
      })

      const body = res.json()
      expect(body.activeChats).toBe(2)
      // One inbound followed by an outbound a minute later.
      expect(body.firstResponseSeconds.p50).toBe(60)
      expect(body.responseRate).toBe(1)
      expect(body.byType.some((t: { type: string }) => t.type === 'text')).toBe(true)
    })

    it('exige permissão de leitura de métricas', async () => {
      const withoutPermission = await createApiKey(db, org.orgId, { role: 'viewer' })
      const res = await app.inject({
        method: 'GET',
        url: '/v1/kpi/delivery',
        headers: { authorization: `Bearer ${withoutPermission}` },
      })
      // viewer reaches metrics:read; the route must not be open to the unauthenticated.
      expect(res.statusCode).toBe(200)

      const anonima = await app.inject({ method: 'GET', url: '/v1/kpi/delivery' })
      expect(anonima.statusCode).toBe(401)
    })
  })

  describe('endpoint Prometheus', () => {
    it('responde no formato de exposição', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics' })

      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/plain')
      expect(res.body).toContain('awah_sessions')
      expect(res.body).toContain('# HELP')
      expect(res.body).toContain('# TYPE')
    })

    it('rotula todas as séries com o nó', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics' })
      expect(res.body).toContain('node=')
    })

    it('inclui métricas de processo', async () => {
      const res = await app.inject({ method: 'GET', url: '/metrics' })
      expect(res.body).toMatch(/awah_process_|awah_nodejs_/)
    })
  })
})
