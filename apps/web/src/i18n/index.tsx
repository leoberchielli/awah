import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { type Catalog, en, type TranslationKey } from './locales/en'
import { detectLocale, FALLBACK, findLocale, LOCALES } from './registry'

export type { TranslationKey } from './locales/en'
export { findLocale, LOCALES, type Locale } from './registry'

const STORAGE_KEY = 'awah_lang'

export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string

interface I18nState {
  locale: string
  t: Translate
  setLocale: (code: string) => void
}

const Context = createContext<I18nState | null>(null)

/**
 * Replaces `{name}` with the given values.
 *
 * Interpolation rather than concatenation, because word order changes between
 * languages: assembling "sent {n} of {total}" from fragments reads correctly in
 * English and wrongly in most everything else.
 */
function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (raw, key) => (key in vars ? String(vars[key]) : raw))
}

function readPreference(): string {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  if (saved && findLocale(saved)) return saved
  return detectLocale(navigator.languages ?? [navigator.language])
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(readPreference)
  const [catalog, setCatalog] = useState<Catalog>(en)

  useEffect(() => {
    let cancelled = false
    const target = findLocale(locale) ?? findLocale(FALLBACK)
    if (!target) return

    document.documentElement.lang = target.code
    document.documentElement.dir = target.dir

    if (target.code === FALLBACK) {
      setCatalog(en)
      return
    }

    target
      .load()
      .then((loaded) => {
        if (!cancelled) setCatalog(loaded)
      })
      .catch(() => {
        // A catalog that fails to load must not blank the interface: English is
        // already in the bundle and keeps serving.
        if (!cancelled) setCatalog(en)
      })

    return () => {
      cancelled = true
    }
  }, [locale])

  const t = useCallback<Translate>(
    (key, vars) => interpolate(catalog[key] ?? en[key] ?? key, vars),
    [catalog],
  )

  const setLocale = useCallback((code: string) => {
    if (!findLocale(code)) return
    localStorage.setItem(STORAGE_KEY, code)
    setLocaleState(code)
  }, [])

  return <Context.Provider value={{ locale, t, setLocale }}>{children}</Context.Provider>
}

export function useI18n(): I18nState {
  const state = useContext(Context)
  if (!state) throw new Error('useI18n used outside I18nProvider')
  return state
}

/** Shorthand for components that only need to translate. */
export function useT(): Translate {
  return useI18n().t
}

export function availableLocales() {
  return LOCALES
}
