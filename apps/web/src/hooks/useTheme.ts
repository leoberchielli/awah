import { useEffect, useState } from 'react'

export type Theme = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'awah:tema'

function ler(): Theme {
  const salvo = localStorage.getItem(STORAGE_KEY)
  return salvo === 'light' || salvo === 'dark' ? salvo : 'system'
}

/**
 * Theme in three states, not two.
 *
 * "system" writes nothing to the document: with no attribute there,
 * `prefers-color-scheme` is in charge, which is the right behaviour for anyone
 * who never chose.
 */
export function useTheme(): [Theme, (next: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(ler)

  useEffect(() => {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme')
      localStorage.removeItem(STORAGE_KEY)
    } else {
      document.documentElement.setAttribute('data-theme', theme)
      localStorage.setItem(STORAGE_KEY, theme)
    }
  }, [theme])

  return [theme, setTheme]
}
