/**
 * An API error, with the `code` preserved.
 *
 * The `code` is AWAH's public contract — messages change from version to
 * version, codes do not. If you handle `session_not_connected` one way and
 * `risk_budget_exhausted` another, branch on the code, never on the text.
 */
export class AwahError extends Error {
  override readonly name = 'AwahError'

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** Raw body, for when the server returns something outside the envelope. */
    readonly body?: unknown,
  ) {
    super(message)
  }

  /** A credential error: neither a retry nor waiting will fix it. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }

  /** The server asked you to slow down. */
  get isRateLimited(): boolean {
    return this.status === 429
  }

  /** Worth trying again — the SDK already does it for you, within its policy. */
  get isRetryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500
  }
}

/** The request never got a response at all: network, DNS, client timeout. */
export class AwahConnectionError extends Error {
  override readonly name = 'AwahConnectionError'

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
  }
}
