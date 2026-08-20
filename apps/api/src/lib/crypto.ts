import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * AES-256-GCM encryption. Used for the sessions' auth state, which is
 * credential material: anyone who reads the `session_auth` table without the
 * key cannot take over anybody's WhatsApp.
 *
 * Output format: `iv.tag.ciphertext`, all in base64url.
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decrypt(payload: string, key: Buffer): string {
  const parts = payload.split('.')
  if (parts.length !== 3) {
    throw new Error('malformed encrypted payload')
  }

  const [ivPart, tagPart, dataPart] = parts as [string, string, string]
  const iv = Buffer.from(ivPart, 'base64url')
  const tag = Buffer.from(tagPart, 'base64url')
  const ciphertext = Buffer.from(dataPart, 'base64url')

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('malformed encrypted payload')
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * Hash for high-entropy values — session tokens and API key secrets. SHA-256 is
 * enough here: unlike a password, the secret is already random, so there is no
 * dictionary attack to make expensive.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/** Constant-time comparison, tolerant of differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
