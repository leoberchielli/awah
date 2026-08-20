import type { Catalog } from './locales/en'

export interface Locale {
  code: string
  /**
   * The name written in its own language.
   *
   * A menu that offers "German" to a German is backwards: someone who cannot
   * read the current interface is exactly the person who needs to find their
   * own language in it.
   */
  name: string
  dir: 'ltr' | 'rtl'
  /**
   * Loaded on demand.
   *
   * Ten catalogs bundled together would ship every language to every visitor to
   * serve one. Vite splits each into its own chunk, so the cost of supporting a
   * language the community adds later is paid only by whoever picks it.
   */
  load: () => Promise<Catalog>
}

/**
 * The languages that ship with the project.
 *
 * Chosen by where WhatsApp is infrastructure rather than an app — India,
 * Brazil, Indonesia, Latin America, the Arab world, Russia, Turkey — plus the
 * European languages a gateway is most often integrated in. Adding an
 * eleventh is one entry here and one file next to it; nothing else in the
 * codebase knows how many there are.
 */
export const LOCALES: Locale[] = [
  { code: 'en', name: 'English', dir: 'ltr', load: async () => (await import('./locales/en')).en },
  {
    code: 'pt-BR',
    name: 'Português (Brasil)',
    dir: 'ltr',
    load: async () => (await import('./locales/pt-BR')).ptBR,
  },
  { code: 'es', name: 'Español', dir: 'ltr', load: async () => (await import('./locales/es')).es },
  { code: 'hi', name: 'हिन्दी', dir: 'ltr', load: async () => (await import('./locales/hi')).hi },
  {
    code: 'id',
    name: 'Bahasa Indonesia',
    dir: 'ltr',
    load: async () => (await import('./locales/id')).id,
  },
  { code: 'ar', name: 'العربية', dir: 'rtl', load: async () => (await import('./locales/ar')).ar },
  { code: 'fr', name: 'Français', dir: 'ltr', load: async () => (await import('./locales/fr')).fr },
  { code: 'de', name: 'Deutsch', dir: 'ltr', load: async () => (await import('./locales/de')).de },
  { code: 'ru', name: 'Русский', dir: 'ltr', load: async () => (await import('./locales/ru')).ru },
  { code: 'tr', name: 'Türkçe', dir: 'ltr', load: async () => (await import('./locales/tr')).tr },
]

export const FALLBACK = 'en'

export function findLocale(code: string): Locale | undefined {
  return LOCALES.find((locale) => locale.code === code)
}

/**
 * Picks a language from what the browser advertises.
 *
 * Matches the exact tag first, then the base tag, so a browser asking for
 * `pt-PT` lands on `pt-BR` — an imperfect match a Portuguese speaker can read,
 * which beats English. Falls back to English when nothing matches.
 */
export function detectLocale(preferred: readonly string[]): string {
  for (const tag of preferred) {
    const exact = LOCALES.find((locale) => locale.code.toLowerCase() === tag.toLowerCase())
    if (exact) return exact.code

    const base = tag.split('-')[0]?.toLowerCase()
    if (!base) continue

    const loose = LOCALES.find((locale) => locale.code.split('-')[0]?.toLowerCase() === base)
    if (loose) return loose.code
  }

  return FALLBACK
}
