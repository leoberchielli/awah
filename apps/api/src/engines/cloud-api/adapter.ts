import { badRequest } from '../../lib/errors'
import type { EngineAdapter, EngineCapabilities, EngineEventHandler, SendResult } from '../types'
import type { CloudApiCredentials } from './credentials'

/**
 * O que a engine oficial faz e o que ela não faz.
 *
 * A matriz não é detalhe de documentação: é o contrato que permite a alguém
 * escolher entre as engines sabendo o que perde. A Cloud API não tem grupos nem
 * presença, e só conversa livremente dentro da janela de 24 h depois que o
 * cliente escreve — fora dela, exige template aprovado pela Meta.
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
  /** Injetável para teste; por padrão o fetch global. */
  fetchImpl?: typeof fetch
  requestTimeoutMs?: number
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string }
}

/**
 * Engine oficial da Meta.
 *
 * O ponto desta implementação não é a Cloud API em si — é ela caber no mesmo
 * `EngineAdapter` do Baileys. Com as duas atrás do mesmo contrato, quem integra
 * escreve o código uma vez e migra do não-oficial para o oficial trocando uma
 * linha de configuração: começa barato e sujeito a bloqueio, termina caro e
 * blindado, sem reescrever nada.
 *
 * Não há socket, sessão nem pareamento aqui. "Conectar" é verificar que o
 * número existe e que o token responde; mensagens chegam por webhook, não por
 * stream.
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
   * "Conectar" aqui é confirmar que o token alcança o número.
   *
   * Falhar cedo importa: sem esta verificação, uma credencial errada só
   * apareceria na primeira mensagem que o cliente tentasse enviar, já dentro da
   * fila e contando como falha de entrega.
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
        // Token inválido exige reconfiguração, como um logout exigiria pareamento.
        loggedOut: status === 401 || status === 403,
      })
      throw badRequest(`Meta rejected the credentials: ${detalhe}`)
    }

    this.ready = true

    const numero = (body as { display_phone_number?: string })?.display_phone_number ?? null
    this.deps.onEvent({ type: 'paired', phoneNumber: numero?.replace(/\D/g, '') ?? null })
    this.deps.onEvent({ type: 'status', status: 'connected' })
  }

  async disconnect(): Promise<void> {
    // Não há conexão a fechar: o vínculo é o token, não um socket.
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
    // A Cloud API não expõe presença; ignorar é melhor que falhar um envio.
  }

  async sendText(chatId: string, text: string): Promise<SendResult> {
    if (!this.ready) {
      throw badRequest('The session is not connected. Check the Cloud API credentials.')
    }

    // A Meta espera só dígitos, sem o sufixo de JID do protocolo não-oficial.
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
      const erro = (body as GraphError)?.error
      /**
       * O código 131047 é o mais importante de traduzir: significa que a janela
       * de 24 h fechou e a mensagem exigiria um template aprovado. Sem essa
       * tradução, quem integra vê um erro genérico e conclui que a credencial
       * quebrou.
       */
      if (erro?.code === 131047) {
        throw new Error(
          'The 24 h window has closed: outside it the Cloud API only accepts a template approved by Meta.',
        )
      }
      throw new Error(erro?.message ?? `Meta rejected the send (HTTP ${status}).`)
    }

    const id = (body as { messages?: Array<{ id?: string }> })?.messages?.[0]?.id
    if (!id) throw new Error('Meta did not return a message id.')

    return { engineMessageId: id, timestamp: new Date() }
  }
}
