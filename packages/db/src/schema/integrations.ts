import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { integrationKind } from './enums'
import { sessions } from './sessions'
import { orgs } from './tenancy'

/**
 * The link between a session and an outside tool.
 *
 * The choice here is deliberate: instead of building our own inbox and flow
 * builder, AWAH is the transport for the people who already got that right.
 * Chatwoot handles human support, Typebot handles the flow — and the gateway
 * delivers what neither of them has, which is a durable queue, per-conversation
 * ordering and a risk engine underneath.
 *
 * `config` is encrypted because it holds an API token: whoever gets it writes
 * into the customer's support account.
 */
export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: integrationKind('kind').notNull(),
    /** JSON encrypted with AES-256-GCM. Never returned on read. */
    config: text('config').notNull(),
    active: boolean('active').notNull().default(true),
    /** Last failure talking to the tool, so the panel can explain the silence. */
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('integrations_org_idx').on(t.orgId),
    /**
     * One integration of each kind per session.
     *
     * Two of the same kind on the same session would duplicate every inbound
     * message in the destination tool, and the operator would see the
     * conversation twice over without understanding why.
     */
    unique('integrations_session_kind_key').on(t.sessionId, t.kind),
  ],
)

/**
 * The bond between a WhatsApp conversation and the same conversation outside.
 *
 * Without this table, every inbound message would have to ask the tool "what is
 * the id of this conversation?" — one more network call on the critical path of
 * every message, and a failure point that would put the conversation in the
 * wrong order whenever the API on the other side was slow.
 *
 * `externalConversationId` holds the conversation id in Chatwoot or the flow
 * session in Typebot, depending on the kind.
 */
export const integrationLinks = pgTable(
  'integration_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    /** WhatsApp JID, exactly as the engine hands it over. */
    chatId: text('chat_id').notNull(),
    externalConversationId: text('external_conversation_id').notNull(),
    /** Contact in Chatwoot. Null on Typebot, which has no such concept. */
    externalContactId: text('external_contact_id'),
    /** Room for whatever each connector needs to keep per conversation. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    /**
     * A flow session expires; a support conversation does not. Null means
     * "never expires".
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('integration_links_key').on(t.integrationId, t.chatId),
    index('integration_links_external_idx').on(t.integrationId, t.externalConversationId),
  ],
)
