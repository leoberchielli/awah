export interface BackoffOptions {
  /** The attempt already spent, starting at 1. */
  attempt: number
  baseMs: number
  capMs: number
  /** Fraction of randomness added on top, between 0 and 1. */
  jitterRatio?: number
  random?: () => number
}

/**
 * Exponential wait with a cap and jitter.
 *
 * The jitter is not decoration. Without it, everything that fails together — a
 * session that drops, a webhook endpoint that goes down, the database
 * restarting — comes back together, in the same millisecond, and repeats the
 * burst every cycle. The effect is a periodic self-inflicted attack that only
 * gets worse as the queue grows.
 */
export function exponentialBackoff(options: BackoffOptions): number {
  const { attempt, baseMs, capMs, jitterRatio = 0.25, random = Math.random } = options

  const exponent = Math.max(0, attempt - 1)
  const base = Math.min(baseMs * 2 ** exponent, capMs)
  return Math.round(base + base * jitterRatio * random())
}
