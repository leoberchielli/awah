import { sign } from '../../webhooks/signature'
import type { HttpConfig } from '../config'

export class HttpConnectorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpConnectorError'
  }

  /** Wrong configuration on the other side: a retry gets the same refusal. */
  get isPermanente(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429
  }
}

/** What the gateway posts. Same shape as the `message.received` event. */
export interface EngineMessageEvent {
  event: 'message.received'
  data: {
    sessionId: string
    messageId: string
    chatId: string
    from: string | null
    type: string
    body: string | null
    timestamp: string
  }
}

export interface RespostaDoConector {
  status: number
  durationMs: number
  /** Texts that became messages. Empty is a valid answer: not every event needs one. */
  replies: string[]
  /** Raw body, truncated. Only so the test button can show what came back. */
  raw: string
  /**
   * Why the response did not become a message, when it did not. This is the
   * diagnosis that replaces the guesswork of someone who has just plugged in a
   * new platform.
   */
  diagnosis: string | null
}

/**
 * The escape hatch to any platform.
 *
 * An ordinary webhook tells you and forgets: its response is ignored. This
 * connector does question and answer — whatever comes back in the body becomes
 * a message, and enters through the same queue as any send, inheriting
 * per-conversation ordering, the risk engine and redelivery.
 *
 * It is the difference between "let me know when a message arrives" and "answer
 * for me", and it is what lets an n8n flow, a serverless function or the
 * in-house system **be** the bot, without anyone writing a dedicated connector
 * here.
 */
export class HttpConnector {
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly config: HttpConfig,
    options?: { fetch?: typeof fetch },
  ) {
    this.fetchImpl = options?.fetch ?? fetch
  }

  async send(evento: EngineMessageEvent): Promise<RespostaDoConector> {
    const body = JSON.stringify(evento)
    const timestamp = Math.floor(Date.now() / 1000)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const inicio = Date.now()

    try {
      const resposta = await this.fetchImpl(this.config.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'awah-gateway',
          /**
           * Same signature as the webhooks: HMAC over `timestamp.body`.
           *
           * Reusing the scheme is not code economy — it is so that anyone who
           * already validates an AWAH webhook validates this with the same
           * function, and so the SDK serves both without a second
           * implementation.
           */
          ...(this.config.secret
            ? {
                'x-awah-signature': sign(body, this.config.secret, timestamp),
                'x-awah-timestamp': String(timestamp),
              }
            : {}),
          ...this.config.headers,
        },
        body: body,
      })

      const durationMs = Date.now() - inicio
      const text = await resposta.text().catch(() => '')

      if (!resposta.ok) {
        throw new HttpConnectorError(
          resposta.status,
          `The platform responded ${resposta.status}: ${text.slice(0, 200)}`,
        )
      }

      const { replies, diagnosis } = extrairRespostas(text, this.config.replyPath)

      return {
        status: resposta.status,
        durationMs,
        replies,
        raw: text.slice(0, 2000),
        diagnosis: diagnosis,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Finds the reply texts, accepting the shapes that show up in practice.
 *
 * Being permissive here is an adoption decision: whoever builds a flow in n8n
 * returns `{"reply": "..."}` without thinking, and refusing that because the
 * docs asked for `replies` would be rigour that only produces frustration. What
 * **cannot** happen is silence — hence the diagnosis alongside.
 */
export function extrairRespostas(
  text: string,
  caminho?: string,
): { replies: string[]; diagnosis: string | null } {
  const limpo = text.trim()

  // An empty body is legitimate: not every event asks for a message back.
  if (!limpo) return { replies: [], diagnosis: null }

  let body: unknown
  try {
    body = JSON.parse(limpo)
  } catch {
    return {
      replies: [],
      diagnosis:
        'The response is not JSON. Return something like {"reply":"text"} — or an empty body, if there is no reply to send.',
    }
  }

  const alvo = caminho ? navigate(body, caminho) : body

  if (alvo === undefined) {
    return {
      replies: [],
      diagnosis: `Could not find "${caminho}" in the response. Check the configured path.`,
    }
  }

  const texts = normalizar(alvo)
  if (texts.length > 0) return { replies: texts, diagnosis: null }

  // An object with no recognised field is almost always a format mistake.
  if (typeof alvo === 'object' && alvo !== null && !Array.isArray(alvo)) {
    const keys = Object.keys(alvo as object)
      .slice(0, 6)
      .join(', ')
    return {
      replies: [],
      diagnosis: `The response came with ${keys || 'no fields'} — none of them is recognized as text. Use "reply", "replies" or "text".`,
    }
  }

  return { replies: [], diagnosis: null }
}

/** Accepts `reply`, `replies`, `text`, an array and a bare string. */
function normalizar(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value.trim()
    return text ? [text] : []
  }

  if (Array.isArray(value)) return value.flatMap(normalizar)

  if (typeof value === 'object' && value !== null) {
    const objeto = value as Record<string, unknown>
    for (const key of ['replies', 'reply', 'messages', 'message', 'text']) {
      if (key in objeto) return normalizar(objeto[key])
    }
  }

  return []
}

/** Dotted path, for anyone who returns the reply nested. */
function navigate(body: unknown, caminho: string): unknown {
  return caminho
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, parte) => {
      if (typeof current !== 'object' || current === null) return undefined
      return (current as Record<string, unknown>)[parte]
    }, body)
}

/**
 * The test button's sample event.
 *
 * It has the same shape as the real one on purpose: whoever builds the flow on
 * the other side can put the whole thing together on top of this sample and
 * then just switch it on. The number is the one reserved for documentation, so
 * that nobody ends up answering a stranger.
 */
export const EVENTO_DE_TESTE: EngineMessageEvent = {
  event: 'message.received',
  data: {
    sessionId: '00000000-0000-0000-0000-000000000000',
    messageId: 'wamid.TESTE',
    chatId: '5511999999999@s.whatsapp.net',
    from: '5511999999999@s.whatsapp.net',
    type: 'text',
    body: 'Mensagem de teste do AWAH',
    timestamp: '2026-01-01T12:00:00.000Z',
  },
}
