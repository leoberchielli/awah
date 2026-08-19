import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { riskAction } from './enums'
import { outboxMessages } from './messaging'
import { sessions } from './sessions'
import { orgs } from './tenancy'

/**
 * Decisão do motor de risco, uma linha por avaliação (§4.1).
 *
 * Guardar o snapshot do orçamento junto da decisão é o que torna o
 * comportamento auditável: dá para responder "por que esta mensagem atrasou
 * 40 s às 14h03" meses depois, sem reconstituir estado.
 */
export const riskEvents = pgTable(
  'risk_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    outboxId: uuid('outbox_id').references(() => outboxMessages.id, { onDelete: 'set null' }),

    action: riskAction('action').notNull(),
    /** Score 0–100 no momento da decisão. */
    score: integer('score').notNull(),
    reason: text('reason').notNull(),
    /** Consumo das janelas por minuto/hora/dia e contatos novos no momento. */
    budget: jsonb('budget'),
    delayMs: integer('delay_ms'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('risk_events_session_idx').on(t.sessionId, t.createdAt),
    index('risk_events_org_idx').on(t.orgId, t.createdAt),
  ],
)

/**
 * Agregado horário. O dashboard lê exclusivamente daqui — varrer as tabelas
 * cruas a cada carregamento de painel é o erro que transforma observabilidade
 * em incidente de banco (§4.3).
 *
 * `sessionId` nulo representa o agregado da org inteira. O índice único usa
 * NULLS NOT DISTINCT para que esse caso continue sendo uma linha só — isso
 * exige PostgreSQL 15 ou superior.
 */
export const metricsHourly = pgTable(
  'metrics_hourly',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    /** Início da hora, sempre em UTC. */
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    metric: text('metric').notNull(),
    value: doublePrecision('value').notNull(),
    dims: jsonb('dims'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('metrics_hourly_key').on(t.orgId, t.sessionId, t.bucket, t.metric).nullsNotDistinct(),
    index('metrics_hourly_lookup_idx').on(t.orgId, t.metric, t.bucket),
  ],
)
