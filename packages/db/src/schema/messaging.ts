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
 * Fila durável de envio (§4.2). Toda chamada de envio vira uma linha aqui ANTES
 * de qualquer I/O de rede — se o processo morre no meio, a mensagem sai depois.
 *
 * `availableAt` é o relógio único do scheduler: backoff de retry e hold do motor
 * de risco escrevem no mesmo campo, então existe um só critério de elegibilidade.
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
     * Ordem total de chegada. O FIFO por chat precisa de um critério de
     * desempate absoluto: dois envios criados no mesmo microssegundo teriam o
     * mesmo `created_at`, e a fila do chat perderia a ordem justamente sob a
     * carga em que a ordem mais importa.
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),

    /** Idempotência: o mesmo id vindo do cliente nunca gera dois envios. */
    clientMessageId: text('client_message_id').notNull(),
    chatId: text('chat_id').notNull(),
    type: messageType('type').notNull(),
    payload: jsonb('payload').notNull(),

    status: outboxStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    /** Por que o motor de risco segurou esta mensagem, quando segurou. */
    heldReason: text('held_reason'),
    lastError: text('last_error'),

    /** Id atribuído pela engine depois do envio, usado na reconciliação. */
    engineMessageId: text('engine_message_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    unique('outbox_client_message_key').on(t.orgId, t.clientMessageId),
    // Varredura do scheduler: pega o que está elegível agora, em ordem de chegada.
    index('outbox_dispatch_idx').on(t.status, t.availableAt, t.seq),
    // Ordem FIFO dentro de um chat, com paralelismo entre chats distintos.
    index('outbox_chat_order_idx').on(t.sessionId, t.chatId, t.seq),
  ],
)

/**
 * Mensagem materializada, nos dois sentidos.
 *
 * `body` e as referências de mídia são apagados quando `contentExpiresAt` passa,
 * degradando a linha para metadados puros — é assim que o TTL de retenção do §2
 * funciona sem perder os KPIs de volume e latência.
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

    /** Nulo depois que o TTL de retenção expira. */
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
    // Usado pelo job de expurgo de conteúdo.
    index('messages_retention_idx').on(t.contentExpiresAt),
  ],
)

/**
 * Trilha append-only de ACK. É a fonte do funil sent → delivered → read e das
 * latências p50/p95/p99 por etapa (§7).
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
