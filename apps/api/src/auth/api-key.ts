import { randomBytes } from 'node:crypto'

const SCHEME = 'awah'
/** Hex, porque o prefixo não pode conter o separador `_`. */
const PREFIX_BYTES = 8
const SECRET_BYTES = 24

export interface GeneratedApiKey {
  /** Valor completo, mostrado ao usuário uma única vez. */
  token: string
  /** Parte pública: serve de chave de busca e identifica a chave no dashboard. */
  prefix: string
  /** Parte secreta, persistida apenas como hash argon2id. */
  secret: string
}

/** Formato: `awah_<prefix hex>_<secret base64url>`. */
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
 * O segredo é base64url e pode conter `_`, então só o primeiro separador depois
 * do esquema conta. O prefixo é hex justamente para que esse corte seja
 * inequívoco.
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

/** Extrai o token de um header `Authorization: Bearer …`. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return null
  const value = rest.join(' ').trim()
  return value.length > 0 ? value : null
}
