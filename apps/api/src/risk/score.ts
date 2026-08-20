export interface RiskSignals {
  /** Messages sent in the last 24 h. */
  outbound24h: number
  /** Messages received in the last 24 h. */
  inbound24h: number
  newContacts24h: number
  newContactsLimit: number
  /** Fraction of sends that never reached the recipient, between 0 and 1. */
  deliveryFailureRate: number
  minuteUsage: number
  minuteLimit: number
}

export interface ScoreFactor {
  name: string
  /** How much this signal added to the score. */
  points: number
  max: number
  detail: string
}

export interface RiskScore {
  /** 0 to 100. The higher it is, the more the behaviour looks like blasting. */
  value: number
  factors: ScoreFactor[]
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * Risk-of-being-blocked score.
 *
 * There is no official formula — WhatsApp does not publish how it decides to
 * ban. What this calculation does is measure the distance between the session's
 * behaviour and that of a human having a conversation, using the four signals
 * that show up consistently in accounts of blocked numbers.
 *
 * The score is explainable on purpose: every factor reports how much it added
 * and why, because a bare number from 0 to 100 helps nobody decide what to
 * change.
 */
export function computeScore(signals: RiskSignals): RiskScore {
  const factors: ScoreFactor[] = []

  /**
   * One-sided conversation, 35 points — the strongest signal.
   *
   * People talk in both directions. A session that sends ten times more than it
   * receives is not doing support, it is blasting. The +1 in the denominator
   * avoids division by zero and keeps the ratio finite when nobody has replied
   * yet.
   */
  const ratio = signals.outbound24h / (signals.inbound24h + 1)
  const ratioPoints = signals.outbound24h < 10 ? 0 : clamp01((ratio - 2) / 18) * 35
  factors.push({
    name: 'conversa_unilateral',
    points: Math.round(ratioPoints),
    max: 35,
    detail: `${signals.outbound24h} enviadas para ${signals.inbound24h} recebidas em 24 h`,
  })

  /**
   * New contacts, 25 points. Talking to many strangers on the same day is the
   * pattern most likely to get you reported — and being reported is what takes
   * a number down.
   */
  const newRatio =
    signals.newContactsLimit > 0 ? signals.newContacts24h / signals.newContactsLimit : 0
  const newContactPoints = clamp01(newRatio) * 25
  factors.push({
    name: 'contatos_novos',
    points: Math.round(newContactPoints),
    max: 25,
    detail: `${signals.newContacts24h} de ${signals.newContactsLimit} permitidos hoje`,
  })

  /**
   * Delivery failure, 25 points. A message that does not arrive usually means
   * the number does not exist or the recipient blocked you — both point to a
   * bought or stale list, which is the short road to a ban.
   */
  const failurePoints = clamp01(signals.deliveryFailureRate / 0.3) * 25
  factors.push({
    name: 'falha_de_entrega',
    points: Math.round(failurePoints),
    max: 25,
    detail: `${Math.round(signals.deliveryFailureRate * 100)}% dos envios não chegaram`,
  })

  /**
   * Speed, 15 points. Weighs less than the others because the budget already
   * prevents the burst; here the signal exists so the score reacts before the
   * cap is hit.
   */
  const speedRatio = signals.minuteLimit > 0 ? signals.minuteUsage / signals.minuteLimit : 0
  const speedPoints = clamp01(speedRatio) * 15
  factors.push({
    name: 'velocidade',
    points: Math.round(speedPoints),
    max: 15,
    detail: `${signals.minuteUsage} de ${signals.minuteLimit} no último minuto`,
  })

  const value = Math.min(
    100,
    factors.reduce((total, factor) => total + factor.points, 0),
  )
  return { value, factors }
}

/**
 * A brake proportional to the score.
 *
 * Below 40 it does not interfere: penalising normal behaviour would only make
 * the integrator turn the engine off. Above that, throughput falls off
 * progressively, and the 10% floor guarantees the session never stops
 * altogether — stopping on its own would be indistinguishable from a bug, and
 * §2 settled that the engine regulates, it does not block.
 */
export function throttleFactor(score: number): number {
  if (score < 40) return 1
  if (score >= 90) return 0.1
  if (score >= 70) return 0.25

  // Between 40 and 70, it falls linearly from 1 to 0.5.
  return 1 - ((score - 40) / 30) * 0.5
}
