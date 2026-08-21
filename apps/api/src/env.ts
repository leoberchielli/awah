import { hostname } from 'node:os'
import { z } from 'zod'

/** Accepts the usual spellings of a boolean in an environment variable. */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
  )

/**
 * Marks a field optional, treating an empty string as absent.
 *
 * `.optional()` on its own only accepts `undefined`, and no orchestrator speaks
 * that language: Docker Compose, Kubernetes and GitHub Actions all turn an
 * unset variable into an empty string. This repository's `docker-compose.yml`
 * declares `PUBLIC_URL: ${PUBLIC_URL:-}` precisely to document the variable —
 * and with a plain `.optional()` that killed the process at boot with "Invalid
 * url" for anyone who had just downloaded the compose file and run
 * `docker compose up -d`.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema.optional())

const base64Key = (bytes: number) =>
  z.string().refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === bytes
    } catch {
      return false
    }
  }, `must be ${bytes} bytes encoded in base64 (openssl rand -base64 ${bytes})`)

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(2900),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * This replica's identity in the cluster. It is the value written to
   * `sessions.owner_node_id` when this replica takes the lease on a session
   * (§4.4).
   */
  NODE_ID: optional(z.string().min(1)),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().min(1),

  ENCRYPTION_KEY: base64Key(32),
  COOKIE_SECRET: z.string().min(32, 'use at least 32 characters'),

  /**
   * The instance's public address, with scheme. Used to build the URL Meta has
   * to register, and to point the docs' "Try it" at the right place. Empty, the
   * API assumes `http://localhost:PORT` — right on a laptop, wrong behind any
   * proxy.
   */
  PUBLIC_URL: optional(z.string().url()).transform((value) => value?.replace(/\/+$/, '')),

  /**
   * Whether the `X-Forwarded-*` headers can be trusted.
   *
   * Trusting them with no proxy in front is a hole: the per-IP rate limit uses
   * `request.ip`, and with this on any client picks its own IP through the
   * header and escapes the limit by changing the value on every request.
   * Accepts `false` (the default), `true`, a hop count, or a list of CIDRs —
   * which is the only genuinely safe option behind a proxy.
   */
  TRUST_PROXY: z
    .union([z.boolean(), z.string()])
    .default(false)
    .transform((value): boolean | number | string => {
      if (typeof value === 'boolean') return value
      const text = value.trim()
      if (['1', 'true', 'yes', 'on'].includes(text.toLowerCase())) return true
      if (['', '0', 'false', 'no', 'off'].includes(text.toLowerCase())) return false
      const hops = Number(text)
      return Number.isInteger(hops) && hops > 0 ? hops : text
    }),

  /**
   * Ceiling on the request body. Fastify's default is 1 MiB and it does the
   * job: a text send comes nowhere near it, and a high ceiling invites memory
   * exhaustion.
   */
  BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(1_048_576),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  ALLOW_OPEN_REGISTRATION: boolish.default(false),

  /**
   * The WhatsApp engine's log, kept apart from the API's. Baileys is extremely
   * verbose at debug level — staying silent by default keeps it from drowning
   * the application log, and raising it to 'debug' is the first thing to do
   * when a session refuses to pair.
   */
  ENGINE_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('silent'),

  /** Reconnect attempts before the manager gives up on a session. */
  MAX_RECONNECT_ATTEMPTS: z.coerce.number().int().positive().max(100).default(10),

  // ---- send scheduler ----
  OUTBOX_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(250),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(25),
  /** A send stuck in 'sending' longer than this came from a dead process. */
  OUTBOX_STUCK_AFTER_MS: z.coerce.number().int().positive().default(120_000),
  /** Delivery attempts before the message goes to the DLQ. */
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().max(50).default(5),

  // ---- webhooks ----
  WEBHOOK_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  WEBHOOK_BATCH_SIZE: z.coerce.number().int().positive().max(200).default(20),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(10_000),
  /**
   * How deep the retry ladder goes before a delivery is declared dead.
   *
   * Eight attempts with exponential backoff spans hours, which is right for a
   * receiver that is down for the afternoon and wrong for anyone trying to
   * observe the dead queue — including this project's own verification script,
   * which could not reach that path at all while the depth was fixed in the
   * table default.
   */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(8),

  /** Concurrent sends per node. Human jitter holds each one for seconds. */
  OUTBOX_MAX_CONCURRENT: z.coerce.number().int().positive().max(1000).default(50),

  /** How often to purge content the retention policy has expired. */
  RETENTION_SWEEP_MS: z.coerce.number().int().positive().default(600_000),

  // ---- cluster ----
  /** How long ownership of a session lives. Expired, another node may take it. */
  LEASE_TTL_MS: z.coerce.number().int().min(3000).max(120_000).default(15_000),
  /** Ownership renewal. Has to be well under the TTL. */
  LEASE_RENEW_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),
  /** How often to sweep for orphaned sessions and take them over. */
  FAILOVER_SCAN_MS: z.coerce.number().int().min(1000).max(300_000).default(10_000),
  FAILOVER_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(5),
  /** How long to wait for the answer to a command routed to another node. */
  COMMAND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

  // ---- telemetry ----
  /**
   * Protects the /metrics endpoint. Without it, anyone who reaches the port
   * reads message volume, session count and operational health.
   */
  METRICS_TOKEN: optional(z.string().min(16)),
  /** How often the hourly aggregates get materialized. */
  AGGREGATOR_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),
  /** Hours recomputed on each pass, to absorb late ACKs and retries. */
  AGGREGATOR_LOOKBACK_HOURS: z.coerce.number().int().min(1).max(168).default(6),

  // ---- risk engine ----
  /**
   * Turns the engine off completely. Only use this with a throwaway number:
   * without it the gateway fires at the queue's top speed, which is exactly
   * the behavior that gets a number banned.
   */
  RISK_ENGINE_ENABLED: boolish.default(true),

  // ---- simulator ----
  /**
   * Allows sessions on the `simulator` engine, which is not a WhatsApp client.
   *
   * It exists so the delivery funnel, the risk engine under load and failover
   * with a connected session can be exercised without a paired phone. The flag
   * refuses to boot under `NODE_ENV=production`, and that refusal is the whole
   * point: a fake engine left on in production accepts every send, reports
   * every one delivered, and puts nothing on anybody's phone. That failure is
   * silent, looks healthy on the dashboard, and is only discovered by the
   * customer who never got an answer.
   */
  SIMULATOR_ENABLED: boolish.default(false),

  // ---- demo ----
  /**
   * Turns the instance into a public demo.
   *
   * It is the only thing that lifts the production ban on `SIMULATOR_ENABLED`,
   * and it earns that by removing the reason for the ban. What makes a fake
   * engine dangerous in production is silence: sends are accepted, everything
   * reports delivered, and nothing reaches a phone. In demo mode the instance
   * says what it is on the login screen, on `/v1/auth/bootstrap`, on
   * `/v1/auth/me` and in a banner across the top of every panel — and it
   * refuses to open a session on any engine other than the simulator, so no
   * real number is ever paired against a published key.
   *
   * Everything else stays real: the same queue, the same risk engine, the same
   * ACK reconciliation, the same webhooks.
   */
  DEMO_MODE: boolish.default(false),

  /**
   * The demo's fixed credentials, published on the login screen.
   *
   * They cannot be changed from inside the instance — that is the point of a
   * demo everyone shares — and the guard in `demo/guard.ts` refuses any request
   * that would remove the account, demote it or take the organization away.
   */
  DEMO_EMAIL: z.string().email().default('admin@awah.demo'),
  DEMO_PASSWORD: z.string().min(1).default('admin'),

  /**
   * How often the demo goes back to its baseline. Zero switches the reset off.
   *
   * A public instance where anyone signs in as owner accumulates whatever
   * visitors leave behind — deleted sessions, revoked keys, an organization
   * renamed to something unrepeatable. The reset is what lets the next visitor
   * find the same demo the README describes.
   */
  DEMO_RESET_MINUTES: z.coerce.number().int().min(0).max(10_080).default(180),

  // ---- dashboard ----
  /**
   * Where the panel's files live. Empty, the API looks in `public`,
   * `../web/dist` and `apps/web/dist`, in that order, and starts without a
   * panel if it finds none — the API is useful on its own.
   */
  DASHBOARD_DIR: optional(z.string().min(1)),
})

