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
export function usarIdioma(code: string): void {
  ativo = code
  cache.clear()
}

/** One formatter per (kind, language). Rebuilding them per cell is not free. */
const cache = new Map<string, Intl.NumberFormat | Intl.RelativeTimeFormat>()

function numFmt(chave: string, opcoes: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = `${chave}:${ativo}`
  const existente = cache.get(k)
  if (existente) return existente as Intl.NumberFormat
  const criado = new Intl.NumberFormat(ativo, opcoes)
  cache.set(k, criado)
  return criado
}

function relFmt(): Intl.RelativeTimeFormat {
  const k = `rel:${ativo}`
  const existente = cache.get(k)
  if (existente) return existente as Intl.RelativeTimeFormat
  const criado = new Intl.RelativeTimeFormat(ativo, { numeric: 'auto' })
  cache.set(k, criado)
  return criado
}

export const num = (valor: number): string => numFmt('int', {}).format(Math.round(valor))

export function pct(fracao: number): string {
  return numFmt('pct', { style: 'percent', maximumFractionDigits: 1 }).format(fracao)
}

/** Unit names come from `Intl` too, so `min` is `мин` in Russian and `د` in Arabic. */
function comUnidade(valor: number, unit: string, casas = 1): string {
  return numFmt(`u:${unit}:${casas}`, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: casas,
  }).format(valor)
}

/** Readable duration: "3.2 s" lands faster than "3200 ms". */
export function duracao(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return comUnidade(Math.round(ms), 'millisecond', 0)
  if (ms < 60_000) return comUnidade(ms / 1000, 'second')
  if (ms < 3_600_000) return comUnidade(ms / 60_000, 'minute')
  return comUnidade(ms / 3_600_000, 'hour')
}

export function minutos(valor: number | null): string {
  if (valor === null) return '—'
  if (valor < 60) return comUnidade(Math.round(valor), 'minute', 0)
  if (valor < 1440) return comUnidade(valor / 60, 'hour')
  return comUnidade(valor / 1440, 'day')
}

/**
 * How long ago, in the reader's language.
 *
 * `numeric: 'auto'` is what produces "yesterday" instead of "1 day ago" where a
 * language has the word, and it is also what makes the under-a-minute case read
 * as "now" rather than "in 0 seconds".
 */
export function desde(iso: string | null): string {
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
export function janela(valor: number, unidade: 'hour' | 'day'): string {
  return comUnidade(valor, unidade, 0)
}

export function horario(iso: string | Date): string {
  const data = typeof iso === 'string' ? new Date(iso) : iso
  return data.toLocaleTimeString(ativo, { hour: '2-digit', minute: '2-digit' })
}

export function dataHora(iso: string | Date): string {
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
export function telefone(valor: string | null): string {
  if (!valor) return '—'
  const digitos = valor.replace(/\D/g, '')
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
  const semSufixo = chatId.replace(/@.*$/, '')
  if (chatId.includes('@g.us')) return rotularGrupo(semSufixo.slice(-6))
  return telefone(semSufixo)
}
