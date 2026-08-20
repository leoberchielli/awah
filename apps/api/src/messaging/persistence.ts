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
 * Writes the materialized message, respecting the organization's retention.
 *
 * The upsert on `(org_id, session_id, engine_message_id)` is there because the
 * same event arrives more than once in practice: a reconnect redelivers, and a
 * message we sent also comes back through the number's own `messages.upsert`.
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
 * Advances the ACK trail.
 *
 * Two precautions here, both of them from how the protocol actually behaves:
 * ACKs arrive out of order, so the status only moves forward and never back;
 * and the same ACK arrives twice, so the trail uses `onConflictDoNothing` not
 * to duplicate the row that feeds the per-step latencies.
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

  // ACK for a message we do not know: common right after connecting.
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
 * Erases content that has already expired, keeping the metadata.
 *
 * The row goes on existing — that is what keeps volume, latency and the
 * delivery funnel intact after the message body has been dropped.
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
