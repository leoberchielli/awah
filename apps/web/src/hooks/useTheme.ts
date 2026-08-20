import { useEffect, useState } from 'react'

export type Tema = 'system' | 'light' | 'dark'

const CHAVE = 'awah:tema'

function ler(): Tema {
  const salvo = localStorage.getItem(CHAVE)
  return salvo === 'light' || salvo === 'dark' ? salvo : 'system'
}

/**
 * Theme in three states, not two.
 *
 * "system" writes nothing to the document: with no attribute there,
 * `prefers-color-scheme` is in charge, which is the right behaviour for anyone
 * who never chose.
 */
export function useTheme(): [Tema, (proximo: Tema) => void] {
  const [tema, setTema] = useState<Tema>(ler)

  useEffect(() => {
    if (tema === 'system') {
      document.documentElement.removeAttribute('data-theme')
      localStorage.removeItem(CHAVE)
    } else {
      document.documentElement.setAttribute('data-theme', tema)
      localStorage.setItem(CHAVE, tema)
    }
  }, [tema])

  return [tema, setTema]
}
