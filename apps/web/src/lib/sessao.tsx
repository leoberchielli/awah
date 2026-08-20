import { createContext, useContext } from 'react'
import type { Me, Papel } from './api'

const Contexto = createContext<Me | null>(null)

export const ProvedorDeSessao = Contexto.Provider

/**
 * Who is signed in.
 *
 * `Autenticado` already fetches this to decide whether to show the panel;
 * repeating the call on every screen that needs the role would be waste, and
 * worse, would open a window where one screen thinks it is admin and another
 * does not know yet.
 */
export function useMe(): Me {
  const me = useContext(Contexto)
  if (!me) throw new Error('useMe usado fora do provedor de sessão')
  return me
}

const RANK: Record<Papel, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 }

/**
 * Mirrors the server's hierarchy.
 *
 * This exists only so we do not offer what will come back 403 — the real
 * authorization stays with the server, and this copy never decides anything on
 * its own.
 */
export function papelAoMenos(papel: string, minimo: Papel): boolean {
  const rank = RANK[papel as Papel]
  return rank !== undefined && rank >= RANK[minimo]
}
