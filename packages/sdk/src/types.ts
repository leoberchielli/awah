/** Contratos da API. Espelham as respostas do servidor. */

export type Engine = 'baileys' | 'cloud_api' | 'wwebjs' | 'whatsmeow'

export type SessionStatus =
  | 'created'
  | 'pairing'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'logged_out'
  | 'banned'

export interface Session {
  id: string
  name: string
  engine: Engine
  status: SessionStatus
  phoneNumber: string | null
  ownerNodeId: string | null
  pairedAt: string | null
  lastConnectedAt: string | null
  lastDisconnectedAt: string | null
  createdAt: string
  desiredState: 'running' | 'stopped'
  running: boolean
  runningHere: boolean
}

export interface SessionEvent {
  id: string
  type: string
  /** Código bruto do protocolo, quando houver. É o que distingue 428 de 440. */
  rawCode: number | null
  cause: string | null
  nodeId: string | null
  createdAt: string
}

export interface EngineCapabilities {
  qrPairing: boolean
  codePairing: boolean
  groups: boolean
  channels: boolean
  presence: boolean
  reactions: boolean
  editMessage: boolean
  freeformMessaging: boolean
}

export interface EngineInfo {
  engine: Engine
  available: boolean
  capabilities: EngineCapabilities
}

export interface CloudApiCredentials {
  phoneNumberId: string
  accessToken: string
  verifyToken: string
  appSecret: string
  graphVersion?: string
}

export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'dead' | 'held'

export interface EnqueuedMessage {
  id: string
  status: OutboxStatus
  clientMessageId: string
  /**
   * Verdadeiro quando o `clientMessageId` já existia. O envio devolvido é o
   * original — nenhuma segunda mensagem foi criada.
   */
  duplicate: boolean
  scheduledAt?: string | null
}

export interface OutboxMessage {
  id: string
  sessionId: string
  chatId: string
  status: OutboxStatus
  attempts: number
  clientMessageId: string
  engineMessageId: string | null
  lastError: string | null
  scheduledAt: string | null
  createdAt: string
}

export interface WebhookEndpoint {
  id: string
  url: string
  events: string[]
  active: boolean
  createdAt: string
  /** Só aparece na criação. Guardar aqui é a única chance. */
  secret?: string
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
  /** 1 é ritmo normal; abaixo disso, o freio está ativo. */
  throttleFactor: number
}

export interface Serie {
  metric: string
  points: Array<{ bucket: string; value: number }>
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

export interface JanelaKpi {
  /** Horas para trás. Padrão 24, teto 720. */
  hours?: number
  sessionId?: string
}

/** Corpo dos eventos entregues por webhook. */
export interface WebhookEvent<T = Record<string, unknown>> {
  event:
    | 'message.received'
    | 'message.sent'
    | 'message.status'
    | 'message.failed'
    | 'session.status'
  data: T
}
