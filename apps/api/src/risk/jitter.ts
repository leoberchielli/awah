/**
 * A sample from a log-normal distribution, via Box-Muller.
 *
 * Log-normal and not uniform because that is how human intervals behave: most
 * pauses land near the median, and every so often one comes out much longer —
 * the person went to get coffee. A uniform interval produces a regular pattern,
 * which is exactly what we are trying to avoid.
 */
export function logNormal(medianMs: number, sigma: number, random: () => number): number {
  const u1 = Math.max(random(), Number.EPSILON)
  const u2 = random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.exp(Math.log(medianMs) + sigma * z)
}

export interface HumanDelayOptions {
  /** Median interval between sends, in ms. */
  medianMs?: number
  /** Spread of the tail. Above 1 it produces very long pauses. */
  sigma?: number
  /** Risk score: the higher it is, the slower the pace. */
  throttleFactor?: number
  maxMs?: number
  random?: () => number
}

/**
 * The interval before the next send.
 *
 * `throttleFactor` divides the pace: a factor of 0.25 means four times the wait
 * between messages. This is how the score's brake reaches observable behaviour
 * without having to refuse anything.
 */
export function humanDelayMs(options: HumanDelayOptions = {}): number {
  const {
    medianMs = 3000,
    sigma = 0.55,
    throttleFactor = 1,
    maxMs = 120_000,
    random = Math.random,
  } = options

  const fator = throttleFactor > 0 ? throttleFactor : 0.1
  const amostra = logNormal(medianMs / fator, sigma, random)

  return Math.round(Math.min(Math.max(amostra, 250), maxMs))
}

/**
 * How long to show "typing" before sending.
 *
 * Proportional to the text, at a human typing pace. A three-hundred-character
 * message that appears instantly gives the automation away to anyone who has
 * the chat open.
 */
export function typingDurationMs(
  textLength: number,
  options: { charsPerSecond?: number; minMs?: number; maxMs?: number } = {},
): number {
  const { charsPerSecond = 18, minMs = 700, maxMs = 9000 } = options

  const estimated = (textLength / charsPerSecond) * 1000
  return Math.round(Math.min(Math.max(estimated, minMs), maxMs))
}
