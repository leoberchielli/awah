import { useCallback, useEffect, useRef, useState } from 'react'
import { type ApiError, get } from '../lib/api'

export interface QueryState<T> {
  data: T | null
  error: ApiError | Error | null
  loading: boolean
  /** At least one response has landed. Tells "loading" apart from "revalidating". */
  settled: boolean
  refetch: () => void
}

/**
 * Polling fetch, without a server-state library.
 *
 * An operations dashboard needs three things: repeat the call, cancel the
 * previous one, and not flash the layout while revalidating. That fits in forty
 * lines and avoids adding a hundred kilobytes or so to the bundle of an
 * internal tool — the same argument for staying light that governs the server
 * image governs this.
 */
export function useQuery<T>(path: string | null, intervalMs = 0): QueryState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const [settled, setSettled] = useState(false)

  // Only the response from the most recent request may write to state.
  const generation = useRef(0)

  const run = useCallback(async () => {
    if (!path) return
    const mine = ++generation.current

    setLoading(true)
    try {
      const response = await get<T>(path)
      if (mine !== generation.current) return
      setData(response)
      setError(null)
    } catch (failure) {
      if (mine !== generation.current) return
      setError(failure as Error)
    } finally {
      if (mine === generation.current) {
        setLoading(false)
        setSettled(true)
      }
    }
  }, [path])

  useEffect(() => {
    void run()
    if (!intervalMs) return

    const timer = setInterval(() => {
      // A hidden tab generates no traffic: the browser freezes the timer
      // anyway, and waking up to a burst of requests only gets in the way.
      if (document.visibilityState === 'visible') void run()
    }, intervalMs)

    return () => clearInterval(timer)
  }, [run, intervalMs])

  return { data, error, loading, settled, refetch: run }
}
