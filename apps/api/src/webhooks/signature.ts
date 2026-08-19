import { createHmac, timingSafeEqual } from 'node:crypto'

export const SIGNATURE_HEADER = 'x-awah-signature'
export const TIMESTAMP_HEADER = 'x-awah-timestamp'

/**
 * Assina o corpo em HMAC-SHA256, com o timestamp dentro da assinatura.
 *
 * O timestamp faz parte do que é assinado, e não só do header, para que um
 * atacante não possa capturar uma entrega válida e reenviá-la depois: o
 * receptor rejeita assinaturas antigas comparando o timestamp com o relógio
 * dele, e o timestamp não pode ser alterado sem invalidar a assinatura.
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
  /** Janela aceita, em segundos. */
  toleranceSeconds?: number
  now?: () => number
}

/**
 * Verificação do lado do receptor. Vai no SDK e na documentação — quem integra
 * precisa poder validar sem reimplementar o esquema.
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
