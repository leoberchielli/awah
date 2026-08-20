import { exponentialBackoff } from '../lib/backoff'

/**
 * Translation of the protocol's disconnect codes into a readable cause.
 *
 * This table is small and it is a good part of the product's value. Anyone
 * running Baileys today sees `Connection Closed` in the log and cannot tell
 * whether the internet dropped, whether WhatsApp Web was opened in another tab
 * or whether the number was banned — three incidents with completely different
 * answers. The dashboard's disconnect timeline reads from here.
 */
export interface DisconnectInfo {
  /** Short phrase shown on the timeline. */
  cause: string
  /** What to do about it. */
  guidance: string
  /** Whether it is worth reconnecting on its own. */
  shouldReconnect: boolean
  /** Whether the credentials died and the session has to pair again. */
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
 * Pulls the status code out of a Baileys error without depending on the Boom
 * type. The shape is `error.output.statusCode`.
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

/** Wait before the next connection attempt: from 1 s up to a 5 min cap. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  return exponentialBackoff({ attempt, baseMs: 1000, capMs: 300_000, random })
}
