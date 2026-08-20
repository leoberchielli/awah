import type { TypebotConfig } from '../config'

export class TypebotError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'TypebotError'
  }

  get isPermanente(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429
  }

  /**
   * The flow session ended on the Typebot side.
   *
   * It happens when the flow reaches its end or when their server is
   * restarted. It is not a failure: it is the signal that the next message
   * starts a new flow, and treating it as an error would leave that contact
   * without an answer forever.
   */
  get sessaoExpirada(): boolean {
    return this.status === 404
  }
}

interface RichTextBlock {
  type?: string
  text?: string
  children?: RichTextBlock[]
}

interface TypebotMessage {
  type?: string
  content?: {
    richText?: RichTextBlock[]
    url?: string
    text?: string
  }
}

interface RespostaChat {
  sessionId?: string
  messages?: TypebotMessage[]
  /** Present when the flow expects an answer. Absent means the flow is over. */
  input?: { type?: string } | null
}

export interface TurnoDeFluxo {
  sessionId: string | null
  texts: string[]
  /** False when the flow has finished and expects nothing more. */
  awaitingReply: boolean
}

/**
 * Client for Typebot's Chat API.
 *
 * The flow lives over there; all that passes through here is the customer's
 * message and the answer the flow produced. It is what lets the operator design
 * in Typebot's editor, which is already good, and still get the durable
 * delivery and the risk engine of the gateway underneath.
 */
export class TypebotClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(
    private readonly config: TypebotConfig,
    options?: { fetch?: typeof fetch; timeoutMs?: number },
  ) {
    this.fetchImpl = options?.fetch ?? fetch
    this.timeoutMs = options?.timeoutMs ?? 20_000
  }

  private async request<T>(caminho: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const resposta = await this.fetchImpl(`${this.config.baseUrl}/api/v1${caminho}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiToken
            ? { authorization: `Bearer ${this.config.apiToken}` }
            : undefined),
        },
        body: JSON.stringify(body),
      })

      const text = await resposta.text()
      const parsed = text ? safeJson(text) : null

      if (!resposta.ok) {
        const detalhe = (parsed as { message?: string })?.message ?? text.slice(0, 200)
        throw new TypebotError(resposta.status, `Typebot responded ${resposta.status}: ${detalhe}`)
      }

      return parsed as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** Validates the address and the flow before saving the integration. */
  async verify(): Promise<void> {
    await this.iniciar()
  }

  async iniciar(message?: string): Promise<TurnoDeFluxo> {
    const resposta = await this.request<RespostaChat>(
      `/typebots/${encodeURIComponent(this.config.typebotId)}/startChat`,
      { message: message, isStreamEnabled: false },
    )

    return interpretar(resposta)
  }

  async continuar(sessionId: string, message: string): Promise<TurnoDeFluxo> {
    const resposta = await this.request<RespostaChat>(
      `/sessions/${encodeURIComponent(sessionId)}/continueChat`,
      { message: message },
    )

    return { ...interpretar(resposta), sessionId }
  }
}

function interpretar(resposta: RespostaChat): TurnoDeFluxo {
  return {
    sessionId: resposta.sessionId ?? null,
    texts: (resposta.messages ?? []).map(toText).filter((t): t is string => Boolean(t)),
    // With no `input`, the flow is over and the next message starts from zero.
    awaitingReply: Boolean(resposta.input),
  }
}

/**
 * Flattens Typebot's format into the text WhatsApp accepts.
 *
 * `richText` is a tree of paragraphs with children; WhatsApp only understands
 * running text. Media becomes the URL — honest and useful while the gateway
 * does not send attachments, and better than swallowing the message in silence.
 */
function toText(message: TypebotMessage): string | null {
  if (message.content?.richText?.length) {
    const text = message.content.richText.map(achatar).join('\n').trim()
    return text || null
  }

  if (message.content?.text) return message.content.text
  if (message.content?.url) return message.content.url

  return null
}

function achatar(bloco: RichTextBlock): string {
  if (bloco.text) return bloco.text
  return (bloco.children ?? []).map(achatar).join('')
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Derives the address and the flow id from the link the person already has.
 *
 * Asking for "baseUrl" and "typebotId" in separate fields forces the integrator
 * to know what a `publicId` is and where it shows up. The share link already has
 * both, and it is what is on the clipboard of someone who has just published a
 * flow.
 */
export function derivarDoLink(link: string): { baseUrl: string; typebotId: string } {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    throw new Error('That does not look like a URL. Paste the share link of your flow.')
  }

  const partes = url.pathname.split('/').filter(Boolean)

  /**
   * The editor URL carries the internal id, which the Chat API does not accept.
   *
   * It is the most likely mistake for someone with Typebot open: copying from
   * the editor's address bar instead of the share link. Without this check the
   * integration is accepted and only fails later, on a customer's first message.
   */
  if (partes[0] === 'typebots' || url.hostname.startsWith('app.')) {
    throw new Error(
      'That is the editor link, which uses the internal flow id. Publish the flow and use the share link — under Share, in Typebot.',
    )
  }

  const typebotId = partes[0]
  if (!typebotId) {
    throw new Error(
      'Could not find the flow id in that link. It must end with the flow name, like https://typebot.io/my-flow.',
    )
  }

  return { baseUrl: url.origin, typebotId }
}
