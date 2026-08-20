import type { ChatwootConfig } from '../config'

export class ChatwootError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ChatwootError'
  }

  /** Configuration error, not availability: retrying does not fix it. */
  get isPermanente(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429
  }
}

export interface ChatwootContact {
  contactId: number
  /**
   * The contact's identifier **inside the inbox**.
   *
   * Chatwoot demands this value to open a conversation in an API-type inbox,
   * and it is not the contact id — confusing the two returns a 404 that
   * explains nothing.
   */
  sourceId: string
}

interface ContactResponse {
  payload?: {
    contact?: {
      id?: number
      contact_inboxes?: Array<{ source_id?: string; inbox?: { id?: number } }>
    }
    id?: number
    contact_inboxes?: Array<{ source_id?: string; inbox?: { id?: number } }>
  }
  id?: number
}

/**
 * Chatwoot client, with only what the gateway uses.
 *
 * It is not an SDK: it is five calls, and depending on a whole library for them
 * would go against the project's bet on staying light.
 */
export class ChatwootClient {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(
    private readonly config: ChatwootConfig,
    options?: { fetch?: typeof fetch; timeoutMs?: number },
  ) {
    this.fetchImpl = options?.fetch ?? fetch
    this.timeoutMs = options?.timeoutMs ?? 15_000
  }

  private request<T>(caminho: string, init?: RequestInit): Promise<T> {
    return this.absoluto<T>(`/api/v1/accounts/${this.config.accountId}${caminho}`, init)
  }

