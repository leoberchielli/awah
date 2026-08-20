import { type Database, sql } from '@awah/db'
import type { ManagerLogger } from '../sessions/manager'

export interface AggregatorDeps {
  db: Database
  logger: ManagerLogger
  intervalMs: number
  /**
   * How many hours to recompute on each pass.
   *
   * Aggregating the current hour is not enough: a read ACK arrives hours after
   * the send, and a webhook in retry can finish well past the hour it was born
   * in. Recomputing a window moves those numbers into the right bucket instead
   * of losing them.
   */
  lookbackHours: number
}

/**
 * Materialization of the hourly aggregates.
 *
 * The dashboard reads from `metrics_hourly` and nothing else. Scanning the raw
 * tables on every panel load is the mistake that turns observability into a
 * database incident: the messages table grows without a ceiling, and an hourly
 * `count(*)` over thirty days takes Postgres down at exactly the moment someone
 * is trying to work out why the operation went down.
 *
 * Every query is an idempotent upsert — reprocessing the same window produces
 * the same result, so a missed pass fixes itself on the next one.
 */
export class MetricsAggregator {
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private running = false

  constructor(private readonly deps: AggregatorDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    // First pass right at boot, so the panel does not come up empty.
    void this.aggregate().finally(() => this.scheduleNext())
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.aggregate().finally(() => this.scheduleNext())
    }, this.deps.intervalMs)
    this.timer.unref()
  }

  /**
   * Runs one full pass.
   *
   * Several replicas aggregate the same window at the same time and reach the
   * same result — the upsert makes the concurrency harmless, which removes the
   * need for coordination between nodes on a task that does not need it.
   */
  async aggregate(): Promise<void> {
    /**
     * The guard is only against re-entrancy — a slow pass must not overlap the
     * next one. Gating on the loop's state as well would make this method
     * uncallable outside it, and it has to work on its own: in a test, from an
     * admin route, or in a one-off reprocessing job.
     */
    if (this.running) return
    this.running = true

    const hours = this.deps.lookbackHours

    /**
     * Each aggregation isolated in its own error handling.
     *
     * With a single `try` around all of them, the first failure aborted the
     * rest in silence — and the symptom was a metric missing from the panel,
     * with nothing in the log pointing at the cause. Isolating trades "I lost
     * everything after the error" for "I lost only the one that broke, and I
     * know which".
     */
    const etapas: Array<[string, () => Promise<void>]> = [
      ['volume', () => this.messageVolume(hours)],
      ['status', () => this.statusTrail(hours)],
      ['latencia', () => this.deliveryLatency(hours)],
      ['sessoes', () => this.sessionEvents(hours)],
      ['risco', () => this.riskDecisions(hours)],
      ['webhooks', () => this.entregaDeWebhooks(hours)],
      ['contatos', () => this.newContacts(hours)],
    ]

    try {
      for (const [name, executar] of etapas) {
        try {
          await executar()
        } catch (error) {
          this.deps.logger.error({ err: error, etapa: name }, 'failed to aggregate metric')
        }
      }
    } finally {
      this.running = false
    }
  }

  /** Sent and received, per hour. */
  private async messageVolume(hours: number): Promise<void> {
    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, date_trunc('hour', occurred_at),
             'messages.' || direction, count(*)::double precision
      FROM messages
      WHERE occurred_at >= now() - (${hours} || ' hours')::interval
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /**
   * ACK funnel, counted by the instant of the event and not that of the
   * message: a read today on yesterday's message belongs to the hour of the
   * read.
   */
  private async statusTrail(hours: number): Promise<void> {
    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT e.org_id, m.session_id, date_trunc('hour', e.occurred_at),
             'status.' || e.status, count(*)::double precision
      FROM message_status_events e
      JOIN messages m ON m.id = e.message_id
      WHERE e.occurred_at >= now() - (${hours} || ' hours')::interval
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /**
   * Latency percentiles up to delivery.
   *
   * An average would mislead here: the distribution has a long tail — most
   * arrive in seconds and a few take minutes because the recipient had no
   * network. The average hides that behavior; the p95 shows it.
   */
  private async deliveryLatency(hours: number): Promise<void> {
    await this.deps.db.execute(sql`
      WITH latencias AS (
        SELECT m.org_id, m.session_id,
               date_trunc('hour', m.occurred_at) AS bucket,
               EXTRACT(EPOCH FROM (e.occurred_at - m.occurred_at)) * 1000 AS ms
        FROM messages m
        JOIN message_status_events e
          ON e.message_id = m.id AND e.status = 'delivered'
        WHERE m.direction = 'outbound'
          AND m.occurred_at >= now() - (${hours} || ' hours')::interval
          AND e.occurred_at >= m.occurred_at
      )
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, bucket, metrica, valor FROM (
        SELECT org_id, session_id, bucket,
               'latency.delivered.p50' AS metrica,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS valor
        FROM latencias GROUP BY 1, 2, 3
        UNION ALL
        SELECT org_id, session_id, bucket, 'latency.delivered.p95',
               percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)
        FROM latencias GROUP BY 1, 2, 3
        UNION ALL
        SELECT org_id, session_id, bucket, 'latency.delivered.p99',
               percentile_cont(0.99) WITHIN GROUP (ORDER BY ms)
        FROM latencias GROUP BY 1, 2, 3
      ) percentis
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /** Connects and drops — the basis of uptime and MTBF per session. */
  private async sessionEvents(hours: number): Promise<void> {
    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, date_trunc('hour', created_at),
             'session.' || type, count(*)::double precision
      FROM session_events
      WHERE created_at >= now() - (${hours} || ' hours')::interval
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /** How much the risk engine held, delayed or let through. */
  private async riskDecisions(hours: number): Promise<void> {
    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, date_trunc('hour', created_at),
             'risk.' || action, count(*)::double precision
      FROM risk_events
      WHERE created_at >= now() - (${hours} || ' hours')::interval
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)

    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, date_trunc('hour', created_at),
             'risk.score.avg', avg(score)::double precision
      FROM risk_events
      WHERE created_at >= now() - (${hours} || ' hours')::interval
      GROUP BY 1, 2, 3
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /** Webhook deliveries by outcome. `session_id` stays null: it is an org metric. */
  private async entregaDeWebhooks(hours: number): Promise<void> {
    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, NULL::uuid, date_trunc('hour', created_at),
             'webhook.' || status, count(*)::double precision
      FROM webhook_deliveries
      WHERE created_at >= now() - (${hours} || ' hours')::interval
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /**
   * Recipients contacted for the first time, per hour.
   *
   * The strongest signal of a mass blast, and the same one the risk engine caps
   * — having it in the history makes it possible to compare behavior before and
   * after a limit is adjusted.
   */
  private async newContacts(hours: number): Promise<void> {
    await this.deps.db.execute(sql`
      WITH primeiro_contato AS (
        SELECT org_id, session_id, chat_id, min(occurred_at) AS iniciado_em
        FROM messages
        WHERE direction = 'outbound'
        GROUP BY 1, 2, 3
      )
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, date_trunc('hour', iniciado_em),
             'contacts.new', count(*)::double precision
      FROM primeiro_contato
      WHERE iniciado_em >= now() - (${hours} || ' hours')::interval
      GROUP BY 1, 2, 3
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }
}
