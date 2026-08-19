export const SIGNATURE_HEADER = 'x-awah-signature'
export const TIMESTAMP_HEADER = 'x-awah-timestamp'

export interface VerificarEntrega {
  /**
   * O corpo **cru**, como chegou. Reserializar o objeto já parseado produz bytes
   * parecidos, não idênticos — ordem de chaves e espaçamento podem diferir — e a
   * verificação falharia de forma intermitente e inexplicável.
   */
  payload: string
  secret: string
  /** Valor de `x-awah-signature`, no formato `sha256=<hex>`. */
  signature: string
  /** Valor de `x-awah-timestamp`, em segundos. */
  timestamp: number | string
  /** Janela aceita, em segundos. Padrão 300. */
  toleranceSeconds?: number
  /** Injetável para teste. */
  now?: () => number
}

/**
 * Verifica uma entrega de webhook.
 *
 * A assinatura cobre `timestamp.corpo`, não só o corpo. É o que impede replay:
 * uma entrega capturada não pode ser reenviada depois porque o receptor rejeita
 * timestamps velhos, e mudar o timestamp para escapar da janela invalida a
 * assinatura.
 *
 * Usa WebCrypto, então roda igual em Node, Deno, Bun, Cloudflare Workers e no
 * navegador. É assíncrona por isso.
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

/** Mesma assinatura que o servidor produz. Exportada para testar integrações. */
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
 * Comparação em tempo constante.
 *
 * `===` sai no primeiro byte diferente, e essa diferença de tempo, medida em
 * volume, revela a assinatura correta byte a byte. Não é ataque teórico: é o
 * motivo de toda biblioteca de webhook trazer uma função como esta.
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
 * Atalho para quem recebe um `Request` padrão — Workers, Deno, Hono, Next.
 *
 * Consome o corpo como texto, que é justamente o que a verificação exige.
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