  /** The profile does not live under `/accounts/{id}` — hence the two paths. */
  private async absoluto<T>(caminho: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const resposta = await this.fetchImpl(`${this.config.baseUrl}${caminho}`, {
        ...init,
        signal: controller.signal,
        headers: {
          api_access_token: this.config.apiAccessToken,
          'content-type': 'application/json',
          ...init?.headers,
        },
      })

      const text = await resposta.text()
      const body = text ? safeJson(text) : null

      if (!resposta.ok) {
        const detalhe =
          (body as { message?: string; error?: string })?.message ??
          (body as { error?: string })?.error ??
          text.slice(0, 200)
        throw new ChatwootError(
          resposta.status,
          `Chatwoot responded ${resposta.status}: ${detalhe}`,
        )
      }

      return body as T
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The accounts this token can reach.
   *
   * `accountId` is buried in the Chatwoot URL, and asking the person to copy it
   * out of there is the first thing that stalls adoption. The token already
   * knows the answer — you just have to ask.
   */
  async accounts(): Promise<Array<{ id: number; name: string; role: string }>> {
    const perfil = await this.absoluto<{
      accounts?: Array<{ id?: number; name?: string; role?: string }>
    }>('/api/v1/profile')

    return (perfil?.accounts ?? [])
      .filter((c): c is { id: number; name?: string; role?: string } => typeof c.id === 'number')
      .map((c) => ({ id: c.id, name: c.name ?? `Conta ${c.id}`, role: c.role ?? 'agent' }))
  }

  /** Existing inboxes, so one can be reused instead of creating another. */
  async inboxes(): Promise<Array<{ id: number; name: string; channelType: string }>> {
    const resposta = await this.request<{
      payload?: Array<{ id?: number; name?: string; channel_type?: string }>
    }>('/inboxes')

    return (resposta?.payload ?? [])
      .filter(
        (c): c is { id: number; name?: string; channel_type?: string } => typeof c.id === 'number',
      )
      .map((c) => ({
        id: c.id,
        name: c.name ?? `Caixa ${c.id}`,
        channelType: c.channel_type ?? 'desconhecido',
      }))
  }

  /**
   * Creates the API inbox with the webhook already pointed at the gateway.
   *
   * These are the two most tedious steps of the manual — clicking to create the
   * inbox and then coming back to paste the URL — settled in one call. It needs
   * an admin token; a plain agent gets a 403, and the message says so.
   */
  async createInboxFor(name: string, webhookUrl: string): Promise<{ id: number; name: string }> {
    const inbox = await this.request<{ id?: number; name?: string }>('/inboxes', {
      method: 'POST',
      body: JSON.stringify({
        name: name,
        channel: { type: 'api', webhook_url: webhookUrl },
      }),
    })

    if (!inbox?.id) throw new ChatwootError(500, 'Chatwoot did not return the created inbox id')
    return { id: inbox.id, name: inbox.name ?? name }
  }

  /** Points the webhook of an inbox that already existed. */
  async apontarWebhook(inboxId: number, webhookUrl: string): Promise<void> {
    await this.request(`/inboxes/${inboxId}`, {
      method: 'PATCH',
      body: JSON.stringify({ channel: { webhook_url: webhookUrl } }),
    })
  }

  /** Checks the credentials and the inbox before saving anything. */
  async verify(): Promise<{ inboxName: string; channelType: string }> {
    const inbox = await this.request<{ name?: string; channel_type?: string }>(
      `/inboxes/${this.config.inboxId}`,
    )

    return {
      inboxName: inbox?.name ?? '(sem nome)',
      channelType: inbox?.channel_type ?? 'desconhecido',
    }
  }

  /**
   * Finds or creates the contact in the inbox.
   *
   * Chatwoot refuses a duplicate contact with a 422 instead of returning the
   * existing one, so the search comes first. `identifier` is the phone number
   * in digits: the only stable piece of data WhatsApp hands over on every
   * message.
   */
  async ensureContact(input: {
    identifier: string
    phoneNumber: string
    name: string
  }): Promise<ChatwootContact> {
    const found = await this.findContact(input.identifier)
    if (found) return found

    try {
      const created = await this.request<ContactResponse>('/contacts', {
        method: 'POST',
        body: JSON.stringify({
          inbox_id: this.config.inboxId,
          name: input.name,
          phone_number: input.phoneNumber,
          identifier: input.identifier,
        }),
      })

      const extraido = this.extractContact(created)
      if (extraido) return extraido
    } catch (error) {
      // A 422 here is a race: another process created it since the search.
      if (!(error instanceof ChatwootError) || error.status !== 422) throw error
    }

    const depois = await this.findContact(input.identifier)
    if (!depois) throw new ChatwootError(500, 'contact created but not found in Chatwoot')
    return depois
  }

  private async findContact(identifier: string): Promise<ChatwootContact | null> {
    const result = await this.request<{ payload?: ContactResponse['payload'][] }>(
      `/contacts/search?q=${encodeURIComponent(identifier)}`,
    )

    for (const candidato of result?.payload ?? []) {
      const extraido = this.extractContact({ payload: candidato })
      if (extraido) return extraido
    }

    return null
  }

  /**
   * The `source_id` of the right inbox, among all of the contact's inboxes.
   *
   * A contact who has already talked over e-mail and over WhatsApp has one
   * `contact_inbox` for each. Taking the first from the list would open the
   * conversation in the wrong inbox.
   */
  private extractContact(resposta: ContactResponse): ChatwootContact | null {
    const contact = resposta.payload?.contact ?? resposta.payload
    const contactId = contact?.id
    if (!contactId) return null

    const fromInbox = contact?.contact_inboxes?.find(
      (ci) => ci.inbox?.id === this.config.inboxId && ci.source_id,
    )
    if (!fromInbox?.source_id) return null

    return { contactId, sourceId: fromInbox.source_id }
  }

  async criarConversa(input: { sourceId: string; contactId: number }): Promise<string> {
    const conversa = await this.request<{ id?: number }>('/conversations', {
      method: 'POST',
      body: JSON.stringify({
        source_id: input.sourceId,
        inbox_id: this.config.inboxId,
        contact_id: input.contactId,
      }),
    })

    if (!conversa?.id) throw new ChatwootError(500, 'Chatwoot did not return a conversation id')
    return String(conversa.id)
  }

  /**
   * Records the customer's message on the conversation.
   *
   * `source_id` gets the WhatsApp message id: it is what lets the webhook
   * coming back recognise what came from here and not resend it — the echo that
   * turns a conversation into an infinite loop.
   */
  async buildIncomingMessage(input: {
    conversationId: string
    content: string
    sourceId: string
  }): Promise<string> {
    const message = await this.request<{ id?: number }>(
      `/conversations/${input.conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          content: input.content,
          message_type: 'incoming',
          source_id: input.sourceId,
        }),
      },
    )

    return String(message?.id ?? '')
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
