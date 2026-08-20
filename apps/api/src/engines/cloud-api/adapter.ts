import { badRequest } from '../../lib/errors'
import type { EngineAdapter, EngineCapabilities, EngineEventHandler, SendResult } from '../types'
import type { CloudApiCredentials } from './credentials'

/**
 * What the official engine does and what it does not.
 *
 * The matrix is not a documentation detail: it is the contract that lets
 * someone choose between the engines knowing what they give up. The Cloud API
 * has no groups and no presence, and only talks freely inside the 24 h window
 * that opens once the customer writes — outside it, Meta requires an approved
 * template.
 */
const CAPABILITIES: EngineCapabilities = {
  qrPairing: false,
  codePairing: false,
  groups: false,
  channels: false,
  presence: false,
  reactions: true,
  editMessage: false,
  freeformMessaging: false,
}

export interface CloudApiAdapterDeps {
  sessionId: string
  credentials: CloudApiCredentials
  onEvent: EngineEventHandler
  /** Injectable for tests; the global fetch by default. */
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string }
}

/**
 * Meta's official engine.
 *
 * The point of this implementation is not the Cloud API itself — it is that it
 * fits the same `EngineAdapter` as Baileys. With both behind one contract, an
 * integrator writes the code once and moves from the unofficial engine to the
 * official one by changing a line of configuration: start cheap and liable to
 * be blocked, end up expensive and bulletproof, without rewriting anything.
 *
 * There is no socket, session or pairing here. "Connecting" means checking that
 * the number exists and that the token answers; messages arrive by webhook, not
 * over a stream.
 */
export class CloudApiAdapter implements EngineAdapter {
  readonly engine = 'cloud_api' as const
  readonly capabilities = CAPABILITIES

  private ready = false
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(private readonly deps: CloudApiAdapterDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.timeoutMs = deps.requestTimeoutMs ?? 15_000
  }

  private get baseUrl(): string {
    const { graphVersion, phoneNumberId } = this.deps.credentials
    return `https://graph.facebook.com/${graphVersion}/${phoneNumberId}`
  }

  private async request(
    url: string,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; body: unknown }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.deps.credentials.accessToken}`,
          'content-type': 'application/json',
          ...init?.headers,
        },
      })

      const body = await response.json().catch(() => null)
      return { ok: response.ok, status: response.status, body }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * "Connecting" here means confirming that the token reaches the number.
   *
   * Failing early matters: without this check, a wrong credential would only
   * show up on the first message the customer tried to send, already inside the
   * queue and counting as a delivery failure.
   */
  async connect(): Promise<void> {
    this.deps.onEvent({ type: 'status', status: 'connecting' })

    const { ok, status, body } = await this.request(`${this.baseUrl}?fields=display_phone_number`)

    if (!ok) {
      const detalhe = (body as GraphError)?.error?.message ?? `HTTP ${status}`
      this.ready = false
      this.deps.onEvent({
        type: 'closed',
        rawCode: status,
        cause: `Credentials rejected by Meta: ${detalhe}`,
        shouldReconnect: false,
        // An invalid token needs reconfiguring, as a logout would need pairing.
        loggedOut: status === 401 || status === 403,
      })
      throw badRequest(`Meta rejected the credentials: ${detalhe}`)
    }

    this.ready = true

    const number = (body as { display_phone_number?: string })?.display_phone_number ?? null
    this.deps.onEvent({ type: 'paired', phoneNumber: number?.replace(/\D/g, '') ?? null })
    this.deps.onEvent({ type: 'status', status: 'connected' })
  }

  async disconnect(): Promise<void> {
    // There is no connection to close: the link is the token, not a socket.
    this.ready = false
  }

  isReady(): boolean {
    return this.ready
  }

  currentQr(): string | null {
    return null
  }

  async requestPairingCode(): Promise<string> {
    throw badRequest(
      'The official engine does not use pairing. Set phoneNumberId and accessToken in PUT /v1/sessions/:id/credentials.',
    )
  }

  async sendPresence(): Promise<void> {
    // The Cloud API exposes no presence; ignoring beats failing a send.
  }

  async sendText(chatId: string, text: string): Promise<SendResult> {
    if (!this.ready) {
      throw badRequest('The session is not connected. Check the Cloud API credentials.')
    }

    // Meta expects digits only, without the unofficial protocol's JID suffix.
    const destino = chatId.replace(/@.*$/, '').replace(/\D/g, '')

    const { ok, status, body } = await this.request(`${this.baseUrl}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: destino,
        type: 'text',
        text: { preview_url: false, body: text },
      }),
    })

    if (!ok) {
      const error = (body as GraphError)?.error
      /**
       * Code 131047 is the one most worth translating: it means the 24 h window
       * has closed and the message would need an approved template. Without
       * that translation, an integrator sees a generic error and concludes the
       * credential broke.
       */
      if (error?.code === 131047) {
        throw new Error(
          'The 24 h window has closed: outside it the Cloud API only accepts a template approved by Meta.',
        )
      }
      throw new Error(error?.message ?? `Meta rejected the send (HTTP ${status}).`)
    }

    const id = (body as { messages?: Array<{ id?: string }> })?.messages?.[0]?.id
    if (!id) throw new Error('Meta did not return a message id.')

    return { engineMessageId: id, timestamp: new Date() }
  }
}
