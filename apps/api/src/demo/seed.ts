import { type Database, eq, schema, sql } from '@awah/db'
import { hashPassword } from '../auth/password'
import { hashToken } from '../lib/crypto'
import type { ManagerLogger } from '../sessions/manager'
import { MetricsAggregator } from '../telemetry/aggregator'

/**
 * Fixed identifiers, so the demo is the same object across resets.
 *
 * A demo whose ids change every few hours cannot be linked to: the README
 * cannot point at a session, a screenshot in the docs goes stale, and the reset
 * silently breaks every bookmark. They are v4-shaped on purpose — Postgres only
 * accepts a well-formed uuid — and end in recognizable digits so a row from the
 * demo is obvious in a log.
 */
export const DEMO_ORG_ID = '0de3a000-0000-4000-8000-00000000d0a0'
export const DEMO_USER_ID = '0de3a000-0000-4000-8000-00000000d0b0'
export const DEMO_ORG_SLUG = 'demo'

export const DEMO_SESSION_IDS = {
  support: '0de3a000-0000-4000-8000-00000000d0c1',
  sales: '0de3a000-0000-4000-8000-00000000d0c2',
  billing: '0de3a000-0000-4000-8000-00000000d0c3',
} as const

/**
 * The demo's API key, published like the password.
 *
 * It exists so the `curl` in the docs can be copied and run without signing in
 * first — the fastest way to see that this is an API and not a screenshot. The
 * prefix is hex because `parseApiKey` splits on the first `_` after the scheme
 * and identifies the key by that prefix.
 */
export const DEMO_API_KEY_ID = '0de3a000-0000-4000-8000-00000000d0d0'
const DEMO_KEY_PREFIX = 'de3ade3ade3ade3a'
const DEMO_KEY_SECRET = 'public-demo-key-not-a-secret'
export const DEMO_API_KEY = `awah_${DEMO_KEY_PREFIX}_${DEMO_KEY_SECRET}`

const DEMO_WEBHOOK_ID = '0de3a000-0000-4000-8000-00000000d0e0'

/** Where the seeded webhook deliveries point. Answered by the demo plugin. */
export const DEMO_WEBHOOK_PATH = '/v1/demo/webhook-sink'

/** How much history the seed writes. The panel's widest window is 30 days. */
const HISTORY_DAYS = 30

export interface DemoSeedDeps {
  db: Database
  logger: ManagerLogger
  email: string
  password: string
  publicUrl: string | null
}

interface DemoSessionSpec {
  id: string
  name: string
  /** Read back by the manager from `config.simulator.scenario`. */
  scenario: 'mature' | 'healthy' | 'degraded'
  phoneNumber: string
  /** Days since pairing. It sets the warm-up ceiling, so it is not cosmetic. */
  ageDays: number
  /** Outbound messages in a busy hour. Night and weekend scale down from here. */
  peakPerHour: number
  deliveryRate: number
  readRate: number
  failureRate: number
  medianLatencyMs: number
}

/**
 * Three numbers, because one number cannot show the thing this project is
 * about.
 *
 * The support line is a mature number running well; sales is three days old and
 * still inside the warm-up ramp, which is where the caps are visible; billing is
 * degraded, which is what an operator actually needs the dashboard for. A demo
 * where everything is green teaches nothing about a gateway whose whole reason
 * to exist is the day things stop being green.
 */
const DEMO_SESSIONS: DemoSessionSpec[] = [
  {
    id: DEMO_SESSION_IDS.support,
    name: 'Support',
    scenario: 'mature',
    phoneNumber: '5511999990001',
    ageDays: 47,
    peakPerHour: 22,
    deliveryRate: 0.97,
    readRate: 0.74,
    failureRate: 0.015,
    medianLatencyMs: 1_100,
  },
  {
    id: DEMO_SESSION_IDS.sales,
    name: 'Sales',
    scenario: 'healthy',
    phoneNumber: '5511999990002',
    ageDays: 3,
    peakPerHour: 9,
    deliveryRate: 0.95,
    readRate: 0.61,
    failureRate: 0.03,
    medianLatencyMs: 1_900,
  },
  {
    id: DEMO_SESSION_IDS.billing,
    name: 'Billing',
    scenario: 'degraded',
    phoneNumber: '5511999990003',
    ageDays: 12,
    peakPerHour: 12,
    deliveryRate: 0.52,
    readRate: 0.18,
    failureRate: 0.14,
    medianLatencyMs: 3_600,
  },
]

