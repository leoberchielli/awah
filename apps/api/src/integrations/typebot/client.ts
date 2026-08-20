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

interface ChatResponse {
  sessionId?: string
  messages?: TypebotMessage[]
  /** Present when the flow expects an answer. Absent means the flow is over. */
  input?: { type?: string } | null
}

export interface FlowTurn {
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

  private async request<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/api/v1${path}`, {
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

      const text = await response.text()
      const parsed = text ? safeJson(text) : null

      if (!response.ok) {
        const detail = (parsed as { message?: string })?.message ?? text.slice(0, 200)
        throw new TypebotError(response.status, `Typebot responded ${response.status}: ${detail}`)
      }

      return parsed as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** Validates the address and the flow before saving the integration. */
  async verify(): Promise<void> {
    await this.start()
  }

  async start(message?: string): Promise<FlowTurn> {
    const response = await this.request<ChatResponse>(
      `/typebots/${encodeURIComponent(this.config.typebotId)}/startChat`,
      { message: message, isStreamEnabled: false },
    )

    return toFlowTurn(response)
  }

  async resume(sessionId: string, message: string): Promise<FlowTurn> {
    const response = await this.request<ChatResponse>(
      `/sessions/${encodeURIComponent(sessionId)}/continueChat`,
      { message: message },
    )

    return { ...toFlowTurn(response), sessionId }
  }
}

function toFlowTurn(response: ChatResponse): FlowTurn {
  return {
    sessionId: response.sessionId ?? null,
    texts: (response.messages ?? []).map(toText).filter((t): t is string => Boolean(t)),
    // With no `input`, the flow is over and the next message starts from zero.
    awaitingReply: Boolean(response.input),
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
    const text = message.content.richText.map(flatten).join('\n').trim()
    return text || null
  }

  if (message.content?.text) return message.content.text
  if (message.content?.url) return message.content.url

  return null
}

function flatten(block: RichTextBlock): string {
  if (block.text) return block.text
  return (block.children ?? []).map(flatten).join('')
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
export function deriveFromLink(link: string): { baseUrl: string; typebotId: string } {
  let url: URL
  try {
    url = new URL(link.trim())
  } catch {
    throw new Error('That does not look like a URL. Paste the share link of your flow.')
  }

  const segments = url.pathname.split('/').filter(Boolean)

  /**
   * The editor URL carries the internal id, which the Chat API does not accept.
   *
   * It is the most likely mistake for someone with Typebot open: copying from
   * the editor's address bar instead of the share link. Without this check the
   * integration is accepted and only fails later, on a customer's first message.
   */
  if (segments[0] === 'typebots' || url.hostname.startsWith('app.')) {
    throw new Error(
      'That is the editor link, which uses the internal flow id. Publish the flow and use the share link — under Share, in Typebot.',
    )
  }

  const typebotId = segments[0]
  if (!typebotId) {
    throw new Error(
      'Could not find the flow id in that link. It must end with the flow name, like https://typebot.io/my-flow.',
    )
  }

  return { baseUrl: url.origin, typebotId }
}
