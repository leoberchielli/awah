import { describe, expect, it } from 'vitest'
import { humanDelayMs, logNormal, typingDurationMs } from '../src/risk/jitter'
import { DEFAULT_LIMITS, resolveLimits } from '../src/risk/limits'
import { computeScore, throttleFactor } from '../src/risk/score'
import { applyWarmup, sessionAgeInDays, warmupFactor } from '../src/risk/warmup'

describe('warm-up curve', () => {
  it('starts very tight and reaches the cap in 30 days', () => {
    expect(warmupFactor(0)).toBe(0.05)
    expect(warmupFactor(30)).toBe(1)
    expect(warmupFactor(60)).toBe(1)
  })

  it('rises monotonically', () => {
    let previous = 0
    for (const day of [0, 1, 3, 7, 14, 21, 30]) {
      const current = warmupFactor(day)
      expect(current).toBeGreaterThanOrEqual(previous)
      previous = current
    }
  })

  /** An interpolated ramp, not a step: volume must not jump from one day to the next. */
  it('interpolates between the milestones', () => {
    const mid = warmupFactor(2)
    expect(mid).toBeGreaterThan(warmupFactor(1))
    expect(mid).toBeLessThan(warmupFactor(3))
  })

  it('treats an invalid age as a new session', () => {
    expect(warmupFactor(-5)).toBe(0.05)
    expect(warmupFactor(Number.NaN)).toBe(0.05)
  })

  /** A zero cap would freeze the session entirely; it sends little, but it sends. */
  it('never zeroes the limits', () => {
    const limits = applyWarmup(DEFAULT_LIMITS, 0)
    expect(limits.perMinute).toBeGreaterThanOrEqual(1)
    expect(limits.perDay).toBeGreaterThanOrEqual(1)
    expect(limits.newContactsPerDay).toBeGreaterThanOrEqual(1)
  })

  it('releases the full cap once the session matures', () => {
    expect(applyWarmup(DEFAULT_LIMITS, 30)).toEqual(DEFAULT_LIMITS)
  })

  it('a fresh number sends far less than a mature one', () => {
    expect(applyWarmup(DEFAULT_LIMITS, 0).perDay).toBeLessThan(
      applyWarmup(DEFAULT_LIMITS, 30).perDay / 10,
    )
  })
})

describe('session age', () => {
  const nowMs = new Date('2026-08-18T12:00:00Z')

  it('counts in fractional days', () => {
    expect(sessionAgeInDays(new Date('2026-08-17T12:00:00Z'), nowMs)).toBe(1)
    expect(sessionAgeInDays(new Date('2026-08-18T00:00:00Z'), nowMs)).toBe(0.5)
  })

  /** With no pairing there is no history to justify volume. */
  it('a session that was never paired has age zero', () => {
    expect(sessionAgeInDays(null, nowMs)).toBe(0)
  })

  it('a future date does not become a negative age', () => {
    expect(sessionAgeInDays(new Date('2026-09-01T00:00:00Z'), nowMs)).toBe(0)
  })
})

describe('per-session limits', () => {
  it('falls back to the defaults with no configuration', () => {
    expect(resolveLimits(null)).toEqual(DEFAULT_LIMITS)
    expect(resolveLimits({})).toEqual(DEFAULT_LIMITS)
    expect(resolveLimits({ limits: 'not an object' })).toEqual(DEFAULT_LIMITS)
  })

  it('accepts a partial override', () => {
    const limits = resolveLimits({ limits: { perMinute: 30 } })
    expect(limits.perMinute).toBe(30)
    expect(limits.perHour).toBe(DEFAULT_LIMITS.perHour)
  })

  /** A corrupted config must never unlock the limit. */
  it('ignores invalid values and keeps the conservative one', () => {
    const limits = resolveLimits({
      limits: { perMinute: -5, perHour: 0, perDay: 'muitos', newContactsPerDay: Number.NaN },
    })
    expect(limits).toEqual(DEFAULT_LIMITS)
  })
})

