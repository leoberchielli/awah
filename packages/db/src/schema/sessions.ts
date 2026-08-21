import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { desiredState, engineType, sessionEventType, sessionStatus } from './enums'
import { orgs } from './tenancy'

/**
 * WhatsApp session. `ownerNodeId` + `leaseExpiresAt` implement the distributed
 * ownership of §4.4: the owning replica renews the lease every 5 s and any
 * replica may take over a session whose lease has expired.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    engine: engineType('engine').notNull().default('baileys'),
    status: sessionStatus('status').notNull().default('created'),
    /** Where the session should be. Failover only takes over what is 'running'. */
    desiredState: desiredState('desired_state').notNull().default('stopped'),
    phoneNumber: text('phone_number'),

    /** Replica that holds the session right now. Null when nobody holds it. */
    ownerNodeId: text('owner_node_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),

    /**
     * First successful pairing. The age derived from this feeds the risk
     * engine's warm-up curve (§4.1) — a new number sends less.
     */
    pairedAt: timestamp('paired_at', { withTimezone: true }),
    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    lastDisconnectedAt: timestamp('last_disconnected_at', { withTimezone: true }),

    /** Risk budget overrides, proxy, and engine options. */
    config: jsonb('config').notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sessions_org_name_key').on(t.orgId, t.name),
    index('sessions_org_idx').on(t.orgId),
    index('sessions_status_idx').on(t.status),
    // The failover sweeper looks for expired leases through here.
    index('sessions_lease_idx').on(t.leaseExpiresAt),
  ],
)

/**
 * Engine credentials, encrypted at rest with AES-256-GCM.
 *
 * This table is the decision that unlocks the whole cluster (§4.4): as long as
 * the Baileys auth state lives in a file, the session is stuck to one node's disk.
 */
export const sessionAuth = pgTable('session_auth', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  /** Encrypted payload: iv.authTag.ciphertext in base64url. */
  creds: text('creds').notNull(),
  /** Encryption key version, so keys can be rotated with no downtime. */
  keyVersion: integer('key_version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Baileys Signal key store, one row per key.
 *
 * It could be a single blob inside `session_auth`, and that was the original
 * design. But the store grows with no ceiling — pre-keys, sessions and
 * sender-keys per contact — and Baileys writes to it on every message. With a
 * single blob, each inbound message would force a read, decrypt, merge, encrypt
 * and rewrite of megabytes. One row per key turns that into a targeted upsert.
 */
export const sessionAuthKeys = pgTable(
  'session_auth_keys',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** Signal category: pre-key, session, sender-key, app-state-sync-key… */
    keyType: text('key_type').notNull(),
    keyId: text('key_id').notNull(),
    /** Encrypted value, same format as `session_auth.creds`. */
    value: text('value').notNull(),
    keyVersion: integer('key_version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.keyType, t.keyId] }),
    index('session_auth_keys_session_idx').on(t.sessionId),
  ],
)

/**
 * Trail of connections and drops. `rawCode` keeps the protocol code as it came
 * (428, 440, 515, …) and `cause` keeps the readable translation — this is what
 * feeds the dashboard's disconnection timeline (§4.3).
 */
export const sessionEvents = pgTable(
  'session_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    type: sessionEventType('type').notNull(),
    rawCode: integer('raw_code'),
    /**
     * The cause in English prose, for anything reading the API directly.
     *
     * Kept alongside `causeCode` rather than replaced by it: a code is only
     * useful to a caller that knows the vocabulary, and an integrator reading
     * the response for the first time should not have to.
     */
    cause: text('cause'),
    /**
     * A stable slug for the same fact, so a client can say it in its own
     * language.
     *
     * The dashboard is translated into ten languages and used to print `cause`
     * verbatim, which meant a German operator read why their session dropped in
     * English. A sentence assembled by the server cannot be translated by the
     * client; a code and its values can.
     */
    causeCode: text('cause_code'),
    nodeId: text('node_id'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('session_events_session_idx').on(t.sessionId, t.createdAt),
    index('session_events_org_idx').on(t.orgId, t.createdAt),
  ],
)
