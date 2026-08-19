/**
 * Erro da API, com o `code` preservado.
 *
 * O `code` é contrato público do AWAH — mensagens mudam de versão para versão,
 * códigos não. Quem trata `session_not_connected` de um jeito e
 * `risk_budget_exhausted` de outro faz branch nele, nunca no texto.
 */
export class AwahError extends Error {
  override readonly name = 'AwahError'

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Corpo cru, para quando o servidor devolver algo fora do envelope. */
    readonly body?: unknown,
  ) {
    super(message)
  }

  /** Erro de credencial: nem retry nem espera resolvem. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }

  /** O servidor pediu para desacelerar. */
  get isRateLimited(): boolean {
    return this.status === 429
  }

  /** Vale tentar de novo — o SDK já faz isso sozinho dentro da política. */
  get isRetryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500
  }
}

/** A requisição não chegou a receber resposta: rede, DNS, timeout do cliente. */
export class AwahConnectionError extends Error {
  override readonly name = 'AwahConnectionError'

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}