const INBOUND_TEXTS = [
  'hi, is anyone there?',
  'i want to know the price',
  'my order has not arrived',
  'can you send the invoice?',
  'is the store open tomorrow?',
  'thanks!',
  'i need to change my address',
  'the payment failed, what now?',
]

/** Roughly what a support line receives: mostly text, some media. */
function inboundType(roll: number): 'text' | 'image' | 'audio' | 'document' {
  if (roll < 0.08) return 'image'
  if (roll < 0.13) return 'audio'
  if (roll < 0.15) return 'document'
  return 'text'
}

const OUTBOUND_TEXTS = [
  'Hi! How can we help?',
  'Your order left our warehouse this morning.',
  'The invoice is attached — let us know if anything looks off.',
  'We are open from 9am to 6pm, Monday to Friday.',
  'Sure, I can update that for you.',
  'Sorry about the wait. Looking into it now.',
]

/**
 * Deterministic pseudo-randomness.
 *
 * `Math.random` would make every reset produce a different-looking demo, and
 * with it every screenshot in the docs and every number quoted in the README.
 * The same seed gives the same history, which is what lets the documentation
 * say "the funnel shows about 94%" and still be true tomorrow.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * The shape of a support day, as a multiplier on the peak hour.
 *
 * Flat traffic reads as fake at a glance, and worse, it hides what the hourly
 * charts are for: nobody looks at a straight line to find the hour something
 * went wrong.
 */
const HOUR_CURVE = [
  0.02, 0.01, 0.01, 0.01, 0.01, 0.02, 0.06, 0.18, 0.45, 0.78, 0.95, 1.0, 0.72, 0.68, 0.92, 0.97,
  0.85, 0.6, 0.4, 0.28, 0.19, 0.12, 0.07, 0.04,
]

const CONTACT_POOL = Array.from({ length: 420 }, (_, i) => `55119${String(87650000 + i * 137)}`)

/**
 * How much of the contact pool exists on a given day of the history.
 *
 * A fixed set of numbers would make every contact after the first day a
 * returning one, and the risk engine's new-contact signal — the thing that
 * drives the score, and the reason the engine paces sending at all — would read
 * zero forever. A book of contacts that grows is also just what a working
 * number looks like.
 */
function contactsByDay(day: number): number {
  return Math.min(CONTACT_POOL.length, 60 + day * 12)
}

const chatOf = (phone: string) => `${phone}@s.whatsapp.net`

/** Rows go in in batches: one statement per message would take minutes. */
async function insertInBatches<T>(
  rows: T[],
  size: number,
  write: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await write(rows.slice(i, i + size))
  }
}

interface GeneratedHistory {
  messages: (typeof schema.messages.$inferInsert)[]
  statuses: Array<{
    engineMessageId: string
    status: 'delivered' | 'read' | 'failed'
    occurredAt: Date
  }>
  risk: (typeof schema.riskEvents.$inferInsert)[]
  sessionEvents: (typeof schema.sessionEvents.$inferInsert)[]
  webhooks: (typeof schema.webhookDeliveries.$inferInsert)[]
}

/**
 * Writes a plausible month of operation.
 *
 * Everything here is historical by definition: a message that left three weeks
 * ago cannot be produced by sending one now. What the visitor does *live* —
 * enqueue a send, watch the risk engine hold it, see the ACK come back — runs
 * through the real pipeline against the simulator engine. This function only
 * fills in the past, so the first screen is a dashboard and not an empty state.
 */
