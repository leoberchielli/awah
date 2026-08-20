import { sql } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { requireAuth } from '../../auth/plugin'
import { unauthorized } from '../../lib/errors'
import { MetricsRepository } from '../../repos/metrics'

const seriesSchema = z.object({
  metric: z.string(),
  points: z.array(z.object({ bucket: z.date(), value: z.number() })),
})

const janela = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
  sessionId: z.string().uuid().optional(),
})

export async function metricsRoutes(app: FastifyInstance) {
  const route = app.withTypeProvider<ZodTypeProvider>()

  const desde = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000)

  /**
   * Scrape do Prometheus.
   *
   * Fica fora do `/v1` e do esquema de chaves de API porque quem raspa métricas
   * é o coletor, não um integrador. A proteção é um token dedicado: sem ele, a
   * URL entregaria volume de mensagens, número de sessões e saúde da operação a
   * qualquer um que alcançasse a porta.
   */
  route.get(
    '/metrics',
    {
      schema: {
        tags: ['system'],
        summary: 'Metrics in Prometheus format',
        description:
          'Protected by METRICS_TOKEN when set. Without the token configured, it answers any request — acceptable on a closed network, risky anywhere else.',
        hide: true,
      },
    },
    async (request, reply) => {
      const esperado = app.env.METRICS_TOKEN
      if (esperado) {
        const header = request.headers.authorization
        const recebido = header?.startsWith('Bearer ') ? header.slice(7) : null
        if (recebido !== esperado) throw unauthorized('Invalid metrics token.')
      }

      await app.metrics.collect(app.db, app.sessions.activeSessionIds().length)
      return reply.type(app.metrics.contentType).send(await app.metrics.render())
    },
  )

  /**
   * Saúde de sessão.
   *
   * O uptime sai dos eventos de conexão, não de um heartbeat: o par
   * conectou/desconectou já está gravado, e derivar dali significa que o número
   * continua correto mesmo para períodos anteriores a este processo existir.
   */
  route.get(
    '/v1/kpi/sessions',
    {
      preHandler: app.requirePermission('metrics:read'),
      schema: {
        tags: ['kpi'],
        summary: 'Session health',
        querystring: janela,
        response: {
          200: z.object({
            sessions: z.array(
              z.object({
                sessionId: z.string(),
                name: z.string(),
                status: z.string(),
                disconnects: z.number(),
                reconnects: z.number(),
                lastCause: z.string().nullable(),
                lastDisconnectAt: z.date().nullable(),
                /** Tempo médio entre quedas, em minutos. Nulo sem quedas no período. */
                mtbfMinutes: z.number().nullable(),
              }),
            ),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const horas = request.query.hours

      const result = await app.db.execute(sql`
        WITH eventos AS (
          SELECT e.session_id, e.type, e.cause, e.created_at
          FROM session_events e
          WHERE e.org_id = ${auth.orgId}::uuid
            AND e.created_at >= now() - (${horas} || ' hours')::interval
        ),
        contagem AS (
          SELECT session_id,
                 count(*) FILTER (WHERE type IN ('disconnected', 'logged_out')) AS quedas,
                 count(*) FILTER (WHERE type IN ('connected', 'paired')) AS conexoes
          FROM eventos GROUP BY session_id
        ),
        ultima_queda AS (
          SELECT DISTINCT ON (session_id) session_id, cause, created_at
          FROM eventos
          WHERE type IN ('disconnected', 'logged_out')
          ORDER BY session_id, created_at DESC
        )
        SELECT s.id AS session_id, s.name, s.status,
               coalesce(c.quedas, 0) AS quedas,
               coalesce(c.conexoes, 0) AS conexoes,
               u.cause AS ultima_causa,
               u.created_at AS ultima_queda_em,
               CASE WHEN coalesce(c.quedas, 0) > 0
                    THEN (${horas} * 60.0) / c.quedas
                    ELSE NULL END AS mtbf_minutos
        FROM sessions s
        LEFT JOIN contagem c ON c.session_id = s.id
        LEFT JOIN ultima_queda u ON u.session_id = s.id
        WHERE s.org_id = ${auth.orgId}::uuid
        ORDER BY coalesce(c.quedas, 0) DESC, s.name
      `)

      return {
        sessions: [...result].map((row) => {
          const r = row as Record<string, unknown>
          return {
            sessionId: String(r.session_id),
            name: String(r.name),
            status: String(r.status),
            disconnects: Number(r.quedas ?? 0),
            reconnects: Number(r.conexoes ?? 0),
            lastCause: r.ultima_causa ? String(r.ultima_causa) : null,
            lastDisconnectAt: r.ultima_queda_em ? new Date(String(r.ultima_queda_em)) : null,
            mtbfMinutes: r.mtbf_minutos ? Number(r.mtbf_minutos) : null,
          }
        }),
      }
    },
  )

  route.get(
    '/v1/kpi/delivery',
    {
      preHandler: app.requirePermission('metrics:read'),
      schema: {
        tags: ['kpi'],
        summary: 'Deliverability',
        description:
          'ACK funnel, latencies by percentile, and queue depth. Totals come from the aggregates; the queue is current state.',
        querystring: janela,
        response: {
          200: z.object({
            funnel: z.object({
              sent: z.number(),
              delivered: z.number(),
              read: z.number(),
              failed: z.number(),
              deliveryRate: z.number().describe('delivered / sent, between 0 and 1.'),
              readRate: z.number(),
            }),
            latencyMs: z.object({
              p50: z.number().nullable(),
              p95: z.number().nullable(),
              p99: z.number().nullable(),
            }),
            queue: z.object({
              queued: z.number(),
              sending: z.number(),
              dead: z.number(),
            }),
            webhooks: z.object({ delivered: z.number(), dead: z.number() }),
            throughput: z.array(seriesSchema),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const repo = new MetricsRepository(app.db, auth.orgId)
      const since = desde(request.query.hours)
      const scope = request.query.sessionId ?? null

      const totais = await repo.totals(
        [
          'messages.outbound',
          'status.delivered',
          'status.read',
          'status.failed',
          'webhook.delivered',
          'webhook.dead',
        ],
        since,
        scope,
      )

      const sent = totais['messages.outbound'] ?? 0
      const delivered = totais['status.delivered'] ?? 0
      const read = totais['status.read'] ?? 0

      // Percentis não se somam entre sessões; a média dos baldes é a leitura honesta.
      const percentis = await repo.totals(
        ['latency.delivered.p50', 'latency.delivered.p95', 'latency.delivered.p99'],
        since,
        scope,
      )
      const baldes = await repo.series({
        metrics: ['latency.delivered.p95'],
        since,
        sessionId: scope,
      })
      const quantidadeBaldes = baldes[0]?.points.length ?? 0
      const media = (valor: number) =>
        quantidadeBaldes > 0 ? Math.round(valor / quantidadeBaldes) : null

      const fila = await app.db.execute(sql`
        SELECT status, count(*)::int AS total FROM outbox_messages
        WHERE org_id = ${auth.orgId}::uuid AND status IN ('queued', 'sending', 'dead')
        GROUP BY status
      `)
      const porStatus: Record<string, number> = { queued: 0, sending: 0, dead: 0 }
      for (const row of fila) {
        const r = row as Record<string, unknown>
        porStatus[String(r.status)] = Number(r.total)
      }

      return {
        funnel: {
          sent,
          delivered,
          read,
          failed: totais['status.failed'] ?? 0,
          deliveryRate: sent > 0 ? Number((delivered / sent).toFixed(4)) : 0,
          readRate: sent > 0 ? Number((read / sent).toFixed(4)) : 0,
        },
        latencyMs: {
          p50: media(percentis['latency.delivered.p50'] ?? 0),
          p95: media(percentis['latency.delivered.p95'] ?? 0),
          p99: media(percentis['latency.delivered.p99'] ?? 0),
        },
        queue: {
          queued: porStatus.queued ?? 0,
          sending: porStatus.sending ?? 0,
          dead: porStatus.dead ?? 0,
        },
        webhooks: {
          delivered: totais['webhook.delivered'] ?? 0,
          dead: totais['webhook.dead'] ?? 0,
        },
        throughput: await repo.series({
          metrics: ['messages.outbound', 'messages.inbound'],
          since,
          sessionId: scope,
        }),
      }
    },
  )

  route.get(
    '/v1/kpi/risk',
    {
      preHandler: app.requirePermission('metrics:read'),
      schema: {
        tags: ['kpi'],
        summary: 'Risk and anti-ban',
        querystring: janela,
        response: {
          200: z.object({
            decisions: z.object({
              allowed: z.number(),
              delayed: z.number(),
              throttled: z.number(),
              held: z.number(),
            }),
            newContacts: z.number(),
            scoreSeries: z.array(seriesSchema),
            holdSeries: z.array(seriesSchema),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const repo = new MetricsRepository(app.db, auth.orgId)
      const since = desde(request.query.hours)
      const scope = request.query.sessionId ?? null

      const totais = await repo.totals(
        ['risk.allowed', 'risk.delayed', 'risk.throttled', 'risk.held', 'contacts.new'],
        since,
        scope,
      )

      return {
        decisions: {
          allowed: totais['risk.allowed'] ?? 0,
          delayed: totais['risk.delayed'] ?? 0,
          throttled: totais['risk.throttled'] ?? 0,
          held: totais['risk.held'] ?? 0,
        },
        newContacts: totais['contacts.new'] ?? 0,
        scoreSeries: await repo.series({
          metrics: ['risk.score.avg'],
          since,
          sessionId: scope,
        }),
        holdSeries: await repo.series({
          metrics: ['risk.held', 'risk.throttled'],
          since,
          sessionId: scope,
        }),
      }
    },
  )

  /**
   * Negócio e atendimento.
   *
   * Tempo de primeira resposta é calculado sobre as conversas, não sobre as
   * mensagens: o que interessa é quanto o cliente esperou até alguém falar com
   * ele, e isso só existe no par pergunta-resposta.
   */
  route.get(
    '/v1/kpi/business',
    {
      preHandler: app.requirePermission('metrics:read'),
      schema: {
        tags: ['kpi'],
        summary: 'Business and support',
        querystring: janela,
        response: {
          200: z.object({
            volume: z.array(seriesSchema),
            activeChats: z.number(),
            responseRate: z.number().describe('Inbound conversations that got a reply.'),
            firstResponseSeconds: z.object({
              p50: z.number().nullable(),
              p95: z.number().nullable(),
            }),
            topChats: z.array(
              z.object({ chatId: z.string(), messages: z.number(), lastAt: z.date() }),
            ),
            byType: z.array(z.object({ type: z.string(), count: z.number() })),
          }),
        },
      },
    },
    async (request) => {
      const auth = requireAuth(request)
      const repo = new MetricsRepository(app.db, auth.orgId)
      const horas = request.query.hours
      const since = desde(horas)

      const resposta = await app.db.execute(sql`
        WITH conversas AS (
          SELECT chat_id,
                 count(*) AS total,
                 max(occurred_at) AS ultima,
                 count(*) FILTER (WHERE direction = 'inbound') AS recebidas,
                 count(*) FILTER (WHERE direction = 'outbound') AS enviadas
          FROM messages
          WHERE org_id = ${auth.orgId}::uuid
            AND occurred_at >= now() - (${horas} || ' hours')::interval
          GROUP BY chat_id
        ),
        primeira_resposta AS (
          SELECT m.chat_id,
                 EXTRACT(EPOCH FROM (
                   min(saida.occurred_at) - min(m.occurred_at)
                 )) AS segundos
          FROM messages m
          JOIN messages saida
            ON saida.chat_id = m.chat_id
           AND saida.org_id = m.org_id
           AND saida.direction = 'outbound'
           AND saida.occurred_at > m.occurred_at
          WHERE m.org_id = ${auth.orgId}::uuid
            AND m.direction = 'inbound'
            AND m.occurred_at >= now() - (${horas} || ' hours')::interval
          GROUP BY m.chat_id
        )
        SELECT
          (SELECT count(*) FROM conversas) AS conversas_ativas,
          (SELECT count(*) FROM conversas WHERE recebidas > 0) AS com_entrada,
          (SELECT count(*) FROM conversas WHERE recebidas > 0 AND enviadas > 0) AS respondidas,
          (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY segundos) FROM primeira_resposta) AS p50,
          (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY segundos) FROM primeira_resposta) AS p95
      `)

      const r = ([...resposta][0] ?? {}) as Record<string, unknown>
      const comEntrada = Number(r.com_entrada ?? 0)
      const respondidas = Number(r.respondidas ?? 0)

      const top = await app.db.execute(sql`
        SELECT chat_id, count(*)::int AS total, max(occurred_at) AS ultima
        FROM messages
        WHERE org_id = ${auth.orgId}::uuid
          AND occurred_at >= now() - (${horas} || ' hours')::interval
        GROUP BY chat_id ORDER BY total DESC LIMIT 10
      `)

      const tipos = await app.db.execute(sql`
        SELECT type, count(*)::int AS total
        FROM messages
        WHERE org_id = ${auth.orgId}::uuid
          AND occurred_at >= now() - (${horas} || ' hours')::interval
        GROUP BY type ORDER BY total DESC
      `)

      return {
        volume: await repo.series({
          metrics: ['messages.inbound', 'messages.outbound'],
          since,
          sessionId: request.query.sessionId ?? null,
        }),
        activeChats: Number(r.conversas_ativas ?? 0),
        responseRate: comEntrada > 0 ? Number((respondidas / comEntrada).toFixed(4)) : 0,
        firstResponseSeconds: {
          p50: r.p50 == null ? null : Math.round(Number(r.p50)),
          p95: r.p95 == null ? null : Math.round(Number(r.p95)),
        },
        topChats: [...top].map((row) => {
          const t = row as Record<string, unknown>
          return {
            chatId: String(t.chat_id),
            messages: Number(t.total),
            lastAt: new Date(String(t.ultima)),
          }
        }),
        byType: [...tipos].map((row) => {
          const t = row as Record<string, unknown>
          return { type: String(t.type), count: Number(t.total) }
        }),
      }
    },
  )
}
