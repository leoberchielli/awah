/** API contracts. They mirror the server's responses. */

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
  /** Raw protocol code, when there is one. It is what tells 428 from 440. */
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
   * True when the `clientMessageId` already existed. The send returned is the
   * original one — no second message was created.
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
  /** Only shows up on creation. Storing it here is the only chance. */
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
  /** 1 is normal pace; below that, the brake is on. */
  throttleFactor: number
}

export interface Series {
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

export interface KpiWindow {
  /** Hours back. Default 24, ceiling 720. */
  hours?: number
  sessionId?: string
}

/** Body of the events delivered by webhook. */
export interface WebhookEvent<T = Record<string, unknown>> {
  event:
    | 'message.received'
    | 'message.sent'
    | 'message.status'
    | 'message.failed'
    | 'session.status'
  data: T
}