function generateHistory(now: Date): GeneratedHistory {
  const random = mulberry32(0x4157_4148)
  const out: GeneratedHistory = {
    messages: [],
    statuses: [],
    risk: [],
    sessionEvents: [],
    webhooks: [],
  }

  const hourMs = 3_600_000
  const totalHours = HISTORY_DAYS * 24
  // Whole hours, so every generated message lands inside a chart bucket.
  const firstHour = new Date(Math.floor((now.getTime() - totalHours * hourMs) / hourMs) * hourMs)

  for (const session of DEMO_SESSIONS) {
    let counter = 0
    const pairedAt = new Date(now.getTime() - session.ageDays * 86_400_000)

    out.sessionEvents.push({
      orgId: DEMO_ORG_ID,
      sessionId: session.id,
      type: 'paired',
      cause: 'Paired',
      causeCode: 'paired',
      nodeId: 'awah-demo',
      createdAt: pairedAt,
    })

    for (let hour = 0; hour < totalHours; hour++) {
      const at = new Date(firstHour.getTime() + hour * hourMs)
      // The session did not exist before it was paired.
      if (at < pairedAt) continue

      const weekday = at.getUTCDay()
      const weekend = weekday === 0 || weekday === 6
      const curve = HOUR_CURVE[at.getUTCHours()] ?? 0.1
      const volume = Math.round(
        session.peakPerHour * curve * (weekend ? 0.35 : 1) * (0.75 + random() * 0.5),
      )

      for (let i = 0; i < volume; i++) {
        const minute = Math.floor(random() * 60)
        const second = Math.floor(random() * 60)
        const occurredAt = new Date(at.getTime() + minute * 60_000 + second * 1_000)
        if (occurredAt > now) continue

        /*
         * Weighted towards the newest numbers rather than uniform: most of the
         * traffic on a support line is about something that just happened, and
         * a uniform draw over a month of contacts spreads the conversation
         * history so thin that no chat ever looks active.
         */
        const reach = contactsByDay(Math.floor(hour / 24))
        const pick = Math.floor(reach - random() ** 2 * reach)
        const contact = CONTACT_POOL[Math.min(pick, CONTACT_POOL.length - 1)] ?? CONTACT_POOL[0]
        const chatId = chatOf(contact as string)

        /*
         * Most outbound messages are answers. Generating them as a reply to an
         * inbound message is what makes response rate and first-response time
         * mean anything — computed over a pile of unrelated sends they are
         * noise dressed as a metric.
         */
        const isReply = random() < 0.72
        if (isReply) {
          const askedAt = new Date(occurredAt.getTime() - Math.floor(30_000 + random() * 240_000))
          counter += 1
          out.messages.push({
            orgId: DEMO_ORG_ID,
            sessionId: session.id,
            chatId,
            engineMessageId: `demo-${session.id.slice(-4)}-${counter}`,
            direction: 'inbound',
            /*
             * Not everything that arrives is text, and the type breakdown on
             * the business screen is a chart with one bar until it is not.
             */
            type: inboundType(random()),
            status: 'delivered',
            fromJid: chatId,
            toJid: chatOf(session.phoneNumber),
            body: INBOUND_TEXTS[Math.floor(random() * INBOUND_TEXTS.length)] ?? 'hi',
            occurredAt: askedAt,
            createdAt: askedAt,
            updatedAt: askedAt,
          })
        }

        counter += 1
        const engineMessageId = `demo-${session.id.slice(-4)}-${counter}`
        const roll = random()
        const failed = roll < session.failureRate
        const delivered = !failed && roll < session.failureRate + session.deliveryRate
        const read = delivered && random() < session.readRate

        out.messages.push({
          orgId: DEMO_ORG_ID,
          sessionId: session.id,
          chatId,
          engineMessageId,
          direction: 'outbound',
          type: 'text',
          status: failed ? 'failed' : read ? 'read' : delivered ? 'delivered' : 'sent',
          fromJid: chatOf(session.phoneNumber),
          toJid: chatId,
          body: OUTBOUND_TEXTS[Math.floor(random() * OUTBOUND_TEXTS.length)] ?? 'ok',
          occurredAt,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        })

        if (delivered) {
          // Log-normal-ish: most arrive around the median, a few drag the p95 out.
          const latency = Math.round(session.medianLatencyMs * (0.5 + random() ** 3 * 6))
          const deliveredAt = new Date(occurredAt.getTime() + latency)
          out.statuses.push({ engineMessageId, status: 'delivered', occurredAt: deliveredAt })
          if (read) {
            out.statuses.push({
              engineMessageId,
              status: 'read',
              occurredAt: new Date(deliveredAt.getTime() + Math.floor(random() * 900_000)),
            })
          }
        } else if (failed) {
          /*
           * The funnel counts events, not the message's current status: a
           * failure with no event on the trail is a message the dashboard shows
           * as sent and never accounts for. It was missing here, and the panel
           * reported zero failures against a number where one send in seven was
           * being refused.
           */
          out.statuses.push({
            engineMessageId,
            status: 'failed',
            occurredAt: new Date(occurredAt.getTime() + 400 + Math.floor(random() * 2_000)),
          })
        }

        /*
         * One risk decision per send, because that is how the engine works: no
         * message reaches an engine without passing the budget and the score.
         * The degraded number spends more of its time held, which is the whole
         * reason its panel looks different from the other two.
         */
        const pressure = session.scenario === 'degraded' ? 0.34 : 0.08
        const decision = random()
        const action =
          decision < pressure * 0.35
            ? 'held'
            : decision < pressure * 0.6
              ? 'throttled'
              : decision < pressure
                ? 'delayed'
                : 'allowed'

        out.risk.push({
          orgId: DEMO_ORG_ID,
          sessionId: session.id,
          action,
          score:
            session.scenario === 'degraded'
              ? 55 + Math.floor(random() * 30)
              : 8 + Math.floor(random() * 22),
          reason:
            action === 'held'
              ? 'hourly budget exhausted'
              : action === 'throttled'
                ? 'score above the throttle threshold'
                : action === 'delayed'
                  ? 'human jitter'
                  : 'within budget',
          delayMs: action === 'allowed' ? Math.floor(random() * 4_000) : Math.floor(random() * 900),
          createdAt: occurredAt,
        })

        /*
         * A webhook delivery for roughly one send in three, not for every one:
         * the point is to make the retry ladder and the dead queue visible in
         * the panel, and a row per message would multiply the seed's size for
         * no extra information.
         */
        if (random() < 0.34) {
          const outcome = random()
          const dead = outcome < (session.scenario === 'degraded' ? 0.06 : 0.01)
          /*
           * Only a fresh delivery is left mid-ladder. A three-week-old row in
           * `retrying` is not just implausible — eight attempts of exponential
           * backoff span hours, not weeks — it is also work: the dispatcher
           * picks up anything retrying whose `available_at` has passed, and the
           * first seed sent a few hundred of them the moment the process came
           * up.
           */
          const fresh = now.getTime() - occurredAt.getTime() < 2 * 3_600_000
          const retrying = !dead && fresh && outcome < 0.08
          out.webhooks.push({
            orgId: DEMO_ORG_ID,
            webhookId: DEMO_WEBHOOK_ID,
            eventType: 'message.status',
            payload: { event: 'message.status', sessionId: session.id, engineMessageId },
            status: dead ? 'dead' : retrying ? 'retrying' : 'delivered',
            attempts: dead ? 8 : retrying ? 3 : 1,
            maxAttempts: 8,
            // Mid-ladder means the next attempt is still ahead, not overdue.
            availableAt: retrying ? new Date(now.getTime() + 240_000) : occurredAt,
            responseStatus: dead ? 502 : retrying ? 503 : 200,
            lastError: dead
              ? 'receiver answered 502 on every attempt'
              : retrying
                ? 'receiver answered 503'
                : null,
            createdAt: occurredAt,
            deliveredAt: dead || retrying ? null : new Date(occurredAt.getTime() + 180),
          })
        }
      }

      /*
       * Drops, so uptime and MTBF have something to report. The degraded number
       * falls over roughly once a day; the healthy ones almost never — which is
       * exactly the contrast the sessions screen exists to show.
       */
      const dropChance = session.scenario === 'degraded' ? 0.045 : 0.004
      if (random() < dropChance) {
        const droppedAt = new Date(at.getTime() + Math.floor(random() * hourMs))
        if (droppedAt <= now) {
          out.sessionEvents.push({
            orgId: DEMO_ORG_ID,
            sessionId: session.id,
            type: 'disconnected',
            rawCode: 428,
            cause: 'Connection closed by the server',
            causeCode: 'connection_closed',
            nodeId: 'awah-demo',
            createdAt: droppedAt,
          })
          out.sessionEvents.push({
            orgId: DEMO_ORG_ID,
            sessionId: session.id,
            type: 'connected',
            cause: 'Connected',
            causeCode: 'connected',
            nodeId: 'awah-demo',
            createdAt: new Date(droppedAt.getTime() + 20_000 + Math.floor(random() * 90_000)),
          })
        }
      }
    }
  }

  return out
}

