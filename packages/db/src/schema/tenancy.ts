import { index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { memberRole } from './enums'

/**
 * Organização é a unidade de isolamento. Toda tabela de domínio carrega `orgId`
 * e a guarda vive na camada de repositório (§6 da spec).
 */
export const orgs = pgTable(
  'orgs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /**
     * Retenção de conteúdo em dias (§2). 0 significa nunca persistir corpo de
     * mensagem — só metadados. -1 significa reter para sempre.
     */
    retentionDays: integer('retention_days').notNull().default(30),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('orgs_slug_key').on(t.slug)],
)

/**
 * Usuário é global, não pertence a uma org — a ligação é a membership. Isso
 * permite que a mesma pessoa opere várias orgs com papéis diferentes.
 * `email` é sempre normalizado para minúsculas antes de gravar.
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

/** O papel é por membro dentro de uma org, nunca global (§6). */
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
 * Sessão de login do dashboard. Token opaco guardado como hash — o valor cru só
 * existe no cookie httpOnly do navegador, o que torna a revogação imediata.
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
 * Chave de API. O segredo nunca é persistido em claro: guardamos o hash argon2id
 * e um `prefix` público que serve tanto para o lookup quanto para o usuário
 * identificar a chave no dashboard sem revelá-la.
 *
 * `sessionScope` nulo significa "todas as sessões da org"; um array restringe a
 * chave às sessões listadas.
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
