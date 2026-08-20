import { describe, expect, it } from 'vitest'
import {
  describeDisconnect,
  reconnectDelayMs,
  statusCodeFromError,
} from '../src/engines/disconnect'

describe('disconnect code translation', () => {
  it('separates a passing drop from a dead credential', () => {
    // 428 and 408 come back on their own; 401 and 500 need pairing again.
    expect(describeDisconnect(428).shouldReconnect).toBe(true)
    expect(describeDisconnect(408).shouldReconnect).toBe(true)
    expect(describeDisconnect(401).shouldReconnect).toBe(false)
    expect(describeDisconnect(401).loggedOut).toBe(true)
    expect(describeDisconnect(500).loggedOut).toBe(true)
  })

  /**
   * 440 is the code that confuses people most in practice: the session was
   * taken over somewhere else. Reconnecting in a loop makes the two ends knock
   * each other offline in turn, so this case has to stay non-reconnectable.
   */
  it('does not reconnect when the session was taken over elsewhere', () => {
    const info = describeDisconnect(440)
    expect(info.shouldReconnect).toBe(false)
    expect(info.loggedOut).toBe(false)
    expect(info.cause).toMatch(/elsewhere/i)
  })

  it('treats 515 as an expected restart, not as a failure', () => {
    const info = describeDisconnect(515)
    expect(info.shouldReconnect).toBe(true)
    expect(info.loggedOut).toBe(false)
  })

  it('does not reconnect when access was denied', () => {
    expect(describeDisconnect(403).shouldReconnect).toBe(false)
  })

  it('falls back to the generic case on an unknown or missing code', () => {
    expect(describeDisconnect(null).cause).toMatch(/unknown/i)
    expect(describeDisconnect(undefined).cause).toMatch(/unknown/i)
    expect(describeDisconnect(999).cause).toMatch(/unknown/i)
    // The generic case reconnects: the alternative is killing a good session over a new code.
    expect(describeDisconnect(999).shouldReconnect).toBe(true)
  })

  it('always comes with cause and guidance filled in', () => {
    for (const code of [401, 403, 408, 411, 428, 440, 500, 503, 515, 999]) {
      const info = describeDisconnect(code)
      expect(info.cause.length).toBeGreaterThan(0)
      expect(info.guidance.length).toBeGreaterThan(0)
    }
  })
})

describe('error code extraction', () => {
  it('reads the Boom shape, the one Baileys uses', () => {
    expect(statusCodeFromError({ output: { statusCode: 428 } })).toBe(428)
  })

  it('accepts statusCode at the root', () => {
    expect(statusCodeFromError({ statusCode: 515 })).toBe(515)
  })

  it('returns null for what carries no code', () => {
    expect(statusCodeFromError(new Error('no code'))).toBeNull()
    expect(statusCodeFromError(null)).toBeNull()
    expect(statusCodeFromError(undefined)).toBeNull()
    expect(statusCodeFromError('texto')).toBeNull()
    expect(statusCodeFromError({ output: { statusCode: 'not-a-number' } })).toBeNull()
  })
})

describe('wait between reconnections', () => {
  it('grows exponentially', () => {
    const withoutJitter = () => 0
    expect(reconnectDelayMs(1, withoutJitter)).toBe(1000)
    expect(reconnectDelayMs(2, withoutJitter)).toBe(2000)
    expect(reconnectDelayMs(3, withoutJitter)).toBe(4000)
    expect(reconnectDelayMs(5, withoutJitter)).toBe(16000)
  })

  it('stops growing at 5 minutes', () => {
    expect(reconnectDelayMs(20, () => 0)).toBe(300_000)
    expect(reconnectDelayMs(50, () => 0)).toBe(300_000)
  })

  /**
   * Without jitter, every session that drops together — a host network outage —
   * comes back on the same millisecond and repeats the burst every cycle.
   */
  it('spreads the attempts with jitter of up to 25%', () => {
    expect(reconnectDelayMs(3, () => 0)).toBe(4000)
    expect(reconnectDelayMs(3, () => 1)).toBe(5000)
    expect(reconnectDelayMs(3, () => 0.5)).toBe(4500)
  })

  it('handles attempt zero or negative without breaking', () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(1000)
    expect(reconnectDelayMs(-5, () => 0)).toBe(1000)
  })
})