export interface DemoSeedResult {
  orgId: string
  messages: number
}

/**
 * Builds the demo from nothing, or fills in whatever is missing.
 *
 * Idempotent by construction: every insert either carries a fixed id and
 * conflicts away, or belongs to history that is only written when the
 * organization did not exist yet. Restarting the process must not double the
 * month of traffic — a demo that grows by 8000 messages per deploy stops being
 * a demo.
 */
export async function seedDemo(deps: DemoSeedDeps): Promise<DemoSeedResult> {
  const { db } = deps
  const now = new Date()

  const existing = await db
    .select({ id: schema.orgs.id })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, DEMO_ORG_ID))
    .limit(1)

  await db
    .insert(schema.orgs)
    .values({
      id: DEMO_ORG_ID,
      slug: DEMO_ORG_SLUG,
      name: 'AWAH Demo',
      retentionDays: 30,
    })
    .onConflictDoNothing()

  await db
    .insert(schema.users)
    .values({
      id: DEMO_USER_ID,
      email: deps.email.trim().toLowerCase(),
      name: 'Demo admin',
      passwordHash: await hashPassword(deps.password),
    })
    .onConflictDoNothing()

  await db
    .insert(schema.memberships)
    .values({ orgId: DEMO_ORG_ID, userId: DEMO_USER_ID, role: 'owner' })
    .onConflictDoNothing()

  await db
    .insert(schema.apiKeys)
    .values({
      id: DEMO_API_KEY_ID,
      orgId: DEMO_ORG_ID,
      name: 'Published demo key',
      prefix: DEMO_KEY_PREFIX,
      secretHash: hashToken(DEMO_KEY_SECRET),
      role: 'admin',
      createdByUserId: DEMO_USER_ID,
    })
    .onConflictDoNothing()

  const sinkUrl = `${deps.publicUrl ?? 'http://localhost:2900'}${DEMO_WEBHOOK_PATH}`

  await db
    .insert(schema.webhooks)
    .values({
      id: DEMO_WEBHOOK_ID,
      orgId: DEMO_ORG_ID,
      url: sinkUrl,
      secret: 'demo-webhook-secret',
      events: ['message.received', 'message.status', 'session.status'],
      active: true,
    })
    .onConflictDoUpdate({ target: schema.webhooks.id, set: { url: sinkUrl } })

  for (const session of DEMO_SESSIONS) {
    await db
      .insert(schema.sessions)
      .values({
        id: session.id,
        orgId: DEMO_ORG_ID,
        name: session.name,
        engine: 'simulator',
        status: 'created',
        desiredState: 'running',
        phoneNumber: session.phoneNumber,
        /*
         * `paired_at` is written here and never again: the manager only sets it
         * when it is null. That is what keeps the warm-up curve where the
         * scenario says it should be — a number restarted at every deploy would
         * otherwise be reborn at day zero, with its ceiling back at 5%.
         */
        pairedAt: new Date(now.getTime() - session.ageDays * 86_400_000),
        config: {
          simulator: {
            scenario: session.scenario,
            phoneNumber: session.phoneNumber,
            ageDays: session.ageDays,
          },
        },
      })
      .onConflictDoNothing()
  }

  // The month of history belongs to a demo being created, not to a restart.
  if (existing.length > 0) {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.messages)
      .where(eq(schema.messages.orgId, DEMO_ORG_ID))
    return { orgId: DEMO_ORG_ID, messages: Number(row?.total ?? 0) }
  }

  const history = generateHistory(now)

  await insertInBatches(history.messages, 500, (chunk) =>
    db.insert(schema.messages).values(chunk).onConflictDoNothing(),
  )
  await insertInBatches(history.sessionEvents, 500, (chunk) =>
    db.insert(schema.sessionEvents).values(chunk),
  )
  await insertInBatches(history.risk, 500, (chunk) => db.insert(schema.riskEvents).values(chunk))
  await insertInBatches(history.webhooks, 500, (chunk) =>
    db.insert(schema.webhookDeliveries).values(chunk),
  )

  /*
   * The ACK trail is written from the message ids the database just assigned,
   * in one statement per batch. Looking each message up by `engine_message_id`
   * in JavaScript would be thousands of round trips for a join Postgres already
   * knows how to do.
   */
  await insertInBatches(history.statuses, 500, async (chunk) => {
    const ids = sql.join(
      chunk.map((s) => sql`(${s.engineMessageId}, ${s.status}, ${s.occurredAt.toISOString()})`),
      sql`, `,
    )
    return db.execute(sql`
      INSERT INTO message_status_events (org_id, message_id, status, occurred_at)
      SELECT m.org_id, m.id, t.status::message_status, t.occurred_at::timestamptz
      FROM (VALUES ${ids}) AS t(engine_message_id, status, occurred_at)
      JOIN messages m
        ON m.engine_message_id = t.engine_message_id AND m.org_id = ${DEMO_ORG_ID}::uuid
      ON CONFLICT (message_id, status) DO NOTHING
    `)
  })

  await seedQueue(db, now)

  /*
   * The panel reads `metrics_hourly` and nothing else, so history that is not
   * aggregated is history nobody sees. The window covers everything that was
   * just written — the running aggregator only looks back a few hours, by
   * design, and would never reach the older buckets.
   */
  await new MetricsAggregator({
    db,
    logger: deps.logger,
    intervalMs: 0,
    lookbackHours: HISTORY_DAYS * 24,
  }).aggregate()

  deps.logger.info(
    { messages: history.messages.length, days: HISTORY_DAYS },
    'demo history generated',
  )

  return { orgId: DEMO_ORG_ID, messages: history.messages.length }
}

