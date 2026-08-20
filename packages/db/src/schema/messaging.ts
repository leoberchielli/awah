import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { messageDirection, messageStatus, messageType, outboxStatus } from './enums'
import { sessions } from './sessions'
import { orgs } from './tenancy'

/**
 * Durable send queue (§4.2). Every send call becomes a row here BEFORE any
 * network I/O — if the process dies halfway, the message goes out later.
 *
 * `availableAt` is the scheduler's single clock: retry backoff and the risk
 * engine's hold write to the same field, so there is only one eligibility test.
 */
export const outboxMessages = pgTable(
  'outbox_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),

    /**
     * Total arrival order. Per-chat FIFO needs an absolute tie-breaker: two
     * sends created in the same microsecond would carry the same `created_at`,
     * and the chat's queue would lose its order under exactly the load where
     * order matters most.
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),

    /** Idempotency: the same id from the client never produces two sends. */
    clientMessageId: text('client_message_id').notNull(),
    chatId: text('chat_id').notNull(),
    type: messageType('type').notNull(),
    payload: jsonb('payload').notNull(),

    status: outboxStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    /** Why the risk engine held this message, when it did. */
    heldReason: text('held_reason'),
    lastError: text('last_error'),

    /** Id the engine assigned after the send, used in reconciliation. */
    engineMessageId: text('engine_message_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    unique('outbox_client_message_key').on(t.orgId, t.clientMessageId),
    // Scheduler sweep: picks up what is eligible now, in arrival order.
    index('outbox_dispatch_idx').on(t.status, t.availableAt, t.seq),
    // FIFO order within a chat, with parallelism across distinct chats.
    index('outbox_chat_order_idx').on(t.sessionId, t.chatId, t.seq),
  ],
)

/**
 * Materialized message, in both directions.
 *
 * `body` and the media references are wiped once `contentExpiresAt` passes,
 * degrading the row to pure metadata — that is how the retention TTL from §2
 * works without losing the volume and latency KPIs.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),

    chatId: text('chat_id').notNull(),
    engineMessageId: text('engine_message_id').notNull(),
    direction: messageDirection('direction').notNull(),
    type: messageType('type').notNull(),
    status: messageStatus('status').notNull().default('pending'),

    fromJid: text('from_jid'),
    toJid: text('to_jid'),

    /** Null once the retention TTL expires. */
    body: text('body'),
    mediaRef: text('media_ref'),
    mediaMimeType: text('media_mime_type'),
    mediaSize: integer('media_size'),
    contentExpiresAt: timestamp('content_expires_at', { withTimezone: true }),

    outboxId: uuid('outbox_id').references(() => outboxMessages.id, { onDelete: 'set null' }),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('messages_engine_id_key').on(t.orgId, t.sessionId, t.engineMessageId),
    index('messages_chat_idx').on(t.orgId, t.chatId, t.occurredAt),
    index('messages_session_time_idx').on(t.sessionId, t.occurredAt),
    // Used by the content purge job.
    index('messages_retention_idx').on(t.contentExpiresAt),
  ],
)

/**
 * Append-only ACK trail. It is the source of the sent → delivered → read funnel
 * and of the p50/p95/p99 latencies per stage (§7).
 */
export const messageStatusEvents = pgTable(
  'message_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    status: messageStatus('status').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('message_status_unique').on(t.messageId, t.status),
    index('message_status_message_idx').on(t.messageId, t.occurredAt),
  ],
)
