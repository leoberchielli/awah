export const SIGNATURE_HEADER = 'x-awah-signature'
export const TIMESTAMP_HEADER = 'x-awah-timestamp'

export interface VerificarEntrega {
  /**
   * The **raw** body, exactly as it arrived. Re-serializing the parsed object
   * produces similar bytes, not identical ones — key order and spacing can
   * differ — and verification would fail intermittently and inexplicably.
   */
  payload: string
  secret: string
  /** Value of `x-awah-signature`, in the form `sha256=<hex>`. */
  signature: string
  /** Value of `x-awah-timestamp`, in seconds. */
  timestamp: number | string
  /** Accepted window, in seconds. Default 300. */
  toleranceSeconds?: number
  /** Injectable for tests. */
  now?: () => number
}

/**
 * Verifies a webhook delivery.
 *
 * The signature covers `timestamp.body`, not the body alone. That is what stops
 * replay: a captured delivery cannot be sent again later because the receiver
 * rejects old timestamps, and changing the timestamp to escape the window
 * invalidates the signature.
 *
 * Uses WebCrypto, so it runs the same in Node, Deno, Bun, Cloudflare Workers and
 * the browser. That is why it is async.
 */
export async function verifyWebhook(options: VerificarEntrega): Promise<boolean> {
  const { payload, secret, signature, toleranceSeconds = 300, now = Date.now } = options

  const timestamp = Number(options.timestamp)
  if (!Number.isFinite(timestamp)) return false

  const idadeSegundos = Math.abs(Math.floor(now() / 1000) - timestamp)
  if (idadeSegundos > toleranceSeconds) return false

  const esperada = await signWebhook(payload, secret, timestamp)
  return comparacaoConstante(esperada, signature)
}

/** The same signature the server produces. Exported so integrations can test. */
export async function signWebhook(
  payload: string,
  secret: string,
  timestamp: number,
): Promise<string> {
  const codificador = new TextEncoder()

  const chave = await crypto.subtle.importKey(
    'raw',
    codificador.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const assinatura = await crypto.subtle.sign(
    'HMAC',
    chave,
    codificador.encode(`${timestamp}.${payload}`),
  )

  const hex = [...new Uint8Array(assinatura)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  return `sha256=${hex}`
}

/**
 * Constant-time comparison.
 *
 * `===` bails out at the first byte that differs, and that difference in timing,
 * measured at volume, gives away the correct signature byte by byte. This is not
 * a theoretical attack: it is why every webhook library ships a function like
 * this one.
 */
function comparacaoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false

  let diferenca = 0
  for (let i = 0; i < a.length; i++) {
    diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }

  return diferenca === 0
}

/**
 * Shortcut for anyone holding a standard `Request` — Workers, Deno, Hono, Next.
 *
 * It consumes the body as text, which is exactly what verification requires.
 */
export async function verifyWebhookRequest(
  request: Request,
  secret: string,
  options?: { toleranceSeconds?: number },
): Promise<{ valid: boolean; payload: string }> {
  const payload = await request.text()

  const valid = await verifyWebhook({
    payload,
    secret,
    signature: request.headers.get(SIGNATURE_HEADER) ?? '',
    timestamp: request.headers.get(TIMESTAMP_HEADER) ?? '',
    toleranceSeconds: options?.toleranceSeconds,
  })

  return { valid, payload }
}
