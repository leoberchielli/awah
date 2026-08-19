export interface BackoffOptions {
  /** Tentativa já consumida, começando em 1. */
  attempt: number
  baseMs: number
  capMs: number
  /** Fração de aleatoriedade somada ao topo, entre 0 e 1. */
  jitterRatio?: number
  random?: () => number
}

/**
 * Espera exponencial com teto e jitter.
 *
 * O jitter não é enfeite. Sem ele, tudo que falha junto — uma sessão que cai,
 * um endpoint de webhook que sai do ar, o banco que reinicia — volta junto, no
 * mesmo milissegundo, e repete a rajada a cada ciclo. O efeito é uma
 * autoagressão periódica que só piora conforme a fila cresce.
 */
export function exponentialBackoff(options: BackoffOptions): number {
  const { attempt, baseMs, capMs, jitterRatio = 0.25, random = Math.random } = options

  const exponent = Math.max(0, attempt - 1)
  const base = Math.min(baseMs * 2 ** exponent, capMs)
  return Math.round(base + base * jitterRatio * random())
}
