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
     * Conexão dedicada para pub/sub: em modo subscribe o ioredis recusa comandos
     * normais, então reaproveitar a conexão principal quebraria todo o resto.
     */
    const subscriber = app.redis.duplicate() as Redis
    subscriber.on('error', (error) => {
      app.log.error({ err: error }, 'erro na conexão de assinatura do Redis')
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
     * Solta as sessões antes de o processo morrer.
     *
     * Sem isto, o WhatsApp mantém o socket antigo por algum tempo e a reconexão
     * seguinte tende a colidir com ele — o 440 "sessão assumida em outro lugar"
     * que confunde tanta gente. Soltar o lease explicitamente também encurta o
     * failover: outra réplica assume na hora, em vez de esperar o TTL vencer.
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
