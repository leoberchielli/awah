import type { MessageType } from '@awah/db'
import { type Database, sql } from '@awah/db'

/**
 * Outbox queue operations.
 *
 * Unlike the rest of the data access, these functions cross organizations on
 * purpose: the scheduler is node infrastructure and works over the sessions
 * this process hosts, whoever they belong to. Every read that starts from an
 * HTTP request still goes through the tenant-scoped repository.
 */

export interface ClaimedJob {
  id: string
  orgId: string
  sessionId: string
  chatId: string
  clientMessageId: string
  type: MessageType
  payload: Record<string, unknown>
  attempts: number
  maxAttempts: number
}

/**
 * Claims up to `limit` eligible sends.
 *
 * Two guarantees live in this query:
 *
 * 1. **FIFO per chat** — `DISTINCT ON (session_id, chat_id) … ORDER BY seq`
 *    takes only the head of each conversation's queue, and the `NOT EXISTS`
 *    stops the next one from being claimed while the previous one is still on
 *    its way out. Different chats go on in parallel.
 * 2. **Exclusivity between workers** — the `UPDATE … WHERE status = 'queued'`
 *    only affects rows that were still queued. If another replica claimed one
 *    in the meantime, the status has already changed and the row simply does
 *    not come back in the RETURNING. Same effect as a SKIP LOCKED, without the
 *    risk of combining an explicit lock with an aggregated subquery.
 */
export async function claimOutbox(
  db: Database,
  sessionIds: string[],
  limit: number,
): Promise<ClaimedJob[]> {
  if (sessionIds.length === 0 || limit <= 0) return []

  /**
   * One parameter per id, instead of an interpolated array. Interpolating the
   * whole array makes the driver send it as text, and Postgres rejects it with
   * "malformed array literal" — an `IN` with individual parameters is explicit
   * and stays immune to injection.
   */
  const ids = sql.join(
    sessionIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )

  const result = await db.execute(sql`
    WITH heads AS (
      SELECT DISTINCT ON (o.session_id, o.chat_id) o.id
      FROM outbox_messages o
      WHERE o.status = 'queued'
        AND o.available_at <= now()
        AND o.session_id IN (${ids})
        AND NOT EXISTS (
          SELECT 1 FROM outbox_messages busy
          WHERE busy.session_id = o.session_id
            AND busy.chat_id = o.chat_id
            AND busy.status = 'sending'
        )
      ORDER BY o.session_id, o.chat_id, o.seq
      LIMIT ${limit}
    )
    UPDATE outbox_messages target
    SET status = 'sending', updated_at = now()
    FROM heads
    WHERE target.id = heads.id
      AND target.status = 'queued'
    RETURNING
      target.id,
      target.org_id,
      target.session_id,
      target.chat_id,
      target.client_message_id,
      target.type,
      target.payload,
      target.attempts,
      target.max_attempts
  `)

  return [...result].map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: String(r.id),
      orgId: String(r.org_id),
      sessionId: String(r.session_id),
      chatId: String(r.chat_id),
      clientMessageId: String(r.client_message_id),
      type: r.type as MessageType,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      attempts: Number(r.attempts),
      maxAttempts: Number(r.max_attempts),
    }
  })
}

export async function markSent(db: Database, id: string, engineMessageId: string): Promise<void> {
  await db.execute(sql`
    UPDATE outbox_messages
    SET status = 'sent',
        engine_message_id = ${engineMessageId},
        sent_at = now(),
        updated_at = now(),
        last_error = NULL
    WHERE id = ${id}::uuid
  `)
}

/**
 * Puts the send back in the queue with a wait, or sends it to the DLQ once the
 * attempts run out. Never drops it: a dead message is still queryable and can
 * be reprocessed.
 */
export async function markFailed(
  db: Database,
  id: string,
  error: string,
  nextDelayMs: number,
): Promise<'queued' | 'dead'> {
  const result = await db.execute(sql`
    UPDATE outbox_messages
    SET attempts = attempts + 1,
        last_error = ${error.slice(0, 2000)},
        updated_at = now(),
        status = CASE
          WHEN attempts + 1 >= max_attempts THEN 'dead'::outbox_status
          ELSE 'queued'::outbox_status
        END,
        available_at = CASE
          WHEN attempts + 1 >= max_attempts THEN available_at
          ELSE now() + (${nextDelayMs} || ' milliseconds')::interval
        END
    WHERE id = ${id}::uuid
    RETURNING status
  `)

  const first = [...result][0] as { status?: string } | undefined
  return first?.status === 'dead' ? 'dead' : 'queued'
}

/**
 * Holds the send until the budget window opens.
 *
 * A state of its own, separate from `queued`, because the difference matters
 * to whoever is operating: `held` means "the risk engine is protecting your
 * number", with a set time to go out. It consumes no attempt — nothing failed.
 */
export async function hold(db: Database, id: string, until: Date, reason: string): Promise<void> {
  await db.execute(sql`
    UPDATE outbox_messages
    SET status = 'queued',
        held_reason = ${reason},
        available_at = ${until.toISOString()}::timestamptz,
        updated_at = now()
    WHERE id = ${id}::uuid AND status = 'sending'
  `)
}

/**
 * Puts it back in the queue without consuming an attempt. Used when the
 * session went down between the claim and the send — nothing failed to
 * deliver, there is just no way out right now.
 */
export async function release(db: Database, id: string, delayMs = 5000): Promise<void> {
  await db.execute(sql`
    UPDATE outbox_messages
    SET status = 'queued',
        available_at = now() + (${delayMs} || ' milliseconds')::interval,
        updated_at = now()
    WHERE id = ${id}::uuid AND status = 'sending'
  `)
}

/**
 * Frees sends left stuck in 'sending' — the process died between the claim and
 * the finish. Without this, that chat's queue jams forever, since the claim's
 * `NOT EXISTS` would go on seeing a send in progress that no longer exists.
 */
export async function recoverStuck(db: Database, olderThanMs: number): Promise<number> {
  const result = await db.execute(sql`
    UPDATE outbox_messages
    SET status = 'queued', updated_at = now()
    WHERE status = 'sending'
      AND updated_at < now() - (${olderThanMs} || ' milliseconds')::interval
    RETURNING id
  `)

  return [...result].length
}
