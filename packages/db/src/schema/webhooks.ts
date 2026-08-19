import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { webhookDeliveryStatus } from './enums'
import { orgs } from './tenancy'

/**
 * Assinatura de eventos. `secret` assina o corpo em HMAC-SHA256 para que o
 * receptor consiga verificar a origem (§4.2).
 *
 * `sessionScope` nulo significa "todas as sessões da org".
 */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    events: text('events').array().notNull(),
    sessionScope: uuid('session_scope').array(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhooks_org_idx').on(t.orgId)],
)

/**
 * Uma tentativa de entrega por linha de fila. Existe pelo mesmo motivo do
 * outbox: webhook disparado e esquecido é perda silenciosa de evento.
 *
 * Ao esgotar `maxAttempts` a linha vira `dead` e fica disponível para replay
 * manual pelo dashboard.
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),

    status: webhookDeliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),

    responseStatus: integer('response_status'),
    responseBody: text('response_body'),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    index('webhook_deliveries_dispatch_idx').on(t.status, t.availableAt),
    index('webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt),
  ],
)
