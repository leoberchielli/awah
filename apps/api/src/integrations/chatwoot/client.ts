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

  private request<T>(caminho: string, init?: RequestInit): Promise<T> {
    return this.absoluto<T>(`/api/v1/accounts/${this.config.accountId}${caminho}`, init)
  }

  /** O perfil não vive sob `/accounts/{id}` — daí os dois caminhos. */
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

      const texto = await resposta.text()
      const corpo = texto ? safeJson(texto) : null

      if (!resposta.ok) {
        const detalhe =
          (corpo as { message?: string; error?: string })?.message ??
          (corpo as { error?: string })?.error ??
          texto.slice(0, 200)
        throw new ChatwootError(
          resposta.status,
          `Chatwoot responded ${resposta.status}: ${detalhe}`,
        )
      }

      return corpo as T
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Contas que este token alcança.
   *
   * O `accountId` fica escondido na URL do Chatwoot, e pedir que a pessoa o
   * copie de lá é a primeira coisa que trava a adoção. O token já sabe a
   * resposta — basta perguntar.
   */
  async contas(): Promise<Array<{ id: number; name: string; role: string }>> {
    const perfil = await this.absoluto<{
      accounts?: Array<{ id?: number; name?: string; role?: string }>
    }>('/api/v1/profile')

    return (perfil?.accounts ?? [])
      .filter((c): c is { id: number; name?: string; role?: string } => typeof c.id === 'number')
      .map((c) => ({ id: c.id, name: c.name ?? `Conta ${c.id}`, role: c.role ?? 'agent' }))
  }

  /** Caixas existentes, para reaproveitar uma em vez de criar outra. */
  async caixas(): Promise<Array<{ id: number; name: string; channelType: string }>> {
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
   * Cria a caixa API já com o webhook apontado para o gateway.
   *
   * São os dois passos mais chatos do manual — criar a caixa clicando e depois
   * voltar para colar a URL — resolvidos numa chamada. Exige token de
   * administrador; agente comum recebe 403, e a mensagem diz isso.
   */
  async criarCaixa(nome: string, webhookUrl: string): Promise<{ id: number; name: string }> {
    const caixa = await this.request<{ id?: number; name?: string }>('/inboxes', {
      method: 'POST',
      body: JSON.stringify({
        name: nome,
        channel: { type: 'api', webhook_url: webhookUrl },
      }),
    })

    if (!caixa?.id) throw new ChatwootError(500, 'Chatwoot did not return the created inbox id')
    return { id: caixa.id, name: caixa.name ?? nome }
  }

  /** Aponta o webhook de uma caixa que já existia. */
  async apontarWebhook(inboxId: number, webhookUrl: string): Promise<void> {
    await this.request(`/inboxes/${inboxId}`, {
      method: 'PATCH',
      body: JSON.stringify({ channel: { webhook_url: webhookUrl } }),
    })
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
    if (!depois) throw new ChatwootError(500, 'contact created but not found in Chatwoot')
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

    if (!conversa?.id) throw new ChatwootError(500, 'Chatwoot did not return a conversation id')
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
