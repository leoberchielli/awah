import { type Database, eq, type RiskAction, schema, sql } from '@awah/db'
import type { BudgetTracker, BudgetUsage } from './budget'
import { humanDelayMs, typingDurationMs } from './jitter'
import { resolveLimits, type SessionLimits } from './limits'
import { computeScore, type RiskScore, throttleFactor } from './score'
import { applyWarmup, sessionAgeInDays, warmupFactor } from './warmup'

export interface RiskDecision {
  action: RiskAction
  /** Wait before sending. Zero means send now. */
  delayMs: number
  /** Time spent showing "typing" before the message goes out. */
  typingMs: number
  /** When to re-evaluate, if the decision was to hold. */
  availableAt: Date | null
  reason: string
  score: number
  usage: BudgetUsage
  limits: SessionLimits
  isNewContact: boolean
  /**
   * The budget slot this decision is holding.
   *
   * Present whenever the budget allowed the send, and it has to be given back
   * if the send then does not happen. Null when the send was held, and null on
   * the paths that skip the budget entirely.
   */
  reservation: string | null
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
  /** Cache window for the aggregated signals. */
  signalsTtlMs?: number
  /** Off, the engine lets everything through now. Throwaway numbers only. */
  enabled?: boolean
}

/**
 * Risk engine.
 *
 * The §2 decision is "queue and regulate": the engine never drops a message.
 * When the budget runs out, the send goes back to the queue with the time the
 * window opens — and that time is real, computed from the oldest entry inside
 * the window, not a guess. When the behaviour looks like blasting, the pace
 * slows instead of the message being refused.
 *
 * The only path that ignores all of this is the explicit override, and it is
 * recorded in `risk_events` like any other decision.
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
   * The session's 24 h aggregates, with a short cache.
   *
   * Without the cache, every send would trigger a 24 h scan of the messages
   * table — the risk engine would become the bottleneck it exists to prevent.
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
          ? 'Explicit client override (x-awah-bypass-risk)'
          : 'Risk engine off on this instance',
        score: 0,
        usage,
        limits,
        isNewContact,
        reservation: null,
      }
    }

    /*
     * 1. Budget: a full window holds the send until a slot opens.
     *
     * `reserve`, not `check`. The slot is taken here and not after delivery,
     * because everything between the two — the typing indicator, the jitter,
     * the round trip — is time during which other workers would otherwise read
     * this same window as empty and be let through as well.
     */
    const verdict = await this.deps.budget.reserve(
      input.sessionId,
      limits,
      isNewContact,
      input.chatId,
    )
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
        reservation: null,
      }
    }

    // 2. Score: behaviour that looks like blasting reduces throughput.
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
          ? `Score ${score.value}/100 — pace reduced to ${Math.round(factor * 100)}%`
          : `Score ${score.value}/100 — normal pace`,
      score: score.value,
      usage,
      limits,
      isNewContact,
      reservation: verdict.reservation,
    }
  }

  /**
   * Gives back a slot whose send never went out.
   *
   * Without this a session that spends an afternoon failing would burn its
   * whole daily allowance on messages nobody received, and the operator would
   * see a budget full of sends that do not exist.
   */
  async releaseReservation(sessionId: string, decision: RiskDecision, chatId: string) {
    if (!decision.reservation) return
    await this.deps.budget.release(sessionId, decision.reservation, decision.isNewContact, chatId)
  }

  /** Confirms a delivered send. Called after successful delivery. */
  async recordSent(
    sessionId: string,
    chatId: string,
    isNewContact: boolean,
    reserved = false,
  ): Promise<void> {
    await this.deps.budget.record(sessionId, chatId, isNewContact, reserved)
    // The aggregates changed: invalidate so the next calculation sees reality.
    this.signalsCache.delete(sessionId)
  }

  /** The full picture, for the dashboard and for the query route. */
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
      return `Cap of ${limits.perMinute} messages per minute reached`
    case 'hour':
      return `Cap of ${limits.perHour} messages per hour reached`
    case 'day':
      return `Cap of ${limits.perDay} messages per day reached`
    case 'newContactsToday':
      return `Cap of ${limits.newContactsPerDay} new contacts per day reached`
  }
}
