/**
 * Cliente da API.
 *
 * O dashboard é servido pela própria API, então tudo é mesma origem e a
 * credencial é o cookie de sessão — nunca uma chave de API. Chave de API vive em
 * servidor de cliente; colocá-la no navegador entregaria a conta inteira a
 * qualquer extensão instalada.
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
    const erro = (body as ErrorBody)?.error
    throw new ApiError(
      response.status,
      erro?.code ?? 'unknown',
      erro?.message ?? `Falha na requisição (HTTP ${response.status}).`,
    )
  }

  return body as T
}

export const get = <T>(path: string) => api<T>(path)
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
export const put = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) })
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' })

// ---------------------------------------------------------------------------
// Contratos. Espelham as respostas do servidor; o que não é usado fica de fora.
// ---------------------------------------------------------------------------

export interface Me {
  kind: 'user' | 'api_key'
  organizationId: string
  role: string
  userId: string | null
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

export interface Ponto {
  bucket: string
  value: number
}

export interface Serie {
  metric: string
  points: Ponto[]
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
  throughput: Serie[]
}

export interface KpiRisk {
  decisions: { allowed: number; delayed: number; throttled: number; held: number }
  newContacts: number
  scoreSeries: Serie[]
  holdSeries: Serie[]
}

export interface KpiBusiness {
  volume: Serie[]
  activeChats: number
  responseRate: number
  firstResponseSeconds: { p50: number | null; p95: number | null }
  topChats: Array<{ chatId: string; messages: number; lastAt: string }>
  byType: Array<{ type: string; count: number }>
}

export interface RiskSnapshot {
  score: {
    value: number
    factors: Array<{ name: string; points: number; max: number; detail: string }>
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
  kind: 'chatwoot' | 'typebot'
  active: boolean
  /** Última falha ao falar com a ferramenta. Nulo quando está tudo bem. */
  lastError: string | null
  lastErrorAt: string | null
  createdAt: string
}

export interface IntegrationSaved {
  integration: Integration
  detail: string
  /** Só o Chatwoot devolve — é a URL que precisa ser cadastrada lá. */
  webhookUrl: string | null
}

export interface Bootstrap {
  /** true enquanto não existir nenhuma organização nesta instância. */
  needsSetup: boolean
  openRegistration: boolean
}

export interface ContaChatwoot {
  id: number
  name: string
  role: string
}

export interface CaixaChatwoot {
  id: number
  name: string
  channelType: string
  /** Só caixa do tipo API serve; as outras têm transporte próprio. */
  usable: boolean
}

export interface DescobertaChatwoot {
  accounts: ContaChatwoot[]
  inboxes: CaixaChatwoot[] | null
}
