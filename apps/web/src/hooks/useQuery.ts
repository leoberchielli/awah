import { useCallback, useEffect, useRef, useState } from 'react'
import { type ApiError, get } from '../lib/api'

export interface QueryState<T> {
  data: T | null
  error: ApiError | Error | null
  loading: boolean
  /** Já houve pelo menos uma resposta. Distingue "carregando" de "revalidando". */
  settled: boolean
  refetch: () => void
}

/**
 * Busca com polling, sem biblioteca de estado de servidor.
 *
 * Um dashboard de operação precisa de três coisas: repetir a chamada, cancelar a
 * anterior e não piscar o layout enquanto revalida. Isso cabe em quarenta linhas
 * e evita somar uns cem quilobytes ao bundle de uma ferramenta interna — a
 * mesma lógica de leveza que vale para a imagem do servidor vale aqui.
 */
export function useQuery<T>(path: string | null, intervalMs = 0): QueryState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const [settled, setSettled] = useState(false)

  // Só a resposta da requisição mais recente pode escrever no estado.
  const geracao = useRef(0)

  const executar = useCallback(async () => {
    if (!path) return
    const minha = ++geracao.current

    setLoading(true)
    try {
      const resposta = await get<T>(path)
      if (minha !== geracao.current) return
      setData(resposta)
      setError(null)
    } catch (falha) {
      if (minha !== geracao.current) return
      setError(falha as Error)
    } finally {
      if (minha === geracao.current) {
        setLoading(false)
        setSettled(true)
      }
    }
  }, [path])

  useEffect(() => {
    void executar()
    if (!intervalMs) return

    const timer = setInterval(() => {
      // Aba escondida não gera tráfego: o navegador congela o timer de qualquer
      // forma, e acordar com uma rajada de requisições só atrapalha.
      if (document.visibilityState === 'visible') void executar()
    }, intervalMs)

    return () => clearInterval(timer)
  }, [executar, intervalMs])

  return { data, error, loading, settled, refetch: executar }
}