describe('risk score', () => {
  const base = {
    outbound24h: 0,
    inbound24h: 0,
    newContacts24h: 0,
    newContactsLimit: 100,
    deliveryFailureRate: 0,
    minuteUsage: 0,
    minuteLimit: 12,
  }

  it('an idle session scores zero', () => {
    expect(computeScore(base).value).toBe(0)
  })

  it('balanced conversation keeps the score low', () => {
    const score = computeScore({ ...base, outbound24h: 100, inbound24h: 90 })
    expect(score.value).toBeLessThan(20)
  })

  /** The strongest signal: people talk both ways, a bot only talks. */
  it('penalizes one-sided conversation', () => {
    const oneSided = computeScore({ ...base, outbound24h: 500, inbound24h: 2 })
    const equilibrada = computeScore({ ...base, outbound24h: 500, inbound24h: 400 })
    expect(oneSided.value).toBeGreaterThan(equilibrada.value + 25)
  })

  /** Low volume is not blasting, even with no replies — 5 messages unanswered is normal. */
  it('does not punish small volume with no replies', () => {
    const factor = computeScore({ ...base, outbound24h: 5, inbound24h: 0 }).factors.find(
      (f) => f.name === 'one_sided_conversation',
    )
    expect(factor?.points).toBe(0)
  })

  it('penalizes too many new contacts', () => {
    const score = computeScore({ ...base, newContacts24h: 100, newContactsLimit: 100 })
    const factor = score.factors.find((f) => f.name === 'new_contacts')
    expect(factor?.points).toBe(25)
  })

  it('penalizes a high delivery failure rate', () => {
    const score = computeScore({ ...base, outbound24h: 100, deliveryFailureRate: 0.3 })
    const factor = score.factors.find((f) => f.name === 'delivery_failure')
    expect(factor?.points).toBe(25)
  })

  /**
   * The dashboard renders these factors in ten languages by looking each name
   * up as a translation key and interpolating `values`. Rename a factor and
   * every translation for it silently stops matching — the panel falls back to
   * the English sentence and nothing goes red, so the drift is only ever found
   * by a reader who cannot read the explanation of their own risk score.
   */
  it('keeps the factor names and their numbers as a stable contract', () => {
    const { factors } = computeScore({
      ...base,
      outbound24h: 100,
      inbound24h: 4,
      newContacts24h: 9,
      deliveryFailureRate: 0.12,
      minuteUsage: 7,
    })

    expect(factors.map((f) => f.name)).toEqual([
      'one_sided_conversation',
      'new_contacts',
      'delivery_failure',
      'speed',
    ])

    expect(factors.map((f) => f.values)).toEqual([
      { sent: 100, received: 4 },
      { used: 9, limit: 100 },
      { percent: 12 },
      { used: 7, limit: 12 },
    ])
  })

  /**
   * `detail` is the fallback the panel prints when a signal has no translation
   * yet, and it is what anyone reading the API directly sees. A factor that
   * ships without it explains nothing to either.
   */
  it('states every factor in English as well as in numbers', () => {
    for (const factor of computeScore({ ...base, outbound24h: 100 }).factors) {
      expect(factor.detail).not.toBe('')
      expect(factor.detail).toMatch(/^[ -~]+$/)
      expect(Object.keys(factor.values).length).toBeGreaterThan(0)
    }
  })

  it('never goes above 100', () => {
    const worst = computeScore({
      outbound24h: 5000,
      inbound24h: 0,
      newContacts24h: 500,
      newContactsLimit: 100,
      deliveryFailureRate: 1,
      minuteUsage: 50,
      minuteLimit: 12,
    })
    expect(worst.value).toBeLessThanOrEqual(100)
    expect(worst.value).toBeGreaterThan(80)
  })

  /** A bare number from 0 to 100 helps nobody decide what to change. */
  it('explains every factor', () => {
    const score = computeScore({ ...base, outbound24h: 200, inbound24h: 5 })
    expect(score.factors).toHaveLength(4)
    for (const factor of score.factors) {
      expect(factor.detail.length).toBeGreaterThan(0)
      expect(factor.points).toBeLessThanOrEqual(factor.max)
    }
  })
})

describe('adaptive brake', () => {
  it('does not interfere with normal behavior', () => {
    expect(throttleFactor(0)).toBe(1)
    expect(throttleFactor(39)).toBe(1)
  })

  it('tightens progressively as the score rises', () => {
    expect(throttleFactor(55)).toBeLessThan(1)
    expect(throttleFactor(75)).toBeLessThan(throttleFactor(55))
    expect(throttleFactor(95)).toBeLessThan(throttleFactor(75))
  })

  /** §2 settled it: the engine regulates, never blocks — a session never fully stops. */
  it('never reaches zero', () => {
    expect(throttleFactor(100)).toBeGreaterThan(0)
  })
})

describe('human jitter', () => {
  it('respects the floor and the cap', () => {
    for (let i = 0; i < 200; i++) {
      const delayMs = humanDelayMs()
      expect(delayMs).toBeGreaterThanOrEqual(250)
      expect(delayMs).toBeLessThanOrEqual(120_000)
    }
  })

  it('stays near the median on a neutral draw', () => {
    // random = 0.5 on both draws returns a z close to zero.
    const delayMs = humanDelayMs({ medianMs: 3000, random: () => 0.5 })
    expect(delayMs).toBeGreaterThan(1500)
    expect(delayMs).toBeLessThan(6000)
  })

  it('the score brake increases the wait', () => {
    const normal = humanDelayMs({ throttleFactor: 1, random: () => 0.5 })
    const throttled = humanDelayMs({ throttleFactor: 0.25, random: () => 0.5 })
    expect(throttled).toBeGreaterThan(normal * 3)
  })

  /** A uniform interval would produce a regular pattern — exactly what we avoid. */
  it('produces varied values', () => {
    const samples = new Set(Array.from({ length: 50 }, () => humanDelayMs()))
    expect(samples.size).toBeGreaterThan(40)
  })

  it('log-normal only returns positives', () => {
    for (let i = 0; i < 100; i++) {
      expect(logNormal(3000, 0.55, Math.random)).toBeGreaterThan(0)
    }
  })
})

describe('typing duration', () => {
  it('grows with the length of the text', () => {
    expect(typingDurationMs(500)).toBeGreaterThan(typingDurationMs(20))
  })

  it('respects floor and cap', () => {
    expect(typingDurationMs(0)).toBe(700)
    expect(typingDurationMs(100_000)).toBe(9000)
  })

  it('uses a plausible typing pace', () => {
    // 180 characters at ~18 per second land near ten seconds, clamped to the cap.
    expect(typingDurationMs(180)).toBeGreaterThan(5000)
  })
})
