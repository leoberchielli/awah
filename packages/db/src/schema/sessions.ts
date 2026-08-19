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
 * Sessão de WhatsApp. `ownerNodeId` + `leaseExpiresAt` implementam a posse
 * distribuída do §4.4: a réplica dona renova o lease a cada 5 s e qualquer
 * réplica pode assumir uma sessão cujo lease tenha expirado.
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
    /** Onde a sessão deveria estar. O failover só assume o que está 'running'. */
    desiredState: desiredState('desired_state').notNull().default('stopped'),
    phoneNumber: text('phone_number'),

    /** Réplica que detém a sessão agora. Nulo quando ninguém a detém. */
    ownerNodeId: text('owner_node_id'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),

    /**
     * Primeiro pareamento bem-sucedido. A idade derivada daqui alimenta a curva
     * de warmup do motor de risco (§4.1) — número novo envia menos.
     */
    pairedAt: timestamp('paired_at', { withTimezone: true }),
    lastConnectedAt: timestamp('last_connected_at', { withTimezone: true }),
    lastDisconnectedAt: timestamp('last_disconnected_at', { withTimezone: true }),

    /** Overrides de orçamento de risco, proxy e opções da engine. */
    config: jsonb('config').notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('sessions_org_name_key').on(t.orgId, t.name),
    index('sessions_org_idx').on(t.orgId),
    index('sessions_status_idx').on(t.status),
    // O varredor de failover procura leases vencidos por aqui.
    index('sessions_lease_idx').on(t.leaseExpiresAt),
  ],
)

/**
 * Credenciais da engine, cifradas em repouso com AES-256-GCM.
 *
 * Esta tabela é a decisão que destrava o cluster inteiro (§4.4): enquanto o auth
 * state do Baileys vive em arquivo, a sessão está presa ao disco de um nó.
 */
export const sessionAuth = pgTable('session_auth', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  /** Payload cifrado: iv.authTag.ciphertext em base64url. */
  creds: text('creds').notNull(),
  /** Versão da chave de cifra, para permitir rotação sem downtime. */
  keyVersion: integer('key_version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Signal key store do Baileys, uma linha por chave.
 *
 * Poderia ser um blob único dentro de `session_auth`, e o desenho original era
 * esse. Mas o store cresce sem teto — pre-keys, sessions e sender-keys por
 * contato — e o Baileys escreve nele a cada mensagem. Com blob único, cada
 * mensagem recebida obrigaria a ler, decifrar, mesclar, cifrar e regravar
 * megabytes. Linha por chave transforma isso em um upsert pontual.
 */
export const sessionAuthKeys = pgTable(
  'session_auth_keys',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** Categoria do Signal: pre-key, session, sender-key, app-state-sync-key… */
    keyType: text('key_type').notNull(),
    keyId: text('key_id').notNull(),
    /** Valor cifrado, mesmo formato de `session_auth.creds`. */
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
 * Trilha de conexão e queda. `rawCode` guarda o código do protocolo como veio
 * (428, 440, 515, …) e `cause` guarda a tradução legível — é o que alimenta a
 * timeline de desconexão do dashboard (§4.3).
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
    cause: text('cause'),
    nodeId: text('node_id'),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('session_events_session_idx').on(t.sessionId, t.createdAt),
    index('session_events_org_idx').on(t.orgId, t.createdAt),
  ],
)
