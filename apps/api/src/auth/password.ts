import { hash, verify } from '@node-rs/argon2'

/**
 * argon2id parameters as OWASP recommends them: 19 MiB of memory, 2
 * iterations, parallelism 1. Costly enough to make brute force expensive, cheap
 * enough that a login does not hold up the event loop.
 *
 * The algorithm is not passed explicitly because argon2id is already the
 * library's default, and `Algorithm` is an ambient const enum — importing it
 * breaks under `verbatimModuleSyntax`.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS)
}

/**
 * Returns false instead of propagating an error when the digest is corrupt —
 * callers treat "wrong password" and "broken hash" the same way, and the
 * difference between the two must not leak to the client.
 */
export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, OPTIONS)
  } catch {
    return false
  }
}
