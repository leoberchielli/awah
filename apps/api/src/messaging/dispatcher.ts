import type { Database } from '@awah/db'
import { exponentialBackoff } from '../lib/backoff'
import type { RiskDecision, RiskEngine } from '../risk/engine'
import type { ManagerLogger, SessionManager } from '../sessions/manager'
import { annotate, withSpan } from '../telemetry/tracing'
import {
  type ClaimedJob,
  claimOutbox,
  hold,
  markFailed,
  markSent,
  recoverStuck,
  release,
} from './queue'

export interface DispatcherDeps {
  db: Database
  sessions: SessionManager
  risk: RiskEngine
  /**
   * Duration observation, declared as a plain function so the scheduler never
   * has to know which metrics format is in use.
   */
  observeSend?: (result: 'sent' | 'failed' | 'held', seconds: number) => void
  logger: ManagerLogger
  intervalMs: number
  batchSize: number
  /** Ceiling on simultaneous sends on this node, across all sessions. */
  maxConcurrent: number
  /** A send stuck in 'sending' past this came from a process that died. */
  stuckAfterMs: number
  onDelivered: (job: ClaimedJob, engineMessageId: string, sentAt: Date) => Promise<void>
  onDead: (job: ClaimedJob, error: string) => Promise<void>
  /** Records the risk engine's decision for auditing. */
  onRiskDecision: (job: ClaimedJob, decision: RiskDecision) => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Send scheduler.
 *
 * The loop claims batches and fires the deliveries **without awaiting them**.
 * The distinction is essential once the risk engine is in the path: a delivery
 * can sit still for a minute on purpose, between the human jitter and the
 * typing time, and awaiting it inside the cycle would stall every other chat
 * along with it. What bounds the parallelism is the concurrency ceiling, not
 * how long each send takes.
 */
export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private claiming = false
  private ticksSinceRecovery = 0
  /** Deliveries in flight, by outbox id. */
  private readonly inFlight = new Set<string>()

  constructor(private readonly deps: DispatcherDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.scheduleNext()
  }

  /** Stops claiming and waits for what is already in flight to finish. */
  async stop(timeoutMs = 15_000): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    const limit = Date.now() + timeoutMs
    while (this.inFlight.size > 0 && Date.now() < limit) {
      await sleep(100)
    }

    if (this.inFlight.size > 0) {
      this.deps.logger.warn(
        { emVoo: this.inFlight.size },
        'shutting down with deliveries in flight; the next node will recover them',
      )
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext())
    }, this.deps.intervalMs)
  }

  private async tick(): Promise<void> {
    if (this.claiming || this.stopped) return
    this.claiming = true

    try {
      if (++this.ticksSinceRecovery >= 30) {
        this.ticksSinceRecovery = 0
        const recovered = await recoverStuck(this.deps.db, this.deps.stuckAfterMs)
        if (recovered > 0) {
          this.deps.logger.warn({ recovered }, 'stuck sends returned to the queue')
        }
      }

      const capability = this.deps.maxConcurrent - this.inFlight.size
      if (capability <= 0) return

      const sessionIds = this.deps.sessions.activeSessionIds()
      if (sessionIds.length === 0) return

      const jobs = await claimOutbox(
        this.deps.db,
        sessionIds,
        Math.min(this.deps.batchSize, capability),
      )

      for (const job of jobs) {
        this.inFlight.add(job.id)
        void this.deliver(job)
          .catch((error) => {
            this.deps.logger.error({ err: error, outboxId: job.id }, 'delivery threw')
          })
          .finally(() => this.inFlight.delete(job.id))
      }
    } catch (error) {
      this.deps.logger.error({ err: error }, 'scheduler cycle failed')
    } finally {
      this.claiming = false
    }
  }

  private async deliver(job: ClaimedJob): Promise<void> {
    return withSpan(
      'awah.outbox.deliver',
      {
        'awah.session_id': job.sessionId,
        'awah.chat_id': job.chatId,
        'awah.outbox_id': job.id,
        'awah.attempt': job.attempts + 1,
      },
      () => this.doDeliver(job),
    )
  }

  private async doDeliver(job: ClaimedJob): Promise<void> {
    const iniciadoEm = Date.now()
    const elapsed = () => (Date.now() - iniciadoEm) / 1000
    const adapter = this.deps.sessions.adapterFor(job.sessionId)

    /**
     * A missing or not-yet-paired session puts the send back in the queue
     * without consuming an attempt. Being unavailable is not a delivery
     * failure: counting it as one would kill perfectly valid messages in the
     * DLQ while the operator is still scanning the QR.
     */
    if (!adapter?.isReady()) {
      await release(this.deps.db, job.id)
      return
    }

    const text = typeof job.payload.text === 'string' ? job.payload.text : null
    if (!text) {
      await markFailed(this.deps.db, job.id, 'payload has no text field', 0)
      return
    }

    /**
     * The risk engine sits exactly here: after the claim, before the engine.
     *
     * That position is what makes the promise in §2 possible — the message is
     * already persisted and claimed, so holding it loses nothing, and letting
     * it go later does not require the client to send again.
     */
    const bypass = job.payload.bypassRisk === true
    const decision = await this.deps.risk.evaluate({
      sessionId: job.sessionId,
      chatId: job.chatId,
      textLength: text.length,
      bypass,
    })

    await this.deps.onRiskDecision(job, decision)

    annotate({ 'awah.risk.action': decision.action, 'awah.risk.score': decision.score })

    if (decision.action === 'held') {
      const until = decision.availableAt ?? new Date(Date.now() + 60_000)
      await hold(this.deps.db, job.id, until, decision.reason)
      this.deps.observeSend?.('held', elapsed())
      this.deps.logger.info(
        { outboxId: job.id, until: until.toISOString(), reason: decision.reason },
        'send held by the risk engine',
      )
      return
    }

    try {
      // Typing before speaking, for a time proportional to the text.
      if (decision.typingMs > 0) {
        await adapter.sendPresence(job.chatId, 'composing')
        await sleep(decision.typingMs)
        await adapter.sendPresence(job.chatId, 'paused')
      }

      // Jitter between sends: this is where the score's brake reaches behaviour.
      if (decision.delayMs > 0) {
        await sleep(decision.delayMs)
      }

      // The session may have dropped during the wait.
      if (!adapter.isReady()) {
        await release(this.deps.db, job.id)
        return
      }

      const result = await adapter.sendText(job.chatId, text)
      await markSent(this.deps.db, job.id, result.engineMessageId)
      await this.deps.risk.recordSent(job.sessionId, job.chatId, decision.isNewContact)
      await this.deps.onDelivered(job, result.engineMessageId, result.timestamp)
      this.deps.observeSend?.('sent', elapsed())
    } catch (error) {
      this.deps.observeSend?.('failed', elapsed())
      const message = error instanceof Error ? error.message : String(error)
      const delay = exponentialBackoff({
        attempt: job.attempts + 1,
        baseMs: 2000,
        capMs: 3_600_000,
      })

      const outcome = await markFailed(this.deps.db, job.id, message, delay)

      if (outcome === 'dead') {
        this.deps.logger.error(
          { outboxId: job.id, attempts: job.attempts + 1, err: error },
          'send exhausted its attempts and went to the DLQ',
        )
        await this.deps.onDead(job, message)
      } else {
        this.deps.logger.warn(
          { outboxId: job.id, attempt: job.attempts + 1, delay },
          'send failed, rescheduled',
        )
      }
    }
  }
}
