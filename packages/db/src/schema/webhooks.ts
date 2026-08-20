import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { webhookDeliveryStatus } from './enums'
import { orgs } from './tenancy'

/**
 * Event subscription. `secret` signs the body with HMAC-SHA256 so the receiver
 * can verify where it came from (§4.2).
 *
 * A null `sessionScope` means "every session in the org".
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
 * One delivery attempt per queue row. It exists for the same reason the outbox
 * does: a webhook fired and forgotten is a silently lost event.
 *
 * Once `maxAttempts` runs out the row turns `dead` and stays available for
 * manual replay from the dashboard.
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
