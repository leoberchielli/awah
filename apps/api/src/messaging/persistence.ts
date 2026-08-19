import { and, type Database, eq, type MessageStatus, type MessageType, schema, sql } from '@awah/db'
import { isStatusAdvance } from '../engines/baileys/mapping'
import { applyRetention, type RetentionResolver } from './retention'

export interface RecordMessageInput {
  orgId: string
  sessionId: string
  chatId: string
  engineMessageId: string
  direction: 'inbound' | 'outbound'
  type: MessageType
  body: string | null
  fromJid?: string | null
  toJid?: string | null
  outboxId?: string | null
  status: MessageStatus
  occurredAt: Date
}

/**
 * Grava a mensagem materializada, respeitando a retenção da organização.
 *
 * O upsert em `(org_id, session_id, engine_message_id)` existe porque o mesmo
 * evento chega mais de uma vez na prática: reconexão reentrega, e uma mensagem
 * enviada por nós também volta pelo `messages.upsert` do próprio número.
 */
export async function recordMessage(
  db: Database,
  retention: RetentionResolver,
  input: RecordMessageInput,
): Promise<string | null> {
  const days = await retention.retentionDays(input.orgId)
  const decision = applyRetention(input.body, days, input.occurredAt)

  const [row] = await db
    .insert(schema.messages)
    .values({
      orgId: input.orgId,
      sessionId: input.sessionId,
      chatId: input.chatId,
      engineMessageId: input.engineMessageId,
      direction: input.direction,
      type: input.type,
      status: input.status,
      fromJid: input.fromJid ?? null,
      toJid: input.toJid ?? null,
      body: decision.body,
      contentExpiresAt: decision.contentExpiresAt,
      outboxId: input.outboxId ?? null,
      occurredAt: input.occurredAt,
    })
    .onConflictDoUpdate({
      target: [schema.messages.orgId, schema.messages.sessionId, schema.messages.engineMessageId],
      set: { updatedAt: new Date() },
    })
    .returning({ id: schema.messages.id })

  return row?.id ?? null
}

/**
 * Avança a trilha de ACK.
 *
 * Dois cuidados aqui, os dois vindos de como o protocolo se comporta de fato:
 * ACKs chegam fora de ordem, então o status só avança e nunca regride; e o
 * mesmo ACK chega repetido, então a trilha usa `onConflictDoNothing` para não
 * duplicar a linha que alimenta as latências por etapa.
 */
export async function recordStatus(
  db: Database,
  input: {
    orgId: string
    sessionId: string
    engineMessageId: string
    status: MessageStatus
    occurredAt: Date
  },
): Promise<boolean> {
  const [message] = await db
    .select({ id: schema.messages.id, status: schema.messages.status })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.orgId, input.orgId),
        eq(schema.messages.sessionId, input.sessionId),
        eq(schema.messages.engineMessageId, input.engineMessageId),
      ),
    )
    .limit(1)

  // ACK de mensagem que não conhecemos: comum logo após conectar.
  if (!message) return false
  if (!isStatusAdvance(message.status, input.status)) return false

  await db.transaction(async (tx) => {
    await tx
      .update(schema.messages)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(schema.messages.id, message.id))

    await tx
      .insert(schema.messageStatusEvents)
      .values({
        orgId: input.orgId,
        messageId: message.id,
        status: input.status,
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing({
        target: [schema.messageStatusEvents.messageId, schema.messageStatusEvents.status],
      })
  })

  return true
}

/**
 * Apaga o conteúdo já vencido, preservando os metadados.
 *
 * A linha continua existindo — é isso que mantém volume, latência e funil de
 * entrega intactos depois que o corpo da mensagem foi descartado.
 */
export async function purgeExpiredContent(db: Database, limit = 1000): Promise<number> {
  const result = await db.execute(sql`
    UPDATE messages
    SET body = NULL,
        media_ref = NULL,
        content_expires_at = NULL,
        updated_at = now()
    WHERE id IN (
      SELECT id FROM messages
      WHERE content_expires_at IS NOT NULL
        AND content_expires_at <= now()
      LIMIT ${limit}
    )
    RETURNING id
  `)

  return [...result].length
}
