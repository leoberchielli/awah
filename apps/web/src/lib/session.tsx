import { createContext, useContext } from 'react'
import type { Me, Role } from './api'

const SessionContext = createContext<Me | null>(null)

export const SessionProvider = SessionContext.Provider

/**
 * Who is signed in.
 *
 * `Authenticated` already fetches this to decide whether to show the panel;
 * repeating the call on every screen that needs the role would be waste, and
 * worse, would open a window where one screen thinks it is admin and another
 * does not know yet.
 */
export function useMe(): Me {
  const me = useContext(SessionContext)
  if (!me) throw new Error('useMe used outside the session provider')
  return me
}

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 }

/**
 * Mirrors the server's hierarchy.
 *
 * This exists only so we do not offer what will come back 403 — the real
 * authorization stays with the server, and this copy never decides anything on
 * its own.
 */
export function roleAtLeast(role: string, floor: Role): boolean {
  const rank = RANK[role as Role]
  return rank !== undefined && rank >= RANK[floor]
}
