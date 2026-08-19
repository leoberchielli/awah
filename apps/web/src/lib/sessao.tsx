import { createContext, useContext } from 'react'
import type { Me, Papel } from './api'

const Contexto = createContext<Me | null>(null)

export const ProvedorDeSessao = Contexto.Provider

/**
 * Quem está logado.
 *
 * O `Autenticado` já busca isto para decidir se mostra o painel; repetir a
 * chamada em cada tela que precisa do papel seria desperdício, e pior, abriria
 * a janela em que uma tela acha que é admin e outra ainda não sabe.
 */
export function useMe(): Me {
  const me = useContext(Contexto)
  if (!me) throw new Error('useMe usado fora do provedor de sessão')
  return me
}

const RANK: Record<Papel, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 }

/**
 * Espelha a hierarquia do servidor.
 *
 * Aqui é só para não oferecer o que vai levar 403 — a autorização de verdade
 * continua sendo do servidor, e esta cópia nunca decide nada sozinha.
 */
export function papelAoMenos(papel: string, minimo: Papel): boolean {
  const rank = RANK[papel as Papel]
  return rank !== undefined && rank >= RANK[minimo]
}
