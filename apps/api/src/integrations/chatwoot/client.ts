import type { ChatwootConfig } from '../config'

export class ChatwootError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ChatwootError'
  }

  /** Erro de configuração, não de disponibilidade: repetir não conserta. */
  get isPermanente(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429
  }
}

export interface ContatoChatwoot {
  contactId: number
  /**
   * Identificador do contato **dentro da caixa**.
   *
   * O Chatwoot exige este valor para abrir conversa numa caixa do tipo API, e
   * ele não é o id do contato — confundir os dois devolve 404 sem explicar nada.
   */
  sourceId: string
}

interface RespostaContato {
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
 * Cliente do Chatwoot, só com o que o gateway usa.
 *
 * Não é um SDK: são cinco chamadas, e depender de uma biblioteca inteira para
 * elas contrariaria a aposta de leveza do projeto.
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

  private get base(): string {
    return `${this.config.baseUrl}/api/v1/accounts/${this.config.accountId}`
  }

  private async request<T>(caminho: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      const resposta = await this.fetchImpl(`${this.base}${caminho}`, {
        ...init,
        signal: controller.signal,
        headers: {
          api_access_token: this.config.apiAccessToken,
          'content-type': 'application/json',
          ...init?.headers,
        },
      })

      const texto = await resposta.text()
      const corpo = texto ? safeJson(texto) : null

      if (!resposta.ok) {
        const detalhe =
          (corpo as { message?: string; error?: string })?.message ??
          (corpo as { error?: string })?.error ??
          texto.slice(0, 200)
        throw new ChatwootError(
          resposta.status,
          `Chatwoot respondeu ${resposta.status}: ${detalhe}`,
        )
      }

      return corpo as T
    } finally {
      clearTimeout(timer)
    }
  }

  /** Confere credenciais e a caixa antes de gravar qualquer coisa. */
  async verificar(): Promise<{ inboxName: string; channelType: string }> {
    const inbox = await this.request<{ name?: string; channel_type?: string }>(
      `/inboxes/${this.config.inboxId}`,
    )

    return {
      inboxName: inbox?.name ?? '(sem nome)',
      channelType: inbox?.channel_type ?? 'desconhecido',
    }
  }

  /**
   * Encontra ou cria o contato na caixa.
   *
   * O Chatwoot recusa contato duplicado com 422 em vez de devolver o existente,
   * então a busca vem primeiro. `identifier` é o telefone em dígitos: é o único
   * dado estável que o WhatsApp entrega em toda mensagem.
   */
  async garantirContato(input: {
    identifier: string
    phoneNumber: string
    name: string
  }): Promise<ContatoChatwoot> {
    const encontrado = await this.buscarContato(input.identifier)
    if (encontrado) return encontrado

    try {
      const criado = await this.request<RespostaContato>('/contacts', {
        method: 'POST',
        body: JSON.stringify({
          inbox_id: this.config.inboxId,
          name: input.name,
          phone_number: input.phoneNumber,
          identifier: input.identifier,
        }),
      })

      const extraido = this.extrairContato(criado)
      if (extraido) return extraido
    } catch (erro) {
      // 422 aqui é corrida: outro processo criou o contato entre a busca e agora.
      if (!(erro instanceof ChatwootError) || erro.status !== 422) throw erro
    }

    const depois = await this.buscarContato(input.identifier)
    if (!depois) throw new ChatwootError(500, 'contato criado mas não localizado no Chatwoot')
    return depois
  }

  private async buscarContato(identifier: string): Promise<ContatoChatwoot | null> {
    const resultado = await this.request<{ payload?: RespostaContato['payload'][] }>(
      `/contacts/search?q=${encodeURIComponent(identifier)}`,
    )

    for (const candidato of resultado?.payload ?? []) {
      const extraido = this.extrairContato({ payload: candidato })
      if (extraido) return extraido
    }

    return null
  }

  /**
   * O `source_id` da caixa certa, entre todas as caixas do contato.
   *
   * Um contato que já conversou por e-mail e por WhatsApp tem um
   * `contact_inbox` para cada. Pegar o primeiro da lista abriria a conversa na
   * caixa errada.
   */
  private extrairContato(resposta: RespostaContato): ContatoChatwoot | null {
    const contato = resposta.payload?.contact ?? resposta.payload
    const contactId = contato?.id
    if (!contactId) return null

    const daCaixa = contato?.contact_inboxes?.find(
      (ci) => ci.inbox?.id === this.config.inboxId && ci.source_id,
    )
    if (!daCaixa?.source_id) return null

    return { contactId, sourceId: daCaixa.source_id }
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

    if (!conversa?.id) throw new ChatwootError(500, 'Chatwoot não devolveu id da conversa')
    return String(conversa.id)
  }

  /**
   * Registra a mensagem do cliente na conversa.
   *
   * `source_id` recebe o id da mensagem no WhatsApp: é ele que permite ao
   * webhook de volta reconhecer o que veio daqui e não reenviar — o eco que
   * transforma uma conversa em laço infinito.
   */
  async criarMensagemRecebida(input: {
    conversationId: string
    content: string
    sourceId: string
  }): Promise<string> {
    const mensagem = await this.request<{ id?: number }>(
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

    return String(mensagem?.id ?? '')
  }
}

function safeJson(texto: string): unknown {
  try {
    return JSON.parse(texto)
  } catch {
    return null
  }
}
