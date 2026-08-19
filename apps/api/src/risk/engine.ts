import { type Database, eq, type RiskAction, schema, sql } from '@awah/db'
import type { BudgetTracker, BudgetUsage } from './budget'
import { humanDelayMs, typingDurationMs } from './jitter'
import { resolveLimits, type SessionLimits } from './limits'
import { computeScore, type RiskScore, throttleFactor } from './score'
import { applyWarmup, sessionAgeInDays, warmupFactor } from './warmup'

export interface RiskDecision {
  action: RiskAction
  /** Espera antes de enviar. Zero significa enviar agora. */
  delayMs: number
  /** Tempo exibindo "digitando" antes da mensagem sair. */
  typingMs: number
  /** Quando reavaliar, se a decisão foi segurar. */
  availableAt: Date | null
  reason: string
  score: number
  usage: BudgetUsage
  limits: SessionLimits
  isNewContact: boolean
}

export interface RiskSnapshot {
  score: RiskScore
  usage: BudgetUsage
  limits: SessionLimits
  baseLimits: SessionLimits
  ageInDays: number
  warmupFactor: number
  throttleFactor: number
}

interface CachedSignals {
  outbound: number
  inbound: number
  failed: number
  expiresAt: number
}

export interface RiskEngineDeps {
  db: Database
  budget: BudgetTracker
  now?: () => number
  /** Janela de cache dos sinais agregados. */
  signalsTtlMs?: number
  /** Desligado, o motor libera tudo na hora. Só para número descartável. */
  enabled?: boolean
}

/**
 * Motor de risco.
 *
 * A decisão do §2 é "enfileira e regula": o motor nunca descarta uma mensagem.
 * Quando o orçamento acabou, o envio volta para a fila com a hora em que a
 * janela abre — e essa hora é real, calculada a partir do registro mais antigo
 * dentro da janela, não um palpite. Quando o comportamento parece disparo, o
 * ritmo cai em vez de a mensagem ser recusada.
 *
 * O único caminho que ignora tudo isto é o override explícito, e ele fica
 * registrado em `risk_events` como qualquer outra decisão.
 */
export class RiskEngine {
  private readonly signalsCache = new Map<string, CachedSignals>()
  private readonly now: () => number
  private readonly signalsTtlMs: number

  constructor(private readonly deps: RiskEngineDeps) {
    this.now = deps.now ?? Date.now
    this.signalsTtlMs = deps.signalsTtlMs ?? 30_000
  }

  /**
   * Agregados de 24 h da sessão, com cache curto.
   *
   * Sem o cache, cada envio dispararia uma varredura de 24 h na tabela de
   * mensagens — o motor de risco viraria o gargalo que ele existe para evitar.
   */
  private async signals(sessionId: string): Promise<CachedSignals> {
    const cached = this.signalsCache.get(sessionId)
    if (cached && cached.expiresAt > this.now()) return cached

    const result = await this.deps.db.execute(sql`
      SELECT
        count(*) FILTER (WHERE direction = 'outbound') AS outbound,
        count(*) FILTER (WHERE direction = 'inbound') AS inbound,
        count(*) FILTER (WHERE direction = 'outbound' AND status IN ('failed', 'stale')) AS failed
      FROM messages
      WHERE session_id = ${sessionId}::uuid
        AND occurred_at > now() - interval '24 hours'
    `)

    const row = ([...result][0] ?? {}) as Record<string, unknown>
    const signals: CachedSignals = {
      outbound: Number(row.outbound ?? 0),
      inbound: Number(row.inbound ?? 0),
      failed: Number(row.failed ?? 0),
      expiresAt: this.now() + this.signalsTtlMs,
    }

    this.signalsCache.set(sessionId, signals)
    return signals
  }

  private async sessionContext(
    sessionId: string,
  ): Promise<{ limits: SessionLimits; baseLimits: SessionLimits; ageInDays: number } | null> {
    const [session] = await this.deps.db
      .select({ config: schema.sessions.config, pairedAt: schema.sessions.pairedAt })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .limit(1)

    if (!session) return null

    const baseLimits = resolveLimits(session.config)
    const ageInDays = sessionAgeInDays(session.pairedAt, new Date(this.now()))

    return { limits: applyWarmup(baseLimits, ageInDays), baseLimits, ageInDays }
  }