export type Env = z.infer<typeof envSchema> & { NODE_ID: string }

/**
 * Secrets this repository ships for development.
 *
 * They sit in the docker-compose file and in .env.example, which means anyone
 * who reads the project can forge a session cookie and decrypt the auth state
 * of whoever started up with them. In production the process refuses to be
 * born.
 */
/*
 * These exact strings also live in `docker-compose.yml`, `.github/workflows/ci.yml`
 * and `test/hardening.test.ts`. Nothing type-checks that coupling: change one
 * side alone and the guard quietly stops covering the secret it was written for.
 */
const DEV_SECRETS = new Set([
  'YXdhaC1kZXYta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=',
  'awah-dev-cookie-secret-change-before-production',
  'YXdhaC1jaS1rZXktbm90LWZvci1wcm9kdWN0aW9uISE=',
  'awah-ci-cookie-secret-do-not-use-in-production',
])

/**
 * Validates the environment once, at boot. Invalid configuration kills the
 * process now instead of turning into an obscure error in the middle of a send.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }

  const env = {
    ...parsed.data,
    NODE_ID: parsed.data.NODE_ID ?? hostname(),
  }

  /*
   * A demo with no engine is a login screen over an empty database. Enabling
   * the simulator on its own is legitimate — that is what the load script uses
   * — but the other direction is always a mistake, and it is cheaper to say so
   * at boot than to let someone find out from a session that never connects.
   */
  if (env.DEMO_MODE && !env.SIMULATOR_ENABLED) {
    throw new Error(
      [
        'DEMO_MODE is on and SIMULATOR_ENABLED is off.',
        'The demo has no phone to pair: its sessions run on the simulator, and',
        'without it nothing in the panel would ever connect. Set',
        'SIMULATOR_ENABLED=true.',
      ].join('\n'),
    )
  }

  if (env.NODE_ENV === 'production') {
    const weak = (
      [
        ['ENCRYPTION_KEY', env.ENCRYPTION_KEY],
        ['COOKIE_SECRET', env.COOKIE_SECRET],
      ] as const
    )
      .filter(([, value]) => DEV_SECRETS.has(value))
      .map(([name]) => name)

    /*
     * DEMO_MODE is the one way past this, and it is not a bypass: it turns the
     * silence into an announcement. The instance declares itself a demo on the
     * login screen, in the API and in a banner over every panel, and refuses
     * every engine but the simulator. What the ban protects against — a fake
     * engine nobody knows is fake — cannot happen there.
     */
    if (env.SIMULATOR_ENABLED && !env.DEMO_MODE) {
      throw new Error(
        [
          'SIMULATOR_ENABLED is on and NODE_ENV is production.',
          'The simulator is not a WhatsApp client: it accepts every send and',
          'reports it delivered without anything reaching a phone. Nothing in',
          'the dashboard would look wrong.',
          'A public demo is the exception, and it has to say so: DEMO_MODE=true.',
        ].join('\n'),
      )
    }

    if (weak.length > 0) {
      throw new Error(
        [
          `These are the development secrets, published in this repository: ${weak.join(', ')}.`,
          'Generate your own before exposing the instance:',
          '  ENCRYPTION_KEY: openssl rand -base64 32',
          '  COOKIE_SECRET:  openssl rand -base64 48',
        ].join('\n'),
      )
    }
  }

  return env
}
