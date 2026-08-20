import { and, type Database, eq, schema, sql } from '@awah/db'

/** Events AWAH publishes. Subscribing to `*` gets all of them. */
export const WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.status',
  'message.failed',
  'session.status',
] as const

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

export interface EmitInput {
  orgId: string
  sessionId: string | null
  event: WebhookEvent
  data: Record<string, unknown>
}

/**
 * Queues the event for every subscription that wants it.
 *
 * Queueing and delivering are separate steps on purpose: delivery can take
 * seconds and can fail, and none of that may delay or bring down the path the
 * event came from — receiving a message, completing a send.
 */
export async function emitWebhook(db: Database, input: EmitInput): Promise<number> {
  const hooks = await db
    .select({
      id: schema.webhooks.id,
      events: schema.webhooks.events,
      sessionScope: schema.webhooks.sessionScope,
    })
    .from(schema.webhooks)
    .where(and(eq(schema.webhooks.orgId, input.orgId), eq(schema.webhooks.active, true)))

  const targets = hooks.filter((hook) => {
    const subscribed = hook.events.includes(input.event) || hook.events.includes('*')
    if (!subscribed) return false

    // A null scope reaches every session in the organization.
    if (!hook.sessionScope || !input.sessionId) return true
    return hook.sessionScope.includes(input.sessionId)
  })

  if (targets.length === 0) return 0

  await db.insert(schema.webhookDeliveries).values(
    targets.map((hook) => ({
      orgId: input.orgId,
      webhookId: hook.id,
      eventType: input.event,
      payload: input.data,
    })),
  )

  return targets.length
}

/** Puts dead deliveries back on the queue. Used by the dashboard replay. */
export async function replayDeadDeliveries(
  db: Database,
  orgId: string,
  ids?: string[],
): Promise<number> {
  // One parameter per id: interpolating the whole array would make the driver
  // send it as text, and Postgres would refuse with "malformed array literal".
  const filterIds =
    ids && ids.length > 0
      ? sql`AND id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``

  const result = await db.execute(sql`
    UPDATE webhook_deliveries
    SET status = 'pending',
        attempts = 0,
        available_at = now(),
        last_error = NULL
    WHERE org_id = ${orgId}::uuid
      AND status = 'dead'
      ${filterIds}
    RETURNING id
  `)

  return [...result].length
}
