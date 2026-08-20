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
const opcional = <T extends z.ZodTypeAny>(schema: T) =>
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
  NODE_ID: opcional(z.string().min(1)),

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
  PUBLIC_URL: opcional(z.string().url()).transform((value) => value?.replace(/\/+$/, '')),

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
      const saltos = Number(text)
      return Number.isInteger(saltos) && saltos > 0 ? saltos : text
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
  METRICS_TOKEN: opcional(z.string().min(16)),
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

  // ---- dashboard ----
  /**
   * Where the panel's files live. Empty, the API looks in `public`,
   * `../web/dist` and `apps/web/dist`, in that order, and starts without a
   * panel if it finds none — the API is useful on its own.
   */
  DASHBOARD_DIR: opcional(z.string().min(1)),
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
const SEGREDOS_DE_DESENVOLVIMENTO = new Set([
  'YXdhaC1kZXYta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=',
  'awah-dev-cookie-secret-trocar-antes-de-ir-a-producao',
  'YXdhaC1jaS1rZXktbm90LWZvci1wcm9kdWN0aW9uISE=',
  'awah-ci-cookie-secret-nao-usar-em-producao',
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

  if (env.NODE_ENV === 'production') {
    const fracos = (
      [
        ['ENCRYPTION_KEY', env.ENCRYPTION_KEY],
        ['COOKIE_SECRET', env.COOKIE_SECRET],
      ] as const
    )
      .filter(([, value]) => SEGREDOS_DE_DESENVOLVIMENTO.has(value))
      .map(([name]) => name)

    if (fracos.length > 0) {
      throw new Error(
        [
          `These are the development secrets, published in this repository: ${fracos.join(', ')}.`,
          'Generate your own before exposing the instance:',
          '  ENCRYPTION_KEY: openssl rand -base64 32',
          '  COOKIE_SECRET:  openssl rand -base64 48',
        ].join('\n'),
      )
    }
  }

  return env
}
