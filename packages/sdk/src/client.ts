import { type AwahOptions, HttpClient } from './http'
import type {
  CloudApiCredentials,
  Engine,
  EngineInfo,
  EnqueuedMessage,
  JanelaKpi,
  KpiBusiness,
  KpiDelivery,
  KpiRisk,
  KpiSessions,
  OutboxMessage,
  OutboxStatus,
  RiskSnapshot,
  Session,
  SessionEvent,
  WebhookEndpoint,
} from './types'

export interface EnviarTexto {
  chatId: string
  text: string
  /**
   * Chave de idempotência. Se omitida, o SDK gera uma — e é isso que torna o
   * retry automático seguro: repetir o mesmo valor devolve o envio original com
   * `duplicate: true`, nunca uma segunda mensagem.
   */
  clientMessageId?: string
  /**
   * Fura o motor de risco. Fica registrado em `risk_events` como qualquer outra
   * decisão, e a responsabilidade passa a ser de quem chamou.
   */
  bypassRisk?: boolean
}

class SessionsResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<{ sessions: Session[] }> {
    return this.http.request({ method: 'GET', path: '/v1/sessions' })
  }

  get(id: string): Promise<Session> {
    return this.http.request({ method: 'GET', path: `/v1/sessions/${id}` })
  }

  create(input: { name: string; engine?: Engine }): Promise<Session> {
    return this.http.request({ method: 'POST', path: '/v1/sessions', body: input })
  }

  delete(id: string): Promise<void> {
    return this.http.request({ method: 'DELETE', path: `/v1/sessions/${id}` })
  }

  /** Abre a conexão. Sessão nova entra em pareamento — busque o QR depois disto. */
  start(id: string): Promise<{ id: string; status: string }> {
    return this.http.request({ method: 'POST', path: `/v1/sessions/${id}/start` })
  }

  /** Desconecta preservando as credenciais. */
  stop(id: string): Promise<{ id: string; status: string }> {
    return this.http.request({ method: 'POST', path: `/v1/sessions/${id}/stop` })
  }

  /** Remove o dispositivo do aparelho e apaga as credenciais. Exige novo pareamento. */
  logout(id: string): Promise<{ id: string; status: string }> {
    return this.http.request({ method: 'POST', path: `/v1/sessions/${id}/logout` })
  }

  /**
   * QR do pareamento em curso, em texto cru e como PNG em `data:` URI.
   *
   * O código é trocado a cada poucos segundos: busque **depois** do `start` e
   * renove enquanto o estado for `pairing`.
   */
  qr(id: string): Promise<{ qr: string; image: string }> {
    return this.http.request({ method: 'GET', path: `/v1/sessions/${id}/qr` })
  }

  /** Alternativa ao QR: código de 8 dígitos digitado no aparelho. */
  pairingCode(id: string, phoneNumber: string): Promise<{ code: string }> {
    return this.http.request({
      method: 'POST',
      path: `/v1/sessions/${id}/pairing-code`,
      body: { phoneNumber },
    })
  }

  /** Timeline de conexão e queda, com o código bruto ao lado da causa traduzida. */
  events(id: string, limit = 100): Promise<{ events: SessionEvent[] }> {
    return this.http.request({
      method: 'GET',
      path: `/v1/sessions/${id}/events`,
      query: { limit },
    })
  }

  /** Exclusivo da engine `cloud_api`. Guardado cifrado; nunca devolvido em leitura. */
  setCredentials(
    id: string,
    credentials: CloudApiCredentials,
  ): Promise<{ sessionId: string; webhookUrl: string }> {
    return this.http.request({
      method: 'PUT',
      path: `/v1/sessions/${id}/credentials`,
      body: credentials,
      idempotente: true,
    })
  }
}

class MessagesResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Enfileira um texto.
   *
   * Responde **202**: a mensagem foi persistida, não entregue. O estado real
   * vive em `outbox.get()` e nos webhooks.
   */
  sendText(sessionId: string, input: EnviarTexto): Promise<EnqueuedMessage> {
    const { bypassRisk, clientMessageId, ...resto } = input

    return this.http.request({
      method: 'POST',
      path: `/v1/sessions/${sessionId}/messages`,
      body: { ...resto, clientMessageId: clientMessageId ?? novaChave() },
      // Seguro repetir justamente porque há chave de idempotência no corpo.
      idempotente: true,
      headers: bypassRisk ? { 'x-awah-bypass-risk': 'true' } : undefined,
    })
  }

  list(sessionId: string, options?: { limit?: number; chatId?: string }): Promise<unknown> {
    return this.http.request({
      method: 'GET',
      path: `/v1/sessions/${sessionId}/messages`,
      query: { limit: options?.limit, chatId: options?.chatId },
    })
  }
}

class OutboxResource {
  constructor(private readonly http: HttpClient) {}

  get(id: string): Promise<OutboxMessage> {
    return this.http.request({ method: 'GET', path: `/v1/outbox/${id}` })
  }

  list(options?: {
    status?: OutboxStatus
    sessionId?: string
    limit?: number
  }): Promise<{ messages: OutboxMessage[] }> {
    return this.http.request({
      method: 'GET',
      path: '/v1/outbox',
      query: { status: options?.status, sessionId: options?.sessionId, limit: options?.limit },
    })
  }

