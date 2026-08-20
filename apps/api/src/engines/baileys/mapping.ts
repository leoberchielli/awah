import type { MessageStatus, MessageType } from '@awah/db'
import type { proto } from 'baileys'

/**
 * Codes from `proto.WebMessageInfo.Status`.
 *
 * The protocol only moves forward: once `read`, it never goes back to
 * `delivered`. Anything consuming the status trail can rely on that
 * monotonicity.
 */
const STATUS_BY_CODE: Record<number, MessageStatus> = {
  0: 'failed', // ERROR
  1: 'pending', // PENDING
  2: 'sent', // SERVER_ACK
  3: 'delivered', // DELIVERY_ACK
  4: 'read', // READ
  5: 'played', // PLAYED — audio listened to
}

export function mapStatus(code: number | null | undefined): MessageStatus | null {
  if (code == null) return null
  return STATUS_BY_CODE[code] ?? null
}

/** Weight of each state, so an out-of-order ACK never rolls the trail back. */
const STATUS_RANK: Record<MessageStatus, number> = {
  pending: 0,
  failed: 0,
  stale: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  played: 4,
}

/**
 * ACKs often arrive out of order — a message's `delivered` can show up after
 * its `read`. Without this comparison, the dashboard would show a message
 * "going back" from read to delivered.
 */
export function isStatusAdvance(current: MessageStatus, incoming: MessageStatus): boolean {
  return STATUS_RANK[incoming] > STATUS_RANK[current]
}

export interface ExtractedContent {
  type: MessageType
  body: string | null
}

/**
 * Narrows the protocol's type union down to what AWAH persists: a category and
 * some text. A media caption goes in as the body, because that is what a search
 * over content expects to find.
 */
export function extractContent(message: proto.IMessage | null | undefined): ExtractedContent {
  if (!message) return { type: 'system', body: null }

  if (message.conversation) {
    return { type: 'text', body: message.conversation }
  }

  if (message.extendedTextMessage?.text) {
    return { type: 'text', body: message.extendedTextMessage.text }
  }

  if (message.imageMessage) {
    return { type: 'image', body: message.imageMessage.caption ?? null }
  }

  if (message.videoMessage) {
    return { type: 'video', body: message.videoMessage.caption ?? null }
  }

  if (message.audioMessage) {
    return { type: 'audio', body: null }
  }

  if (message.documentMessage) {
    return {
      type: 'document',
      body: message.documentMessage.caption ?? message.documentMessage.fileName ?? null,
    }
  }

  if (message.stickerMessage) {
    return { type: 'sticker', body: null }
  }

  if (message.locationMessage) {
    return { type: 'location', body: message.locationMessage.name ?? null }
  }

  if (message.contactMessage || message.contactsArrayMessage) {
    return { type: 'contact', body: message.contactMessage?.displayName ?? null }
  }

  if (message.reactionMessage) {
    return { type: 'reaction', body: message.reactionMessage.text ?? null }
  }

  if (message.pollCreationMessage) {
    return { type: 'poll', body: message.pollCreationMessage.name ?? null }
  }

  // Protocol, revocation, calls: we record that it happened, with no content.
  return { type: 'system', body: null }
}

/**
 * The protocol timestamp comes in seconds. It can arrive as a plain number or
 * as a protobuf `Long` — hence the `unknown`: `Number()` handles both via
 * valueOf, and the finiteness guard covers the rest.
 */
export function toDate(timestamp: unknown): Date {
  if (timestamp == null) return new Date()
  const seconds = typeof timestamp === 'number' ? timestamp : Number(timestamp)
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date()
  return new Date(seconds * 1000)
}
