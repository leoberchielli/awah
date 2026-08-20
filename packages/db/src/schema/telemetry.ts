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
 * Risk engine decision, one row per evaluation (§4.1).
 *
 * Storing the budget snapshot next to the decision is what makes the behaviour
 * auditable: months later you can still answer "why was this message delayed
 * 40 s at 14:03" without reconstructing state.
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
    /** Score 0–100 at the moment of the decision. */
    score: integer('score').notNull(),
    reason: text('reason').notNull(),
    /** Minute/hour/day window usage and new contacts at that moment. */
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
 * Hourly aggregate. The dashboard reads from here and nowhere else — scanning
 * the raw tables on every panel load is the mistake that turns observability
 * into a database incident (§4.3).
 *
 * A null `sessionId` stands for the whole-org aggregate. The unique index uses
 * NULLS NOT DISTINCT so that case stays a single row — which requires
 * PostgreSQL 15 or later.
 */
export const metricsHourly = pgTable(
  'metrics_hourly',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    /** Start of the hour, always in UTC. */
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
