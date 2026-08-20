import { buildApp } from './app'
import type { Env } from './env'
import { loadEnv } from './env'

interface WarnLogger {
  warn(obj: object, msg: string): void
}

/**
 * Settings that only hurt once the instance becomes reachable.
 *
 * These are warnings, not errors: on a closed network each one is a reasonable
 * choice, and killing the process over them would get in the way of someone who
 * only wants to run this on a laptop. What must not happen is finding out after
 * being exposed.
 */
function warnAboutExposure(log: WarnLogger, env: Env): void {
  if (!env.METRICS_TOKEN) {
    log.warn(
      { route: '/metrics' },
      'METRICS_TOKEN not set: anyone who reaches the port reads message volume, session count and operational health',
    )
  }

  if (env.TRUST_PROXY === true) {
    log.warn(
      { TRUST_PROXY: true },
      'unrestricted trust in X-Forwarded-For: with no proxy in front, any client picks its own IP and escapes the rate limit',
    )
  }

  if (env.NODE_ENV !== 'production' && env.HOST === '0.0.0.0') {
    log.warn(
      { NODE_ENV: env.NODE_ENV },
      'outside production the session cookie goes without the secure flag; do not expose this instance to the internet like this',
    )
  }
}

async function main() {
  const env = loadEnv()
  const app = await buildApp(env)

  /**
   * Orderly shutdown: stop accepting new connections, drain what is in flight
   * and only then close Postgres and Redis. From wave 4 on, this is also where
   * sessions release their lease, so another replica takes over right away
   * instead of waiting for the TTL to expire.
   */
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true

    app.log.info({ signal }, 'shutting down')
    try {
      await app.close()
      process.exit(0)
    } catch (error) {
      app.log.error({ err: error }, 'shutdown failed')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection')
  })

  warnAboutExposure(app.log, env)

  try {
    await app.listen({ port: env.PORT, host: env.HOST })
    const base = env.PUBLIC_URL ?? `http://localhost:${env.PORT}`
    app.log.info(
      {
        version: process.env.AWAH_VERSION ?? 'dev',
        nodeId: env.NODE_ID,
        dashboard: base,
        docs: `${base}/docs`,
      },
      'AWAH is up',
    )
  } catch (error) {
    app.log.error({ err: error }, 'failed to start the server')
    process.exit(1)
  }
}

void main()
