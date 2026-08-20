import type { EngineType, MessageStatus, MessageType, SessionStatus } from '@awah/db'

/**
 * What each engine can do. This is the source of the public capability matrix:
 * before choosing, the user needs to know that the Cloud API has no groups and
 * that Baileys has no 24 h window.
 */
export interface EngineCapabilities {
  qrPairing: boolean
  codePairing: boolean
  groups: boolean
  channels: boolean
  presence: boolean
  reactions: boolean
  editMessage: boolean
  /** Free-form sending, with no approved template and no service window. */
  freeformMessaging: boolean
}

export interface SendResult {
  engineMessageId: string
  timestamp: Date
}

/**
 * Events an engine emits to the session manager. The manager is what turns them
 * into database writes — the adapter never touches Postgres directly, so that
 * swapping engines does not mean rewriting persistence.
 */
export type EngineEvent =
  | { type: 'status'; status: SessionStatus; detail?: Record<string, unknown> }
  /** A new QR to display. It expires in seconds and is replaced until pairing. */
  | { type: 'qr'; qr: string }
  | { type: 'paired'; phoneNumber: string | null }
  /** The credentials changed and need to be persisted. */
  | { type: 'credentials' }
  | {
      type: 'closed'
      rawCode: number | null
      cause: string
      shouldReconnect: boolean
      loggedOut: boolean
    }
  /** A message arrived (or was sent from another device on the same number). */
  | {
      type: 'message.received'
      engineMessageId: string
      chatId: string
      fromJid: string | null
      messageType: MessageType
      body: string | null
      fromMe: boolean
      occurredAt: Date
    }
  /** Protocol ACK: feeds the sent → delivered → read funnel. */
  | {
      type: 'message.status'
      engineMessageId: string
      chatId: string
      status: MessageStatus
      occurredAt: Date
    }

export type EngineEventHandler = (event: EngineEvent) => void

export interface EngineAdapter {
  readonly engine: EngineType
  readonly capabilities: EngineCapabilities

  connect(): Promise<void>

  /**
   * `logout: true` ends the session on the phone and invalidates the
   * credentials; without it, this only drops the connection and the auth state
   * stays reusable.
   */
  disconnect(options?: { logout?: boolean }): Promise<void>

  /** Pairing by 8-digit code, an alternative to the QR. */
  requestPairingCode(phoneNumber: string): Promise<string>

  /** The current QR, if a pairing is in progress. */
  currentQr(): string | null

  /**
   * Whether the engine is actually ready to send.
   *
   * Connected is not the same as ready: a session that is pairing has an open
   * socket and no identity. The scheduler uses this to put the send back on the
   * queue instead of spending an attempt — being unavailable is not a delivery
   * failure, and treating it as one would send good messages to the DLQ while
   * the user is still scanning the QR.
   */
  isReady(): boolean

  /**
   * Send straight through the engine. No route calls this: every send comes in
   * through the outbox, and it is the scheduler that drives the adapter, after
   * the risk engine frees up a slot.
   */
  sendText(chatId: string, text: string): Promise<SendResult>

  /**
   * Presence in the chat. The risk engine uses `composing` before sending, for
   * a time proportional to the text — a long message that appears instantly
   * gives the automation away to anyone with the chat open.
   */
  sendPresence(chatId: string, state: 'composing' | 'paused' | 'available'): Promise<void>
}