  /** Devolve à fila uma mensagem que esgotou as tentativas. */
  retry(id: string): Promise<OutboxMessage> {
    return this.http.request({ method: 'POST', path: `/v1/outbox/${id}/retry`, idempotente: true })
  }
}

class WebhooksResource {
  constructor(private readonly http: HttpClient) {}

  /** O `secret` da resposta aparece **uma única vez**. Guarde-o agora. */
  create(input: { url: string; events: string[]; sessionId?: string }): Promise<WebhookEndpoint> {
    return this.http.request({ method: 'POST', path: '/v1/webhooks', body: input })
  }

  list(): Promise<{ webhooks: WebhookEndpoint[] }> {
    return this.http.request({ method: 'GET', path: '/v1/webhooks' })
  }

  delete(id: string): Promise<void> {
    return this.http.request({ method: 'DELETE', path: `/v1/webhooks/${id}` })
  }

  deliveries(options?: { status?: string; limit?: number }): Promise<unknown> {
    return this.http.request({
      method: 'GET',
      path: '/v1/webhooks/deliveries',
      query: { status: options?.status, limit: options?.limit },
    })
  }

  replay(ids?: string[]): Promise<unknown> {
    return this.http.request({
      method: 'POST',
      path: '/v1/webhooks/deliveries/replay',
      body: ids ? { ids } : undefined,
      idempotente: true,
    })
  }
}

class RiskResource {
  constructor(private readonly http: HttpClient) {}

  /** Score com a contribuição de cada fator, consumo das janelas e limites vigentes. */
  snapshot(sessionId: string): Promise<RiskSnapshot> {
    return this.http.request({ method: 'GET', path: `/v1/sessions/${sessionId}/risk` })
  }

  /**
   * Os limites configurados são o **alvo**, não o valor de hoje: a curva de
   * warmup começa em 5% e chega a 100% em trinta dias.
   */
  setLimits(
    sessionId: string,
    limits: Partial<{
      perMinute: number
      perHour: number
      perDay: number
      newContactsPerDay: number
    }>,
  ): Promise<unknown> {
    return this.http.request({
      method: 'PUT',
      path: `/v1/sessions/${sessionId}/risk/limits`,
      body: limits,
      idempotente: true,
    })
  }

  /** Cada decisão com o retrato do orçamento no instante em que foi tomada. */
  events(options?: { sessionId?: string; limit?: number }): Promise<unknown> {
    return this.http.request({
      method: 'GET',
      path: '/v1/risk/events',
      query: { sessionId: options?.sessionId, limit: options?.limit },
    })
  }
}

class KpiResource {
  constructor(private readonly http: HttpClient) {}

  sessions(janela?: JanelaKpi): Promise<KpiSessions> {
    return this.http.request({ method: 'GET', path: '/v1/kpi/sessions', query: { ...janela } })
  }

  delivery(janela?: JanelaKpi): Promise<KpiDelivery> {
    return this.http.request({ method: 'GET', path: '/v1/kpi/delivery', query: { ...janela } })
  }

  risk(janela?: JanelaKpi): Promise<KpiRisk> {
    return this.http.request({ method: 'GET', path: '/v1/kpi/risk', query: { ...janela } })
  }

  business(janela?: JanelaKpi): Promise<KpiBusiness> {
    return this.http.request({ method: 'GET', path: '/v1/kpi/business', query: { ...janela } })
  }
}

/**
 * Cliente do AWAH.
 *
 * ```ts
 * const awah = new Awah({ baseUrl: 'https://awah.exemplo.com', apiKey: process.env.AWAH_KEY! })
 * const { id } = await awah.sessions.create({ name: 'atendimento' })
 * await awah.sessions.start(id)
 * ```
 *
 * A chave de API é credencial de servidor. Ela envia mensagem em nome de todas
 * as sessões da organização — não a coloque em código que roda no navegador.
 */
export class Awah {
  readonly sessions: SessionsResource
  readonly messages: MessagesResource
  readonly outbox: OutboxResource
  readonly webhooks: WebhooksResource
  readonly risk: RiskResource
  readonly kpi: KpiResource

  private readonly http: HttpClient

  constructor(options: AwahOptions) {
    this.http = new HttpClient(options)

    this.sessions = new SessionsResource(this.http)
    this.messages = new MessagesResource(this.http)
    this.outbox = new OutboxResource(this.http)
    this.webhooks = new WebhooksResource(this.http)
    this.risk = new RiskResource(this.http)
    this.kpi = new KpiResource(this.http)
  }

  /** Matriz de capacidades por engine — o que se perde ao trocar de uma para outra. */
  engines(): Promise<{ engines: EngineInfo[] }> {
    return this.http.request({ method: 'GET', path: '/v1/engines' })
  }

  /** Contexto da credencial atual: organização, papel e escopo de sessão. */
  me(): Promise<{
    kind: 'user' | 'api_key'
    organizationId: string
    role: string
    sessionScope: string[] | null
  }> {
    return this.http.request({ method: 'GET', path: '/v1/auth/me' })
  }

  /** Não exige credencial válida; serve para checar alcance e versão. */
  health(): Promise<{ status: string; nodeId: string; uptimeSeconds: number }> {
    return this.http.request({ method: 'GET', path: '/health' })
  }
}

function novaChave(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()

  // Runtime antigo sem WebCrypto: entropia suficiente para uma chave de envio.
  return `awah-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
