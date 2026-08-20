import { and, desc, eq, type MessageType, type OutboxStatus, schema } from '@awah/db'
import { TenantRepository } from './base'

export interface OutboxRow {
  id: string
  sessionId: string
  chatId: string
  clientMessageId: string
  type: MessageType
  status: OutboxStatus
  attempts: number
  maxAttempts: number
  availableAt: Date
  heldReason: string | null
  lastError: string | null
  engineMessageId: string | null
  createdAt: Date
  sentAt: Date | null
}

const COLUMNS = {
  id: schema.outboxMessages.id,
  sessionId: schema.outboxMessages.sessionId,
  chatId: schema.outboxMessages.chatId,
  clientMessageId: schema.outboxMessages.clientMessageId,
  type: schema.outboxMessages.type,
  status: schema.outboxMessages.status,
  attempts: schema.outboxMessages.attempts,
  maxAttempts: schema.outboxMessages.maxAttempts,
  availableAt: schema.outboxMessages.availableAt,
  heldReason: schema.outboxMessages.heldReason,
  lastError: schema.outboxMessages.lastError,
  engineMessageId: schema.outboxMessages.engineMessageId,
  createdAt: schema.outboxMessages.createdAt,
  sentAt: schema.outboxMessages.sentAt,
}

export class OutboxRepository extends TenantRepository {
  /**
   * Queues a send.
   *
   * The `onConflictDoNothing` on `(org_id, client_message_id)` is the
   * idempotency of §4.2: a client that resends after a network timeout does not
   * produce two sends. When nothing is inserted we return the existing row —
   * the response is the same both times, which is the behavior that makes the
   * retry safe.
   */
  async enqueue(input: {
    sessionId: string
    chatId: string
    clientMessageId: string
    type: MessageType
    payload: Record<string, unknown>
    maxAttempts?: number
  }): Promise<{ row: OutboxRow; created: boolean }> {
    const [inserted] = await this.db
      .insert(schema.outboxMessages)
      .values({
        orgId: this.orgId,
        sessionId: input.sessionId,
        chatId: input.chatId,
        clientMessageId: input.clientMessageId,
        type: input.type,
        payload: input.payload,
        ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
      })
      .onConflictDoNothing({
        target: [schema.outboxMessages.orgId, schema.outboxMessages.clientMessageId],
      })
      .returning(COLUMNS)

    if (inserted) return { row: inserted, created: true }

    const existing = await this.findByClientId(input.clientMessageId)
    if (!existing) throw new Error('idempotency conflict with no matching row')
    return { row: existing, created: false }
  }

  async findByClientId(clientMessageId: string): Promise<OutboxRow | null> {
    const [row] = await this.db
      .select(COLUMNS)
      .from(schema.outboxMessages)
      .where(
        and(
          eq(schema.outboxMessages.orgId, this.orgId),
          eq(schema.outboxMessages.clientMessageId, clientMessageId),
        ),
      )
      .limit(1)

    return row ?? null
  }

  async findById(id: string): Promise<OutboxRow | null> {
    const [row] = await this.db
      .select(COLUMNS)
      .from(schema.outboxMessages)
      .where(and(eq(schema.outboxMessages.orgId, this.orgId), eq(schema.outboxMessages.id, id)))
      .limit(1)

    return row ?? null
  }

  async list(filter?: {
    sessionId?: string
    status?: OutboxStatus
    limit?: number
  }): Promise<OutboxRow[]> {
    const conditions = [eq(schema.outboxMessages.orgId, this.orgId)]
    if (filter?.sessionId) {
      conditions.push(eq(schema.outboxMessages.sessionId, filter.sessionId))
    }
    if (filter?.status) {
      conditions.push(eq(schema.outboxMessages.status, filter.status))
    }

    return this.db
      .select(COLUMNS)
      .from(schema.outboxMessages)
      .where(and(...conditions))
      .orderBy(desc(schema.outboxMessages.seq))
      .limit(filter?.limit ?? 100)
  }

  /** Puts a dead send back on the queue, resetting the attempts. */
  async retry(id: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.outboxMessages)
      .set({
        status: 'queued',
        attempts: 0,
        availableAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.outboxMessages.orgId, this.orgId),
          eq(schema.outboxMessages.id, id),
          eq(schema.outboxMessages.status, 'dead'),
        ),
      )
      .returning({ id: schema.outboxMessages.id })

    return rows.length > 0
  }
}
