import type { MessageStatus, MessageType } from '@awah/db'
import type { proto } from 'baileys'

/**
 * Códigos de `proto.WebMessageInfo.Status`.
 *
 * O protocolo só avança: uma vez `read`, não volta a `delivered`. Quem consome
 * a trilha de status pode confiar nessa monotonicidade.
 */
const STATUS_BY_CODE: Record<number, MessageStatus> = {
  0: 'failed', // ERROR
  1: 'pending', // PENDING
  2: 'sent', // SERVER_ACK
  3: 'delivered', // DELIVERY_ACK
  4: 'read', // READ
  5: 'played', // PLAYED — áudio ouvido
}

export function mapStatus(code: number | null | undefined): MessageStatus | null {
  if (code == null) return null
  return STATUS_BY_CODE[code] ?? null
}

/** Peso de cada estado, para nunca regredir a trilha por ACK fora de ordem. */
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
 * ACKs chegam fora de ordem com frequência — o `delivered` de uma mensagem pode
 * aparecer depois do `read`. Sem esta comparação, o dashboard mostraria uma
 * mensagem "voltando" de lida para entregue.
 */
export function isStatusAdvance(current: MessageStatus, incoming: MessageStatus): boolean {
  return STATUS_RANK[incoming] > STATUS_RANK[current]
}

export interface ExtractedContent {
  type: MessageType
  body: string | null
}

/**
 * Reduz a união de tipos do protocolo ao que o AWAH persiste: uma categoria e um
 * texto. Legenda de mídia entra como corpo, porque é o que uma busca por
 * conteúdo espera encontrar.
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

  // Protocolo, revogação, chamadas: registramos a ocorrência sem conteúdo.
  return { type: 'system', body: null }
}

/**
 * Timestamp do protocolo vem em segundos. Pode chegar como número puro ou como
 * `Long` do protobuf — daí o `unknown`: `Number()` resolve os dois via valueOf,
 * e o guarda de finitude cobre o resto.
 */
export function toDate(timestamp: unknown): Date {
  if (timestamp == null) return new Date()
  const seconds = typeof timestamp === 'number' ? timestamp : Number(timestamp)
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date()
  return new Date(seconds * 1000)
}
