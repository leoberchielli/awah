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

const RETENTATIVA_BASE_MS = 300
const RETENTATIVA_TETO_MS = 8000

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
    const podeRepetir = pedido.idempotente ?? ['GET', 'HEAD', 'DELETE'].includes(pedido.method)

    let ultimoErro: unknown

    for (let tentativa = 0; tentativa <= this.maxRetries; tentativa++) {
      try {
        const resposta = await this.enviar(url, pedido)

        if (resposta.ok) return await this.lerCorpo<T>(resposta)

        const erro = await this.montarErro(resposta)

        /**
         * Repeating a 4xx that is not 408 or 429 is waste: the server rejected
         * the content, and sending it again produces the same rejection.
         */
        if (!erro.isRetryable || !podeRepetir || tentativa === this.maxRetries) throw erro

        await dormir(this.esperaAte(tentativa, resposta.headers.get('retry-after')))
        ultimoErro = erro
      } catch (falha) {
        if (falha instanceof AwahError) {
          if (!falha.isRetryable || !podeRepetir || tentativa === this.maxRetries) throw falha
          ultimoErro = falha
          continue
        }

        const conexao = new AwahConnectionError(
          falha instanceof Error ? falha.message : 'falha de rede',
          falha,
        )
        if (!podeRepetir || tentativa === this.maxRetries) throw conexao

        ultimoErro = conexao
        await dormir(this.esperaAte(tentativa, null))
      }
    }

    throw ultimoErro
  }

  private montarUrl(path: string, query?: Pedido['query']): string {
    const url = new URL(`${this.baseUrl}${path}`)

    for (const [chave, valor] of Object.entries(query ?? {})) {
      if (valor !== undefined) url.searchParams.set(chave, String(valor))
    }

    return url.toString()
  }

  private async enviar(url: string, pedido: Pedido): Promise<Response> {
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

  private async lerCorpo<T>(resposta: Response): Promise<T> {
    if (resposta.status === 204) return undefined as T

    const texto = await resposta.text()
    if (!texto) return undefined as T

    try {
      return JSON.parse(texto) as T
    } catch {
      return texto as T
    }
  }

  private async montarErro(resposta: Response): Promise<AwahError> {
    const corpo = await resposta
      .text()
      .then((texto) => (texto ? JSON.parse(texto) : null))
      .catch(() => null)

    const envelope = (corpo as { error?: { code?: string; message?: string; details?: unknown } })
      ?.error

    return new AwahError(
      resposta.status,
      envelope?.code ?? 'unknown',
      envelope?.message ?? `A API respondeu ${resposta.status}.`,
      envelope?.details,
      corpo,
    )
  }

  /**
   * Exponential backoff with jitter, and `Retry-After` above all else.
   *
   * The jitter is not decoration: without it, a hundred clients that took a 429
   * together come back together in the same millisecond and take a 429 again.
   */
  private esperaAte(tentativa: number, retryAfter: string | null): number {
    if (retryAfter) {
      const segundos = Number(retryAfter)
      if (Number.isFinite(segundos) && segundos >= 0) return Math.min(segundos * 1000, 60_000)
    }

    const teto = Math.min(RETENTATIVA_BASE_MS * 2 ** tentativa, RETENTATIVA_TETO_MS)
    return teto / 2 + Math.random() * (teto / 2)
  }
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
