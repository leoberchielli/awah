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

interface RequestOptions {
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
      throw new Error('fetch is unavailable in this runtime; pass one in options.fetch')
    }
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const url = this.buildUrl(options.path, options.query)
    const canRetry = options.idempotente ?? ['GET', 'HEAD', 'DELETE'].includes(options.method)

    let lastError: unknown

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.send(url, options)

        if (response.ok) return await this.readBody<T>(response)

        const error = await this.buildError(response)

        /**
         * Repeating a 4xx that is not 408 or 429 is waste: the server rejected
         * the content, and sending it again produces the same rejection.
         */
        if (!error.isRetryable || !canRetry || attempt === this.maxRetries) throw error

        await sleep(this.waitUntil(attempt, response.headers.get('retry-after')))
        lastError = error
      } catch (failure) {
        if (failure instanceof AwahError) {
          if (!failure.isRetryable || !canRetry || attempt === this.maxRetries) throw failure
          lastError = failure
          continue
        }

        const connectionError = new AwahConnectionError(
          failure instanceof Error ? failure.message : 'network failure',
          failure,
        )
        if (!canRetry || attempt === this.maxRetries) throw connectionError

        lastError = connectionError
        await sleep(this.waitUntil(attempt, null))
      }
    }

    throw lastError
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(`${this.baseUrl}${path}`)

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    return url.toString()
  }

  private async send(url: string, options: RequestOptions): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      return await this.fetchImpl(url, {
        method: options.method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...this.headersExtras,
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private async readBody<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T

    const text = await response.text()
    if (!text) return undefined as T

    try {
      return JSON.parse(text) as T
    } catch {
      return text as T
    }
  }

  private async buildError(response: Response): Promise<AwahError> {
    const body = await response
      .text()
      .then((text) => (text ? JSON.parse(text) : null))
      .catch(() => null)

    const envelope = (body as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error

    return new AwahError(
      response.status,
      envelope?.code ?? 'unknown',
      envelope?.message ?? `A API respondeu ${response.status}.`,
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
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
    }

    const cap = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS)
    return cap / 2 + Math.random() * (cap / 2)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