  async evaluate(input: {
    sessionId: string
    chatId: string
    textLength: number
    bypass?: boolean
  }): Promise<RiskDecision> {
    const context = await this.sessionContext(input.sessionId)
    const limits = context?.limits ?? applyWarmup(resolveLimits(null), 0)

    const isNewContact = !(await this.deps.budget.isKnownContact(input.sessionId, input.chatId))
    const usage = await this.deps.budget.usage(input.sessionId)

    if (input.bypass || this.deps.enabled === false) {
      return {
        action: 'allowed',
        delayMs: 0,
        typingMs: 0,
        availableAt: null,
        reason: input.bypass
          ? 'Override explícito do cliente (x-awah-bypass-risk)'
          : 'Motor de risco desligado nesta instância',
        score: 0,
        usage,
        limits,
        isNewContact,
      }
    }

    // 1. Orçamento: janela cheia segura o envio até a vaga abrir.
    const verdict = await this.deps.budget.check(input.sessionId, limits, isNewContact)
    if (verdict.exceeded) {
      return {
        action: 'held',
        delayMs: 0,
        typingMs: 0,
        availableAt: verdict.availableAt,
        reason: describeExceeded(verdict.exceeded, limits),
        score: 0,
        usage: verdict.usage,
        limits,
        isNewContact,
      }
    }

    // 2. Score: comportamento parecido com disparo reduz a vazão.
    const signals = await this.signals(input.sessionId)
    const outbound = signals.outbound
    const score = computeScore({
      outbound24h: outbound,
      inbound24h: signals.inbound,
      newContacts24h: usage.newContactsToday,
      newContactsLimit: limits.newContactsPerDay,
      deliveryFailureRate: outbound > 0 ? signals.failed / outbound : 0,
      minuteUsage: usage.minute,
      minuteLimit: limits.perMinute,
    })

    const factor = throttleFactor(score.value)
    const delayMs = humanDelayMs({ throttleFactor: factor })
    const typingMs = typingDurationMs(input.textLength)

    return {
      action: factor < 1 ? 'throttled' : 'delayed',
      delayMs,
      typingMs,
      availableAt: null,
      reason:
        factor < 1
          ? `Score ${score.value}/100 — ritmo reduzido a ${Math.round(factor * 100)}%`
          : `Score ${score.value}/100 — ritmo normal`,
      score: score.value,
      usage,
      limits,
      isNewContact,
    }
  }

  /** Contabiliza o envio no orçamento. Chamado após a entrega bem-sucedida. */
  async recordSent(sessionId: string, chatId: string, isNewContact: boolean): Promise<void> {
    await this.deps.budget.record(sessionId, chatId, isNewContact)
    // Os agregados mudaram: invalida para o próximo cálculo enxergar a realidade.
    this.signalsCache.delete(sessionId)
  }

  /** Retrato completo para o dashboard e para a rota de consulta. */
  async snapshot(sessionId: string): Promise<RiskSnapshot | null> {
    const context = await this.sessionContext(sessionId)
    if (!context) return null

    const usage = await this.deps.budget.usage(sessionId)
    const signals = await this.signals(sessionId)

    const score = computeScore({
      outbound24h: signals.outbound,
      inbound24h: signals.inbound,
      newContacts24h: usage.newContactsToday,
      newContactsLimit: context.limits.newContactsPerDay,
      deliveryFailureRate: signals.outbound > 0 ? signals.failed / signals.outbound : 0,
      minuteUsage: usage.minute,
      minuteLimit: context.limits.perMinute,
    })

    return {
      score,
      usage,
      limits: context.limits,
      baseLimits: context.baseLimits,
      ageInDays: context.ageInDays,
      warmupFactor: warmupFactor(context.ageInDays),
      throttleFactor: throttleFactor(score.value),
    }
  }
}

function describeExceeded(window: keyof BudgetUsage, limits: SessionLimits): string {
  switch (window) {
    case 'minute':
      return `Teto de ${limits.perMinute} mensagens por minuto atingido`
    case 'hour':
      return `Teto de ${limits.perHour} mensagens por hora atingido`
    case 'day':
      return `Teto de ${limits.perDay} mensagens por dia atingido`
    case 'newContactsToday':
      return `Teto de ${limits.newContactsPerDay} contatos novos por dia atingido`
  }
}
