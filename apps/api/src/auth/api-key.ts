import { randomBytes } from 'node:crypto'

const SCHEME = 'awah'
/** Hex, because the prefix must not contain the `_` separator. */
const PREFIX_BYTES = 8
const SECRET_BYTES = 24

export interface GeneratedApiKey {
  /** The full value, shown to the user exactly once. */
  token: string
  /** Public part: the lookup key, and what identifies it in the dashboard. */
  prefix: string
  /** Secret part, persisted only as a SHA-256 hash — see `auth/plugin.ts`. */
  secret: string
}

/** Format: `awah_<prefix hex>_<secret base64url>`. */
export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(PREFIX_BYTES).toString('hex')
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  return { token: `${SCHEME}_${prefix}_${secret}`, prefix, secret }
}

export interface ParsedApiKey {
  prefix: string
  secret: string
}

/**
 * The secret is base64url and may contain `_`, so only the first separator
 * after the scheme counts. The prefix is hex precisely so that this split is
 * unambiguous.
 */
export function parseApiKey(raw: string): ParsedApiKey | null {
  const header = `${SCHEME}_`
  if (!raw.startsWith(header)) return null

  const rest = raw.slice(header.length)
  const separator = rest.indexOf('_')
  if (separator <= 0) return null

  const prefix = rest.slice(0, separator)
  const secret = rest.slice(separator + 1)
  if (!prefix || !secret || !/^[0-9a-f]+$/.test(prefix)) return null

  return { prefix, secret }
}

/** Pulls the token out of an `Authorization: Bearer …` header. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return null
  const value = rest.join(' ').trim()
  return value.length > 0 ? value : null
}
