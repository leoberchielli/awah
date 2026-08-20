import { type Database, sql } from '@awah/db'
import { exponentialBackoff } from '../lib/backoff'
import type { ManagerLogger } from '../sessions/manager'
import { SIGNATURE_HEADER, sign, TIMESTAMP_HEADER } from './signature'

export interface WebhookDispatcherDeps {
  db: Database
  logger: ManagerLogger
  intervalMs: number
  batchSize: number
  requestTimeoutMs: number
  /** Outcome and duration of each attempt, for metrics. */
  observeDelivery?: (outcome: 'delivered' | 'retrying' | 'dead', seconds: number) => void
}

interface PendingDelivery {
  id: string
  url: string
  secret: string
  eventType: string
  payload: unknown
  attempts: number
  maxAttempts: number
}

/**
 * Webhook delivery with retries and a dead-letter queue.
 *
 * It exists for the same reason the outbox does: a webhook fired and forgotten
 * is an event lost in silence. The integrator finds out weeks later that
 * messages are missing, with no trace of where they went.
 */
export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private ticking = false

  constructor(private readonly deps: WebhookDispatcherDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.scheduleNext()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext())
    }, this.deps.intervalMs)
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return
    this.ticking = true

    try {
      const pending = await this.claim()
      if (pending.length === 0) return
      await Promise.allSettled(pending.map((delivery) => this.deliver(delivery)))
    } catch (error) {
      this.deps.logger.error({ err: error }, 'webhook cycle failed')
    } finally {
      this.ticking = false
    }
  }

  /** Same strategy as the outbox: the conditional UPDATE is what guarantees exclusivity. */
  private async claim(): Promise<PendingDelivery[]> {
    const result = await this.deps.db.execute(sql`
      UPDATE webhook_deliveries d
      SET status = 'delivering', attempts = d.attempts + 1
      FROM webhooks w
      WHERE d.webhook_id = w.id
        AND w.active = true
        AND d.status IN ('pending', 'retrying')
        AND d.id IN (
          SELECT id FROM webhook_deliveries
          WHERE status IN ('pending', 'retrying')
            AND available_at <= now()
          ORDER BY created_at
          LIMIT ${this.deps.batchSize}
        )
      RETURNING d.id, d.event_type, d.payload, d.attempts, d.max_attempts, w.url, w.secret
    `)

    return [...result].map((row) => {
      const r = row as Record<string, unknown>
      return {
        id: String(r.id),
        url: String(r.url),
        secret: String(r.secret),
        eventType: String(r.event_type),
        payload: r.payload,
        attempts: Number(r.attempts),
        maxAttempts: Number(r.max_attempts),
      }
    })
  }

  private async deliver(delivery: PendingDelivery): Promise<void> {
    const body = JSON.stringify({
      event: delivery.eventType,
      data: delivery.payload,
      deliveryId: delivery.id,
    })
    const timestamp = Math.floor(Date.now() / 1000)

    const startedAt = Date.now()
    const elapsed = () => (Date.now() - startedAt) / 1000

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.deps.requestTimeoutMs)

    try {
      const response = await fetch(delivery.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: sign(body, delivery.secret, timestamp),
          [TIMESTAMP_HEADER]: String(timestamp),
          'user-agent': 'awah-webhooks/1',
        },
        body,
        signal: controller.signal,
      })

      if (response.ok) {
        await this.markDelivered(delivery.id, response.status)
        this.deps.observeDelivery?.('delivered', elapsed())
        return
      }

      /**
       * A 4xx that is neither 408 nor 429 is an error in the payload or in the
       * route: repeating does not fix it and only burns an attempt. Straight to
       * the dead-letter queue.
       */
      const permanent =
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408 &&
        response.status !== 429

      const outcome = await this.markFailed(
        delivery,
        `HTTP ${response.status}`,
        response.status,
        (await response.text().catch(() => '')).slice(0, 1000),
        permanent,
      )
      this.deps.observeDelivery?.(outcome, elapsed())
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? `tempo esgotado após ${this.deps.requestTimeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error)

      const outcome = await this.markFailed(delivery, message, null, null, false)
      this.deps.observeDelivery?.(outcome, elapsed())
    } finally {
      clearTimeout(timeout)
    }
  }

  private async markDelivered(id: string, status: number): Promise<void> {
    await this.deps.db.execute(sql`
      UPDATE webhook_deliveries
      SET status = 'delivered', response_status = ${status}, delivered_at = now(), last_error = NULL
      WHERE id = ${id}::uuid
    `)
  }

  private async markFailed(
    delivery: PendingDelivery,
    error: string,
    responseStatus: number | null,
    responseBody: string | null,
    permanent: boolean,
  ): Promise<'retrying' | 'dead'> {
    const exhausted = permanent || delivery.attempts >= delivery.maxAttempts
    const delay = exponentialBackoff({
      attempt: delivery.attempts,
      baseMs: 5000,
      capMs: 3_600_000,
    })

    await this.deps.db.execute(sql`
      UPDATE webhook_deliveries
      SET status = ${exhausted ? 'dead' : 'retrying'}::webhook_delivery_status,
          last_error = ${error.slice(0, 1000)},
          response_status = ${responseStatus},
          response_body = ${responseBody},
          available_at = ${exhausted ? sql`available_at` : sql`now() + (${delay} || ' milliseconds')::interval`}
      WHERE id = ${delivery.id}::uuid
    `)

    if (exhausted) {
      this.deps.logger.error(
        { deliveryId: delivery.id, attempts: delivery.attempts, error, permanent },
        'webhook went to the dead-letter queue',
      )
    }

    return exhausted ? 'dead' : 'retrying'
  }
}
