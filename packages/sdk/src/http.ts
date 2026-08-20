import { AwahConnectionError, AwahError } from './errors'

export interface AwahOptions {
  /** Address of the instance, with scheme. E.g. `https://awah.yourcompany.com`. */
  baseUrl: string
  /** Key in the form `awah_<prefix>_<secret>`. */
  apiKey: string
  /** Ceiling per request, including reading the body. Default 30 s. */
  timeoutMs?: number
  /** Extra attempts after the first one. Default 2. */
  maxRetries?: number
  /** Injectable for tests and for runtimes that bring their own fetch. */
  fetch?: typeof fetch
  /** Extra headers on every request. Handy for tracing. */
  headers?: Record<string, string>
}

interface Pedido {
  method: string
  path: string
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  /**
   * Whether repeating this call is safe. GET and DELETE are by nature; POST only
   * when the route takes an idempotency key, and that is why the client always
   * sends a `clientMessageId` on a send.
   */
  idempotente?: boolean
  headers?: Record<string, string>
}

const RETRY_BASE_MS = 300
const RETRY_CAP_MS = 8000

export class HttpClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch
  private readonly headersExtras: Record<string, string>

  constructor(options: AwahOptions) {
    if (!options.baseUrl) throw new Error('baseUrl is required')
    if (!options.apiKey) throw new Error('apiKey is required')

    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.maxRetries = options.maxRetries ?? 2
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.headersExtras = options.headers ?? {}

    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch indisponível neste runtime; passe um em options.fetch')
    }
  }

  async request<T>(pedido: Pedido): Promise<T> {
    const url = this.montarUrl(pedido.path, pedido.query)
    const canRetry = pedido.idempotente ?? ['GET', 'HEAD', 'DELETE'].includes(pedido.method)

    let lastError: unknown

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const resposta = await this.send(url, pedido)

        if (resposta.ok) return await this.readBody<T>(resposta)

        const error = await this.buildError(resposta)

        /**
         * Repeating a 4xx that is not 408 or 429 is waste: the server rejected
         * the content, and sending it again produces the same rejection.
         */
        if (!error.isRetryable || !canRetry || attempt === this.maxRetries) throw error

        await dormir(this.waitUntil(attempt, resposta.headers.get('retry-after')))
        lastError = error
      } catch (failure) {
        if (failure instanceof AwahError) {
          if (!failure.isRetryable || !canRetry || attempt === this.maxRetries) throw failure
          lastError = failure
          continue
        }

        const conexao = new AwahConnectionError(
          failure instanceof Error ? failure.message : 'falha de rede',
          failure,
        )
        if (!canRetry || attempt === this.maxRetries) throw conexao

        lastError = conexao
        await dormir(this.waitUntil(attempt, null))
      }
    }

    throw lastError
  }

  private montarUrl(path: string, query?: Pedido['query']): string {
    const url = new URL(`${this.baseUrl}${path}`)

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    return url.toString()
  }

  private async send(url: string, pedido: Pedido): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      return await this.fetchImpl(url, {
        method: pedido.method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(pedido.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...this.headersExtras,
          ...pedido.headers,
        },
        body: pedido.body === undefined ? undefined : JSON.stringify(pedido.body),
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private async readBody<T>(resposta: Response): Promise<T> {
    if (resposta.status === 204) return undefined as T

    const text = await resposta.text()
    if (!text) return undefined as T

    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  }

  private async buildError(resposta: Response): Promise<AwahError> {
    const body = await resposta
      .text()
      .then((text) => (text ? JSON.parse(text) : null))
      .catch(() => null)

    const envelope = (body as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error

    return new AwahError(
      resposta.status,
      envelope?.code ?? 'unknown',
      envelope?.message ?? `A API respondeu ${resposta.status}.`,
      envelope?.details,
      body,
    )
  }

  /**
   * Exponential backoff with jitter, and `Retry-After` above all else.
   *
   * The jitter is not decoration: without it, a hundred clients that took a 429
   * together come back together in the same millisecond and take a 429 again.
   */
  private waitUntil(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const segundos = Number(retryAfter)
      if (Number.isFinite(segundos) && segundos >= 0) return Math.min(segundos * 1000, 60_000)
    }

    const teto = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS)
    return teto / 2 + Math.random() * (teto / 2)
  }
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
