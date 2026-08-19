import { and, type Database, eq, schema, sql } from '@awah/db'

/** Eventos que o AWAH publica. Assinar `*` recebe todos. */
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
 * Enfileira o evento para todas as assinaturas interessadas.
 *
 * Enfileirar e entregar são passos separados de propósito: a entrega pode levar
 * segundos e falhar, e nada disso pode atrasar nem derrubar o caminho que
 * originou o evento — receber uma mensagem, concluir um envio.
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

    // Escopo nulo alcança todas as sessões da organização.
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

/** Recoloca entregas mortas na fila. Usado pelo replay do dashboard. */
export async function replayDeadDeliveries(
  db: Database,
  orgId: string,
  ids?: string[],
): Promise<number> {
  // Um parâmetro por id: interpolar o array inteiro faria o driver mandá-lo
  // como texto, e o Postgres recusaria com "malformed array literal".
  const filtroIds =
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
      ${filtroIds}
    RETURNING id
  `)

  return [...result].length
}
