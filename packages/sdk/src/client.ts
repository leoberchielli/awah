import { type AwahOptions, HttpClient } from './http'
import type {
  CloudApiCredentials,
  Engine,
  EngineInfo,
  EnqueuedMessage,
  KpiBusiness,
  KpiDelivery,
  KpiRisk,
  KpiSessions,
  KpiWindow,
  OutboxMessage,
  OutboxStatus,
  RiskSnapshot,
  Session,
  SessionEvent,
  WebhookEndpoint,
} from './types'

export interface SendText {
  chatId: string
  text: string
  /**
   * Idempotency key. If you leave it out the SDK generates one — and that is
   * what makes the automatic retry safe: repeating the same value returns the
   * original send with `duplicate: true`, never a second message.
   */
  clientMessageId?: string
  /**
   * Bypasses the risk engine. It is still recorded in `risk_events` like any
   * other decision, and the responsibility moves to the caller.
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

  /** Opens the connection. A new session enters pairing — fetch the QR after this. */
  start(id: string): Promise<{ id: string; status: string }> {
    return this.http.request({ method: 'POST', path: `/v1/sessions/${id}/start` })
  }

  /** Disconnects, keeping the credentials. */
  stop(id: string): Promise<{ id: string; status: string }> {
    return this.http.request({ method: 'POST', path: `/v1/sessions/${id}/stop` })
  }

  /** Unlinks the device from the phone and erases the credentials. Pairing starts over. */
  logout(id: string): Promise<{ id: string; status: string }> {
    return this.http.request({ method: 'POST', path: `/v1/sessions/${id}/logout` })
  }

  /**
   * QR for the pairing in progress, as raw text and as a PNG `data:` URI.
   *
   * The code is swapped every few seconds: fetch it **after** `start` and keep
   * refreshing it for as long as the status is `pairing`.
   */
  qr(id: string): Promise<{ qr: string; image: string }> {
    return this.http.request({ method: 'GET', path: `/v1/sessions/${id}/qr` })
  }

  /** Alternative to the QR: an 8-digit code typed into the phone. */
  pairingCode(id: string, phoneNumber: string): Promise<{ code: string }> {
    return this.http.request({
      method: 'POST',
      path: `/v1/sessions/${id}/pairing-code`,
      body: { phoneNumber },
    })
  }

  /** Timeline of connects and drops, with the raw code beside the translated cause. */
  events(id: string, limit = 100): Promise<{ events: SessionEvent[] }> {
    return this.http.request({
      method: 'GET',
      path: `/v1/sessions/${id}/events`,
      query: { limit },
    })
  }

  /** Only for the `cloud_api` engine. Stored encrypted; never returned on a read. */
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
   * Queues a text message.
   *
   * Answers **202**: the message was persisted, not delivered. The real state
   * lives in `outbox.get()` and in the webhooks.
   */
  sendText(sessionId: string, input: SendText): Promise<EnqueuedMessage> {
    const { bypassRisk, clientMessageId, ...resto } = input

    return this.http.request({
      method: 'POST',
      path: `/v1/sessions/${sessionId}/messages`,
      body: { ...resto, clientMessageId: clientMessageId ?? newKey() },
      // Safe to repeat precisely because the body carries an idempotency key.
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

  /** Puts a message that ran out of attempts back on the queue. */
  retry(id: string): Promise<OutboxMessage> {
    return this.http.request({ method: 'POST', path: `/v1/outbox/${id}/retry`, idempotente: true })
  }
}

class WebhooksResource {
  constructor(private readonly http: HttpClient) {}

  /** The `secret` in the response appears **only once**. Store it now. */
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

  /** Score with each factor's contribution, window usage and the limits in force. */
  snapshot(sessionId: string): Promise<RiskSnapshot> {
    return this.http.request({ method: 'GET', path: `/v1/sessions/${sessionId}/risk` })
  }

  /**
   * The limits you configure are the **target**, not today's value: the warm-up
   * curve starts at 5% and reaches 100% in thirty days.
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

  /** Every decision, with the budget as it stood the instant it was taken. */
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

  sessions(windowLabel?: KpiWindow): Promise<KpiSessions> {
    return this.http.request({ method: 'GET', path: '/v1/kpi/sessions', query: { ...windowLabel } })
  }

  delivery(windowLabel?: KpiWindow): Promise<KpiDelivery> {
    return this.http.request({ method: 'GET', path: '/v1/kpi/delivery', query: { ...windowLabel } })
  }

  risk(windowLabel?: KpiWindow): Promise<KpiRisk> {
    return this.http.request({ method: 'GET', path: '/v1/kpi/risk', query: { ...windowLabel } })
  }

  business(windowLabel?: KpiWindow): Promise<KpiBusiness> {
    return this.http.request({ method: 'GET', path: '/v1/kpi/business', query: { ...windowLabel } })
  }
}

/**
 * The AWAH client.
 *
 * ```ts
 * const awah = new Awah({ baseUrl: 'https://awah.example.com', apiKey: process.env.AWAH_KEY! })
 * const { id } = await awah.sessions.create({ name: 'support' })
 * await awah.sessions.start(id)
 * ```
 *
 * The API key is a server credential. It sends messages on behalf of every
 * session in the organization — do not put it in code that runs in a browser.
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

  /** Capability matrix per engine — what you give up by switching from one to another. */
  engines(): Promise<{ engines: EngineInfo[] }> {
    return this.http.request({ method: 'GET', path: '/v1/engines' })
  }

  /** Context of the current credential: organization, role and session scope. */
  me(): Promise<{
    kind: 'user' | 'api_key'
    organizationId: string
    role: string
    sessionScope: string[] | null
  }> {
    return this.http.request({ method: 'GET', path: '/v1/auth/me' })
  }

  /** Takes no valid credential; use it to check reachability and version. */
  health(): Promise<{ status: string; nodeId: string; uptimeSeconds: number }> {
    return this.http.request({ method: 'GET', path: '/health' })
  }
}

function newKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()

  // Old runtime with no WebCrypto: entropy enough for one send key.
  return `awah-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
