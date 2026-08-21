/**
 * API client.
 *
 * The dashboard is served by the API itself, so everything is same-origin and
 * the credential is the session cookie — never an API key. An API key lives on
 * a customer's server; putting one in the browser would hand the whole account
 * to any installed extension.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  if (response.status === 204) return undefined as T

  const body = await response.json().catch(() => null)

  if (!response.ok) {
    const error = (body as ErrorBody)?.error
    throw new ApiError(
      response.status,
      error?.code ?? 'unknown',
      error?.message ?? `Falha na requisição (HTTP ${response.status}).`,
    )
  }

  return body as T
}

export const get = <T>(path: string) => api<T>(path)
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
export const patch = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) })
export const put = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) })
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Contracts. They mirror the server's responses; what is unused stays out.
// ---------------------------------------------------------------------------

export type Role = 'viewer' | 'operator' | 'admin' | 'owner'

export interface Me {
  kind: 'user' | 'api_key'
  organizationId: string
  role: Role
  userId: string | null
}

export interface Member {
  userId: string
  email: string
  name: string
  role: Role
  joinedAt: string
}

export interface ApiKeyRow {
  id: string
  name: string
  /** The token's public part. It is how you identify the key in a log. */
  prefix: string
  role: Role
  /** Null when the key reaches the whole organization. */
  sessionScope: string[] | null
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

export interface ApiKeyCreated {
  key: ApiKeyRow
  /** Shows up in this response only — the server keeps just the hash. */
  token: string
}

export interface SessionRow {
  id: string
  name: string
  engine: string
  status:
    | 'created'
    | 'pairing'
    | 'connecting'
    | 'connected'
    | 'disconnected'
    | 'logged_out'
    | 'banned'
  phoneNumber: string | null
  ownerNodeId: string | null
  lastConnectedAt: string | null
  lastDisconnectedAt: string | null
  createdAt: string
  desiredState: 'running' | 'stopped'
  running: boolean
  runningHere: boolean
}

export interface Point {
  bucket: string
  value: number
}

export interface Series {
  metric: string
  points: Point[]
}

export interface KpiSessions {
  sessions: Array<{
    sessionId: string
    name: string
    status: string
    disconnects: number
    reconnects: number
    lastCause: string | null
    lastDisconnectAt: string | null
    mtbfMinutes: number | null
  }>
}

export interface KpiDelivery {
  funnel: {
    sent: number
    delivered: number
    read: number
    failed: number
    deliveryRate: number
    readRate: number
  }
  latencyMs: { p50: number | null; p95: number | null; p99: number | null }
  queue: { queued: number; sending: number; dead: number }
  webhooks: { delivered: number; dead: number }
  throughput: Series[]
}

export interface KpiRisk {
  decisions: { allowed: number; delayed: number; throttled: number; held: number }
  newContacts: number
  scoreSeries: Series[]
  holdSeries: Series[]
}

export interface KpiBusiness {
  volume: Series[]
  activeChats: number
  responseRate: number
  firstResponseSeconds: { p50: number | null; p95: number | null }
  topChats: Array<{ chatId: string; messages: number; lastAt: string }>
  byType: Array<{ type: string; count: number }>
}

export interface RiskSnapshot {
  score: {
    value: number
    factors: Array<{
      name: string
      points: number
      max: number
      /** English prose from the API. Only used when no translation exists. */
      detail: string
      /** The numbers behind `detail`, so the panel can word it in the user's language. */
      values: Record<string, number>
    }>
  }
  usage: { minute: number; hour: number; day: number; newContactsToday: number }
  limits: { perMinute: number; perHour: number; perDay: number; newContactsPerDay: number }
  baseLimits: { perMinute: number; perHour: number; perDay: number; newContactsPerDay: number }
  warmup: { ageInDays: number; factor: number }
  throttleFactor: number
}

export interface SessionEvent {
  id: string
  type: string
  rawCode: number | null
  cause: string | null
  /** Stable slug for `cause`, when the server had one. */
  causeCode: string | null
  /** The values behind `cause`, so the panel can word it in the user's language. */
  detail: Record<string, string | number> | null
  nodeId: string | null
  createdAt: string
}

export interface QrResponse {
  qr: string
  image: string
}

export interface Integration {
  id: string
  sessionId: string
  kind: 'chatwoot' | 'typebot' | 'http'
  active: boolean
  /** Last failure talking to the tool. Null when everything is fine. */
  lastError: string | null
  lastErrorAt: string | null
  createdAt: string
}

export interface IntegrationSaved {
  integration: Integration
  detail: string
  /** Only Chatwoot returns one — it is the URL that has to be registered there. */
  webhookUrl: string | null
}

export interface Bootstrap {
  /** true for as long as no organization exists on this instance. */
  needsSetup: boolean
  openRegistration: boolean
}

export interface ChatwootAccount {
  id: number
  name: string
  role: string
}

export interface ChatwootInbox {
  id: number
  name: string
  channelType: string
  /** Only an API-type inbox will do; the others have their own transport. */
  usable: boolean
}

export interface ChatwootDiscovery {
  accounts: ChatwootAccount[]
  inboxes: ChatwootInbox[] | null
}

export interface ConnectorTest {
  /** False when the response did not become a message — the diagnosis says why. */
  ok: boolean
  status: number
  durationMs: number
  replies: string[]
  raw: string
  diagnosis: string | null
  /** What was posted, so the flow on the other side can be built on the sample. */
  sentPayload: Record<string, unknown>
}
