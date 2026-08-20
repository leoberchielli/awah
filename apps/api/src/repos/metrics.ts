import { and, desc, eq, gte, inArray, schema, sql } from '@awah/db'
import { TenantRepository } from './base'

export interface SeriesPoint {
  bucket: Date
  value: number
}

export interface MetricSeries {
  metric: string
  points: SeriesPoint[]
}

/**
 * Reads of the hourly aggregates.
 *
 * Every query from here is indexed by `(org_id, metric, bucket)` and returns
 * tens of rows, not millions — that is the contract that keeps the dashboard
 * fast as the database grows.
 */
export class MetricsRepository extends TenantRepository {
  /** Time series for one or more metrics, optionally per session. */
  async series(input: {
    metrics: string[]
    since: Date
    sessionId?: string | null
  }): Promise<MetricSeries[]> {
    if (input.metrics.length === 0) return []

    const filtros = [
      eq(schema.metricsHourly.orgId, this.orgId),
      inArray(schema.metricsHourly.metric, input.metrics),
      gte(schema.metricsHourly.bucket, input.since),
    ]

    if (input.sessionId) {
      filtros.push(eq(schema.metricsHourly.sessionId, input.sessionId))
    }

    const rows = await this.db
      .select({
        metric: schema.metricsHourly.metric,
        bucket: schema.metricsHourly.bucket,
        value: schema.metricsHourly.value,
      })
      .from(schema.metricsHourly)
      .where(and(...filtros))
      .orderBy(schema.metricsHourly.bucket)

    /**
     * With no session filter, there is one row per session in each bucket.
     * Summing is the right behavior for counts — which is what practically
     * every metric here is. Percentiles are the exception, and that is why they
     * have a route of their own, always per session.
     */
    const agrupado = new Map<string, Map<number, number>>()

    for (const row of rows) {
      const porMetrica = agrupado.get(row.metric) ?? new Map<number, number>()
      const chave = row.bucket.getTime()
      porMetrica.set(chave, (porMetrica.get(chave) ?? 0) + row.value)
      agrupado.set(row.metric, porMetrica)
    }

    return [...agrupado.entries()].map(([metric, pontos]) => ({
      metric,
      points: [...pontos.entries()]
        .sort(([a], [b]) => a - b)
        .map(([bucket, value]) => ({ bucket: new Date(bucket), value })),
    }))
  }

  /** Sum of one metric over the period. */
  async total(metric: string, since: Date, sessionId?: string | null): Promise<number> {
    const filtros = [
      eq(schema.metricsHourly.orgId, this.orgId),
      eq(schema.metricsHourly.metric, metric),
      gte(schema.metricsHourly.bucket, since),
    ]
    if (sessionId) filtros.push(eq(schema.metricsHourly.sessionId, sessionId))

    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${schema.metricsHourly.value}), 0)` })
      .from(schema.metricsHourly)
      .where(and(...filtros))

    return Number(row?.total ?? 0)
  }

  /** Several totals in one query, to build a panel without N trips to the database. */
  async totals(
    metrics: string[],
    since: Date,
    sessionId?: string | null,
  ): Promise<Record<string, number>> {
    if (metrics.length === 0) return {}

    const filtros = [
      eq(schema.metricsHourly.orgId, this.orgId),
      inArray(schema.metricsHourly.metric, metrics),
      gte(schema.metricsHourly.bucket, since),
    ]
    if (sessionId) filtros.push(eq(schema.metricsHourly.sessionId, sessionId))

    const rows = await this.db
      .select({
        metric: schema.metricsHourly.metric,
        total: sql<number>`coalesce(sum(${schema.metricsHourly.value}), 0)`,
      })
      .from(schema.metricsHourly)
      .where(and(...filtros))
      .groupBy(schema.metricsHourly.metric)

    const resultado: Record<string, number> = {}
    for (const metric of metrics) resultado[metric] = 0
    for (const row of rows) resultado[row.metric] = Number(row.total)
    return resultado
  }

  /** Last known value of a metric, per session. */
  async latestBySession(metric: string, since: Date): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        sessionId: schema.metricsHourly.sessionId,
        bucket: schema.metricsHourly.bucket,
        value: schema.metricsHourly.value,
      })
      .from(schema.metricsHourly)
      .where(
        and(
          eq(schema.metricsHourly.orgId, this.orgId),
          eq(schema.metricsHourly.metric, metric),
          gte(schema.metricsHourly.bucket, since),
        ),
      )
      .orderBy(desc(schema.metricsHourly.bucket))

    const ultimo = new Map<string, number>()
    for (const row of rows) {
      if (row.sessionId && !ultimo.has(row.sessionId)) {
        ultimo.set(row.sessionId, row.value)
      }
    }
    return ultimo
  }
}
