import { exponentialBackoff } from '../lib/backoff'

/**
 * Tradução dos códigos de desconexão do protocolo para causa legível.
 *
 * Esta tabela é pequena e é boa parte do valor do produto. Quem opera Baileys
 * hoje vê `Connection Closed` no log e não sabe se perdeu a internet, se abriu o
 * WhatsApp Web em outra aba ou se o número foi banido — três incidentes com
 * respostas completamente diferentes. A timeline de quedas do dashboard lê daqui.
 */
export interface DisconnectInfo {
  /** Frase curta mostrada na timeline. */
  cause: string
  /** O que fazer a respeito. */
  guidance: string
  /** Se vale reconectar sozinho. */
  shouldReconnect: boolean
  /** Se as credenciais morreram e a sessão precisa parear de novo. */
  loggedOut: boolean
}

const UNKNOWN: DisconnectInfo = {
  cause: 'Unknown reason',
  guidance: 'Check the session logs. Automatic reconnection keeps trying.',
  shouldReconnect: true,
  loggedOut: false,
}

const TABLE: Record<number, DisconnectInfo> = {
  401: {
    cause: 'Session ended on the phone',
    guidance:
      'The phone disconnected this device. You have to pair again — automatic reconnection will not fix it.',
    shouldReconnect: false,
    loggedOut: true,
  },
  403: {
    cause: 'Access denied by WhatsApp',
    guidance:
      'Usually means the number is blocked or restricted. Do not insist on reconnecting: retrying makes the restriction worse.',
    shouldReconnect: false,
    loggedOut: true,
  },
  408: {
    cause: 'Timed out',
    guidance:
      'The connection did not answer in time. Usually an unstable network that clears on its own.',
    shouldReconnect: true,
    loggedOut: false,
  },
  411: {
    cause: 'Multi-device mismatch',
    guidance: 'The phone must have multi-device enabled. Pair again.',
    shouldReconnect: false,
    loggedOut: true,
  },
  428: {
    cause: 'Connection closed',
    guidance: 'Common socket drop. Automatic reconnection usually fixes it on the first attempt.',
    shouldReconnect: true,
    loggedOut: false,
  },
  440: {
    cause: 'Session taken over elsewhere',
    guidance:
      'The same credentials were opened in another process — WhatsApp Web, another instance, or two replicas fighting over the session. Reconnecting in a loop turns into a tug of war between both ends: confirm who owns it first.',
    shouldReconnect: false,
    loggedOut: false,
  },
  500: {
    cause: 'Corrupted session',
    guidance: 'The auth state became inconsistent. Clear the credentials and pair again.',
    shouldReconnect: false,
    loggedOut: true,
  },
  503: {
    cause: 'Service unavailable',
    guidance: 'Instability on the WhatsApp side. Reconnect with a longer wait.',
    shouldReconnect: true,
    loggedOut: false,
  },
  515: {
    cause: 'Restart required',
    guidance:
      'The protocol asks for the socket to be recreated right after pairing. This is expected and reconnection is immediate.',
    shouldReconnect: true,
    loggedOut: false,
  },
}

export function describeDisconnect(rawCode: number | null | undefined): DisconnectInfo {
  if (rawCode == null) return UNKNOWN
  return TABLE[rawCode] ?? UNKNOWN
}

/**
 * Extrai o código de status de um erro do Baileys sem depender do tipo do Boom.
 * O formato é `error.output.statusCode`.
 */
export function statusCodeFromError(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null

  const output = (error as { output?: unknown }).output
  if (typeof output === 'object' && output !== null) {
    const code = (output as { statusCode?: unknown }).statusCode
    if (typeof code === 'number') return code
  }

  const direct = (error as { statusCode?: unknown }).statusCode
  return typeof direct === 'number' ? direct : null
}

/** Espera antes da próxima tentativa de conexão: de 1 s até o teto de 5 min. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  return exponentialBackoff({ attempt, baseMs: 1000, capMs: 300_000, random })
}
