import { index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { memberRole } from './enums'

/**
 * The org is the unit of isolation. Every domain table carries `orgId` and the
 * guard lives in the repository layer (spec §6).
 */
export const orgs = pgTable(
  'orgs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /**
     * Content retention in days (§2). 0 means never persist a message body —
     * metadata only. -1 means keep it forever.
     */
    retentionDays: integer('retention_days').notNull().default(30),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('orgs_slug_key').on(t.slug)],
)

/**
 * A user is global, it does not belong to an org — the membership is the link.
 * That lets the same person operate several orgs with different roles.
 * `email` is always normalized to lowercase before it is written.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('users_email_key').on(t.email)],
)

/** The role is per member within an org, never global (§6). */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole('role').notNull().default('viewer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('memberships_org_user_key').on(t.orgId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
)

/**
 * Dashboard login session. Opaque token stored as a hash — the raw value only
 * exists in the browser's httpOnly cookie, which makes revocation immediate.
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('user_sessions_token_key').on(t.tokenHash),
    index('user_sessions_user_idx').on(t.userId),
    index('user_sessions_expires_idx').on(t.expiresAt),
  ],
)

/**
 * API key. The secret is never persisted in the clear: we keep the argon2id hash
 * and a public `prefix` that serves both the lookup and the user identifying the
 * key in the dashboard without revealing it.
 *
 * A null `sessionScope` means "every session in the org"; an array restricts the
 * key to the sessions listed.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    role: memberRole('role').notNull().default('operator'),
    sessionScope: uuid('session_scope').array(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('api_keys_prefix_key').on(t.prefix), index('api_keys_org_idx').on(t.orgId)],
)
