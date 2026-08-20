import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import type Redis from 'ioredis'
import { CommandBus } from '../cluster/commands'
import { FailoverScanner } from '../cluster/failover'
import { SessionLease } from '../cluster/lease'
import { QrCache } from '../cluster/qr-cache'
import { SessionManager } from './manager'

declare module 'fastify' {
  interface FastifyInstance {
    sessions: SessionManager
  }
}

export const sessionsPlugin = fp(
  async (app: FastifyInstance) => {
    const lease = new SessionLease(app.redis, app.env.NODE_ID, { ttlMs: app.env.LEASE_TTL_MS })
    const qrCache = new QrCache(app.redis)

    /**
     * A dedicated connection for pub/sub: in subscribe mode ioredis refuses
     * normal commands, so reusing the main connection would break everything
     * else.
     */
    const subscriber = app.redis.duplicate() as Redis
    subscriber.on('error', (error) => {
      app.log.error({ err: error }, 'error on the Redis subscriber connection')
    })

    const commands = new CommandBus({
      publisher: app.redis,
      subscriber,
      nodeId: app.env.NODE_ID,
      logger: app.log,
      timeoutMs: app.env.COMMAND_TIMEOUT_MS,
    })

    const manager = new SessionManager({
      db: app.db,
      logger: app.log,
      nodeId: app.env.NODE_ID,
      encryptionKey: Buffer.from(app.env.ENCRYPTION_KEY, 'base64'),
      engineLogLevel: app.env.ENGINE_LOG_LEVEL,
      maxReconnectAttempts: app.env.MAX_RECONNECT_ATTEMPTS,
      lease,
      qrCache,
      commands,
      leaseRenewMs: app.env.LEASE_RENEW_MS,
    })

    app.decorate('sessions', manager)

    const failover = new FailoverScanner({
      db: app.db,
      lease,
      sessions: manager,
      logger: app.log,
      intervalMs: app.env.FAILOVER_SCAN_MS,
      batchSize: app.env.FAILOVER_BATCH_SIZE,
    })
    failover.start()

    /**
     * Release the sessions before the process dies.
     *
     * Without this, WhatsApp holds on to the old socket for a while and the
     * next reconnect tends to collide with it — the 440 "session taken over
     * elsewhere" that confuses so many people. Releasing the lease explicitly
     * also shortens failover: another replica takes over right away instead of
     * waiting for the TTL to expire.
     */
    app.addHook('onClose', async () => {
      failover.stop()
      await manager.shutdown()
      await commands.close()
      await subscriber.quit().catch(() => {})
    })
  },
  { name: 'awah-sessions', dependencies: ['awah-auth'] },
)
