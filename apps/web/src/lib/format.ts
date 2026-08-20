/**
 * Shared formatting. Written once, so the numbers agree across screens.
 *
 * Everything here follows the language the panel is in. That is not politeness:
 * a decimal comma read as a decimal point turns 3,2 s into 32 s, and an
 * operator reading a latency chart during an incident has no reason to suspect
 * the separator.
 *
 * `Intl` does the localising rather than the catalog, because the catalog has
 * no plural machinery. Arabic needs four forms for a count and Russian three;
 * `RelativeTimeFormat` and `NumberFormat` already know all of them, and no
 * translator has to be asked for something a single string cannot express.
 */

import { FALLBACK } from '../i18n/registry'

let ativo: string = FALLBACK

/**
 * Told by the i18n provider whenever the language changes.
 *
 * A module-level value rather than a hook because these are called from chart
 * tick callbacks and table cells, where threading a context through every call
 * site would cost more than it explains. There is exactly one active language
 * at a time, so a module holds it honestly.
 */
export function setFormatLocale(code: string): void {
  ativo = code
  cache.clear()
}

/** One formatter per (kind, language). Rebuilding them per cell is not free. */
const cache = new Map<string, Intl.NumberFormat | Intl.RelativeTimeFormat>()

function numFmt(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = `${key}:${ativo}`
  const existente = cache.get(k)
  if (existente) return existente as Intl.NumberFormat
  const created = new Intl.NumberFormat(ativo, options)
  cache.set(k, created)
  return created
}

function relFmt(): Intl.RelativeTimeFormat {
  const k = `rel:${ativo}`
  const existente = cache.get(k)
  if (existente) return existente as Intl.RelativeTimeFormat
  const created = new Intl.RelativeTimeFormat(ativo, { numeric: 'auto' })
  cache.set(k, created)
  return created
}

export const num = (value: number): string => numFmt('int', {}).format(Math.round(value))

export function pct(fraction: number): string {
  return numFmt('pct', { style: 'percent', maximumFractionDigits: 1 }).format(fraction)
}

/** Unit names come from `Intl` too, so `min` is `мин` in Russian and `د` in Arabic. */
function withUnit(value: number, unit: string, casas = 1): string {
  return numFmt(`u:${unit}:${casas}`, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: casas,
  }).format(value)
}

/** Readable duration: "3.2 s" lands faster than "3200 ms". */
export function duration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return withUnit(Math.round(ms), 'millisecond', 0)
  if (ms < 60_000) return withUnit(ms / 1000, 'second')
  if (ms < 3_600_000) return withUnit(ms / 60_000, 'minute')
  return withUnit(ms / 3_600_000, 'hour')
}

export function minutes(value: number | null): string {
  if (value === null) return '—'
  if (value < 60) return withUnit(Math.round(value), 'minute', 0)
  if (value < 1440) return withUnit(value / 60, 'hour')
  return withUnit(value / 1440, 'day')
}

/**
 * How long ago, in the reader's language.
 *
 * `numeric: 'auto'` is what produces "yesterday" instead of "1 day ago" where a
 * language has the word, and it is also what makes the under-a-minute case read
 * as "now" rather than "in 0 seconds".
 */
export function since(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const rel = relFmt()
  if (ms < 60_000) return rel.format(0, 'second')
  if (ms < 3_600_000) return rel.format(-Math.round(ms / 60_000), 'minute')
  if (ms < 86_400_000) return rel.format(-Math.round(ms / 3_600_000), 'hour')
  return rel.format(-Math.round(ms / 86_400_000), 'day')
}

/**
 * Label for the time-window control.
 *
 * This does not come from the catalog because no single string can be right:
 * Arabic needs one form for 7 days (`7 أيام`) and another for 30 (`30 يومًا`),
 * and Russian needs a third for 1. `Intl` already carries every language's
 * plural rules, so nobody has to be asked for a form the catalog cannot hold.
 */
export function windowLabel(value: number, unit: 'hour' | 'day'): string {
  return withUnit(value, unit, 0)
}

export function timeOfDay(iso: string | Date): string {
  const data = typeof iso === 'string' ? new Date(iso) : iso
  return data.toLocaleTimeString(ativo, { hour: '2-digit', minute: '2-digit' })
}

export function dateTime(iso: string | Date): string {
  const data = typeof iso === 'string' ? new Date(iso) : iso
  return data.toLocaleString(ativo, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * A Brazilian number is unreadable without separation; everything else passes
 * through raw.
 *
 * This one does not follow the language, because it describes the number's
 * country and not the reader's: +55 (11) 99350-9185 is how that number is
 * written whoever is looking at it.
 */
export function telefone(value: string | null): string {
  if (!value) return '—'
  const digitos = value.replace(/\D/g, '')
  if (digitos.length === 13 && digitos.startsWith('55')) {
    return `+55 (${digitos.slice(2, 4)}) ${digitos.slice(4, 9)}-${digitos.slice(9)}`
  }
  if (digitos.length === 12 && digitos.startsWith('55')) {
    return `+55 (${digitos.slice(2, 4)}) ${digitos.slice(4, 8)}-${digitos.slice(8)}`
  }
  return `+${digitos}`
}

/**
 * A whole JID eats the column and says nothing the number does not.
 *
 * Takes `t` because a group has to be named as a group in the reader's
 * language; the tail of the JID is what distinguishes one from another.
 */
export function chat(chatId: string, rotularGrupo: (id: string) => string): string {
  const withoutSuffix = chatId.replace(/@.*$/, '')
  if (chatId.includes('@g.us')) return rotularGrupo(withoutSuffix.slice(-6))
  return telefone(withoutSuffix)
}
