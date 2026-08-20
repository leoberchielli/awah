import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'x-awah-signature'
export const TIMESTAMP_HEADER = 'x-awah-timestamp'

/**
 * Signs the body with HMAC-SHA256, with the timestamp inside the signature.
 *
 * The timestamp is part of what gets signed, not just of the header, so that an
 * attacker cannot capture a valid delivery and send it again later: the receiver
 * rejects old signatures by comparing the timestamp against its own clock, and
 * the timestamp cannot be changed without invalidating the signature.
 */
export function sign(payload: string, secret: string, timestamp: number): string {
  const hmac = createHmac('sha256', secret)
  hmac.update(`${timestamp}.${payload}`)
  return `sha256=${hmac.digest('hex')}`
}

export interface VerifyOptions {
  payload: string
  secret: string
  signature: string
  timestamp: number
  /** Accepted window, in seconds. */
  toleranceSeconds?: number
  now?: () => number
}

/**
 * Receiver-side verification. It ships in the SDK and in the docs — integrators
 * need to be able to validate without reimplementing the scheme.
 */
export function verify(options: VerifyOptions): boolean {
  const { payload, secret, signature, timestamp, toleranceSeconds = 300, now = Date.now } = options

  const ageSeconds = Math.abs(Math.floor(now() / 1000) - timestamp)
  if (ageSeconds > toleranceSeconds) return false

  const expected = sign(payload, secret, timestamp)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)

  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
