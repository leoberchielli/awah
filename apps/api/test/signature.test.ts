import { describe, expect, it } from 'vitest'
import { sign, verify } from '../src/webhooks/signature'

const secret = 'test-secret'
const payload = JSON.stringify({ event: 'message.received', data: { text: 'hi' } })
const nowSeconds = Math.floor(Date.now() / 1000)

describe('webhook signature', () => {
  it('validates its own signature', () => {
    const signature = sign(payload, secret, nowSeconds)
    expect(verify({ payload, secret, signature, timestamp: nowSeconds })).toBe(true)
  })

  it('rejects the wrong secret', () => {
    const signature = sign(payload, secret, nowSeconds)
    expect(verify({ payload, secret: 'other', signature, timestamp: nowSeconds })).toBe(false)
  })

  it('rejects a tampered body', () => {
    const signature = sign(payload, secret, nowSeconds)
    const adulterado = payload.replace('hi', 'tchau')
    expect(verify({ payload: adulterado, secret, signature, timestamp: nowSeconds })).toBe(false)
  })

  /**
   * The timestamp is part of what gets signed for exactly this reason: a
   * captured delivery cannot be replayed later, because moving the timestamp
   * to escape the window invalidates the signature.
   */
  it('rejects an old delivery, even with a correct signature', () => {
    const oldest = nowSeconds - 3600
    const signature = sign(payload, secret, oldest)

    expect(verify({ payload, secret, signature, timestamp: oldest })).toBe(false)
    // Inside the configured window, the same signature passes.
    expect(verify({ payload, secret, signature, timestamp: oldest, toleranceSeconds: 7200 })).toBe(
      true,
    )
  })

  it('rejects a swapped timestamp with no re-signing', () => {
    const signature = sign(payload, secret, nowSeconds)
    expect(verify({ payload, secret, signature, timestamp: nowSeconds + 10 })).toBe(false)
  })

  it('rejects a timestamp too far in the future', () => {
    const future = nowSeconds + 3600
    const signature = sign(payload, secret, future)
    expect(verify({ payload, secret, signature, timestamp: future })).toBe(false)
  })

  it('does not blow up on a signature of a different length', () => {
    expect(verify({ payload, secret, signature: 'curta', timestamp: nowSeconds })).toBe(false)
    expect(verify({ payload, secret, signature: '', timestamp: nowSeconds })).toBe(false)
  })

  it('uses the algorithm prefix', () => {
    expect(sign(payload, secret, nowSeconds)).toMatch(/^sha256=[0-9a-f]{64}$/)
  })
})
