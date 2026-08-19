/**
 * Tetos de envio por sessão, antes do warmup.
 *
 * Os números não são exatos — o WhatsApp não publica limites, e quem afirma
 * conhecê-los está adivinhando. O que se sabe por observação é a forma do
 * problema: volume alto num chip novo, muitos destinatários que nunca
 * responderam e disparo em velocidade constante são os padrões que antecedem
 * bloqueio. Os defaults abaixo são conservadores de propósito; quem tem chip
 * maduro e histórico de conversa real pode subi-los por sessão.
 */
export interface SessionLimits {
  perMinute: number
  perHour: number
  perDay: number
  /** Destinatários nunca contatados por esta sessão, por dia. */
  newContactsPerDay: number
}

export const DEFAULT_LIMITS: SessionLimits = {
  perMinute: 12,
  perHour: 250,
  perDay: 1000,
  newContactsPerDay: 100,
}

/**
 * Lê os limites gravados em `sessions.config`, caindo nos defaults quando o
 * campo não existe ou veio corrompido. Configuração inválida nunca deve
 * destravar o limite — na dúvida, o valor conservador vence.
 */
export function resolveLimits(config: unknown): SessionLimits {
  if (typeof config !== 'object' || config === null) return DEFAULT_LIMITS

  const raw = (config as { limits?: unknown }).limits
  if (typeof raw !== 'object' || raw === null) return DEFAULT_LIMITS

  const source = raw as Record<string, unknown>
  const pick = (key: keyof SessionLimits): number => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : DEFAULT_LIMITS[key]
  }

  return {
    perMinute: pick('perMinute'),
    perHour: pick('perHour'),
    perDay: pick('perDay'),
    newContactsPerDay: pick('newContactsPerDay'),
  }
}
