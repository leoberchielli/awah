import type { Tone } from '../components/ui'
import type { Translate, TranslationKey } from '../i18n'

/**
 * Session status, in one place.
 *
 * Three screens show it, and the label and the colour were copied into two of
 * them independently — so a new engine status would have shown up translated on
 * one screen and raw on another, depending on where someone remembered to
 * update. The engine owns the values; this file owns how they read.
 */
const STATUS: Record<string, { key: TranslationKey; tone: Tone }> = {
  connected: { key: 'status.connected', tone: 'ok' },
  connecting: { key: 'status.connecting', tone: 'warn' },
  pairing: { key: 'status.pairing', tone: 'warn' },
  created: { key: 'status.created', tone: 'hold' },
  disconnected: { key: 'status.disconnected', tone: 'crit' },
  logged_out: { key: 'status.logged_out', tone: 'crit' },
  banned: { key: 'status.banned', tone: 'crit' },
}

/** Falls back to the raw value: a status we do not know is better shown than hidden. */
export function statusLabel(t: Translate, status: string): string {
  const known = STATUS[status]
  return known ? t(known.key) : status
}

export function statusTone(status: string): Tone {
  return STATUS[status]?.tone ?? 'hold'
}
