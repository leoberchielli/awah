import { useEffect, useState } from 'react'

export type Tema = 'system' | 'light' | 'dark'

const CHAVE = 'awah:tema'

function ler(): Tema {
  const salvo = localStorage.getItem(CHAVE)
  return salvo === 'light' || salvo === 'dark' ? salvo : 'system'
}

/**
 * Tema em três estados, não dois.
 *
 * "system" não escreve nada no documento: sem o atributo, quem manda é o
 * `prefers-color-scheme`, que é o comportamento certo para quem nunca escolheu.
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
