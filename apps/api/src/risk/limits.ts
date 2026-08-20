/**
 * Send caps per session, before warm-up.
 *
 * The numbers are not exact — WhatsApp does not publish its limits, and anyone
 * who claims to know them is guessing. What observation does tell us is the
 * shape of the problem: high volume on a fresh number, lots of recipients who
 * never replied, and blasting at a constant rate are the patterns that come
 * before a block. The defaults below are conservative on purpose; a mature
 * number with a history of real conversation can raise them per session.
 */
export interface SessionLimits {
  perMinute: number
  perHour: number
  perDay: number
  /** Recipients this session has never contacted, per day. */
  newContactsPerDay: number
}

export const DEFAULT_LIMITS: SessionLimits = {
  perMinute: 12,
  perHour: 250,
  perDay: 1000,
  newContactsPerDay: 100,
}

/**
 * Reads the limits stored in `sessions.config`, falling back to the defaults
 * when the field is missing or came back corrupted. Invalid configuration must
 * never unlock the limit — when in doubt, the conservative value wins.
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
