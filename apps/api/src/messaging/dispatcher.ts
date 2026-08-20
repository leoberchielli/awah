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
   * Observação de duração, declarada como função solta para que o scheduler não
   * precise conhecer o formato de métrica em uso.
   */
  observeSend?: (result: 'sent' | 'failed' | 'held', seconds: number) => void
  logger: ManagerLogger
  intervalMs: number
  batchSize: number
  /** Teto de envios simultâneos neste nó, somando todas as sessões. */
  maxConcurrent: number
  /** Envio parado em 'sending' por mais que isto voltou de um processo morto. */
  stuckAfterMs: number
  onDelivered: (job: ClaimedJob, engineMessageId: string, sentAt: Date) => Promise<void>
  onDead: (job: ClaimedJob, error: string) => Promise<void>
  /** Registra a decisão do motor de risco para auditoria. */
  onRiskDecision: (job: ClaimedJob, decision: RiskDecision) => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Scheduler de envio.
 *
 * O laço reserva lotes e dispara as entregas **sem esperá-las**. A distinção é
 * essencial depois do motor de risco: uma entrega pode ficar um minuto parada
 * de propósito, entre o jitter humano e o tempo de digitação, e aguardar por ela
 * dentro do ciclo travaria todos os outros chats junto. O que limita o paralelo
 * é o teto de concorrência, não o tempo de cada envio.
 */
export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private claiming = false
  private ticksSinceRecovery = 0
  /** Entregas em voo, por id do outbox. */
  private readonly inFlight = new Set<string>()

  constructor(private readonly deps: DispatcherDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.scheduleNext()
  }

  /** Para de reservar e espera o que já está em voo terminar. */
  async stop(timeoutMs = 15_000): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    const limite = Date.now() + timeoutMs
    while (this.inFlight.size > 0 && Date.now() < limite) {
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

      const capacidade = this.deps.maxConcurrent - this.inFlight.size
      if (capacidade <= 0) return

      const sessionIds = this.deps.sessions.activeSessionIds()
      if (sessionIds.length === 0) return

      const jobs = await claimOutbox(
        this.deps.db,
        sessionIds,
        Math.min(this.deps.batchSize, capacidade),
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
    const decorrido = () => (Date.now() - iniciadoEm) / 1000
    const adapter = this.deps.sessions.adapterFor(job.sessionId)

    /**
     * Sessão ausente ou ainda não pareada devolve o envio à fila sem consumir
     * tentativa. Indisponibilidade não é falha de entrega: contar como tal faria
     * mensagens perfeitamente válidas morrerem na DLQ enquanto o operador ainda
     * está escaneando o QR.
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
     * O motor de risco fica exatamente aqui: depois da reserva, antes da engine.
     *
     * É a posição que torna a promessa do §2 possível — a mensagem já está
     * persistida e reservada, então segurá-la não perde nada, e liberá-la mais
     * tarde não exige que o cliente reenvie.
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
      this.deps.observeSend?.('held', decorrido())
      this.deps.logger.info(
        { outboxId: job.id, until: until.toISOString(), reason: decision.reason },
        'send held by the risk engine',
      )
      return
    }

    try {
      // Digitando antes de falar, por tempo proporcional ao texto.
      if (decision.typingMs > 0) {
        await adapter.sendPresence(job.chatId, 'composing')
        await sleep(decision.typingMs)
        await adapter.sendPresence(job.chatId, 'paused')
      }

      // Jitter entre envios: o freio do score chega ao comportamento por aqui.
      if (decision.delayMs > 0) {
        await sleep(decision.delayMs)
      }

      // A sessão pode ter caído durante a espera.
      if (!adapter.isReady()) {
        await release(this.deps.db, job.id)
        return
      }

      const result = await adapter.sendText(job.chatId, text)
      await markSent(this.deps.db, job.id, result.engineMessageId)
      await this.deps.risk.recordSent(job.sessionId, job.chatId, decision.isNewContact)
      await this.deps.onDelivered(job, result.engineMessageId, result.timestamp)
      this.deps.observeSend?.('sent', decorrido())
    } catch (error) {
      this.deps.observeSend?.('failed', decorrido())
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
