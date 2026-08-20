import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * RBAC roles, in increasing order of power. The numeric hierarchy lives in
 * `apps/api/src/auth/rbac.ts` — this enum only defines the values the database accepts.
 */
export const memberRole = pgEnum('member_role', ['viewer', 'operator', 'admin', 'owner'])

/** EngineAdapter implementations (spec §5). */
export const engineType = pgEnum('engine_type', [
  'baileys',
  'cloud_api',
  'wwebjs',
  'whatsmeow',
  /**
   * Not a WhatsApp client: a stand-in that behaves like one.
   *
   * It exists because the delivery funnel, the risk engine under load and
   * failover with a connected session cannot be exercised without a paired
   * phone, and those are exactly the paths that matter when they break. It sits
   * behind the same `EngineAdapter` contract, so everything upstream of the
   * adapter runs for real.
   *
   * Refused unless `SIMULATOR_ENABLED` is on, and that flag refuses to boot
   * under `NODE_ENV=production` — a fake engine in production sends messages
   * nowhere while the dashboard reports them delivered.
   */
  'simulator',
])

/**
 * External tools the gateway feeds.
 *
 * `chatwoot` is human support and talks both ways; `typebot` is an automated
 * flow and answers whatever arrives. They are not mutually exclusive: the most
 * common arrangement is the flow taking the first shot and handing over to a
 * human when it runs out of answers.
 *
 * `http` is the escape hatch: it talks to anything that accepts a POST and
 * returns JSON. It exists so that plugging in a new platform does not depend on
 * someone writing a dedicated connector in here — n8n, Make, a serverless
 * function or the in-house system all come in through it with no code change.
 */
export const integrationKind = pgEnum('integration_kind', ['chatwoot', 'typebot', 'http'])

export const sessionStatus = pgEnum('session_status', [
  'created',
  'pairing',
  'connecting',
  'connected',
  'disconnected',
  'logged_out',
  'banned',
])

/**
 * Operator intent, kept separate from observed state.
 *
 * `status` says where the session is; `desired_state` says where it should be.
 * That distinction is what makes failover possible without guessing: when a
 * node dies, the session is left with status 'connected' and no owner — and
 * taking it over is only legitimate because someone asked for 'running'. A
 * session the operator stopped reads 'stopped' and must not be resurrected by
 * anyone.
 */
export const desiredState = pgEnum('desired_state', ['running', 'stopped'])

export const sessionEventType = pgEnum('session_event_type', [
  'connecting',
  'connected',
  'disconnected',
  'pairing_requested',
  'paired',
  'logged_out',
  'lease_acquired',
  'lease_lost',
  'error',
])

/**
 * Outbox states (§4.2). `held` is the state the risk engine uses to hold a
 * message without dropping it; `dead` is the DLQ.
 */
export const outboxStatus = pgEnum('outbox_status', [
  'queued',
  'held',
  'sending',
  'sent',
  'failed',
  'dead',
])

export const messageDirection = pgEnum('message_direction', ['inbound', 'outbound'])

/**
 * `stale` exists because an ACK that never arrives is not the same thing as a
 * confirmed delivery — the reconciler marks stale instead of lying "delivered".
 */
export const messageStatus = pgEnum('message_status', [
  'pending',
  'sent',
  'delivered',
  'read',
  'played',
  'failed',
  'stale',
])

export const messageType = pgEnum('message_type', [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contact',
  'reaction',
  'poll',
  'system',
])

export const webhookDeliveryStatus = pgEnum('webhook_delivery_status', [
  'pending',
  'delivering',
  'delivered',
  'retrying',
  'dead',
])

/** Risk engine decisions (§4.1). `blocked` only happens on a banned session. */
export const riskAction = pgEnum('risk_action', [
  'allowed',
  'delayed',
  'held',
  'throttled',
  'blocked',
])