/**
 * Current queue state: a few messages held by the risk engine and a few in the
 * dead-letter queue.
 *
 * These are not history — they are rows the operations screen reads live. They
 * exist because "nothing was lost, it is waiting and here is why" is the claim
 * this project makes, and a queue that is always empty is the one place the
 * claim cannot be checked.
 */
async function seedQueue(db: Database, now: Date): Promise<void> {
  const rows: (typeof schema.outboxMessages.$inferInsert)[] = []

  for (let i = 0; i < 6; i++) {
    rows.push({
      orgId: DEMO_ORG_ID,
      sessionId: DEMO_SESSION_IDS.billing,
      clientMessageId: `demo-dead-${i}`,
      chatId: chatOf(CONTACT_POOL[i] as string),
      type: 'text',
      payload: { text: 'Your invoice for this month is ready.' },
      status: 'dead',
      attempts: 5,
      maxAttempts: 5,
      lastError: 'engine refused the send: number not on WhatsApp',
      availableAt: new Date(now.getTime() - 3_600_000),
      createdAt: new Date(now.getTime() - 5_400_000),
      updatedAt: new Date(now.getTime() - 3_600_000),
    })
  }

  for (let i = 0; i < 4; i++) {
    rows.push({
      orgId: DEMO_ORG_ID,
      sessionId: DEMO_SESSION_IDS.sales,
      clientMessageId: `demo-held-${i}`,
      chatId: chatOf(CONTACT_POOL[20 + i] as string),
      type: 'text',
      payload: { text: 'Following up on your quote.' },
      status: 'held',
      heldReason: 'daily budget for a 3-day-old number is spent; resumes at midnight',
      availableAt: new Date(now.getTime() + 3_600_000),
      createdAt: new Date(now.getTime() - 600_000),
      updatedAt: new Date(now.getTime() - 600_000),
    })
  }

  await db.insert(schema.outboxMessages).values(rows).onConflictDoNothing()
}

/**
 * Puts the demo back to the state the README describes.
 *
 * Deleting the organization is enough for everything the visitor could have
 * touched — sessions, keys, webhooks, messages and integrations all cascade
 * from it. The user row is separate and has to go explicitly, and with it every
 * browser cookie pointing at it, which is the intended effect: after a reset
 * everyone signs back in with the published credentials.
 */
export async function resetDemo(deps: DemoSeedDeps): Promise<DemoSeedResult> {
  await deps.db.delete(schema.orgs).where(eq(schema.orgs.id, DEMO_ORG_ID))
  await deps.db.delete(schema.users).where(eq(schema.users.id, DEMO_USER_ID))
  return seedDemo(deps)
}
