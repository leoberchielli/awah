import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { MetricsAggregator } from './aggregator'
import { AwahMetrics } from './metrics'

declare module 'fastify' {
  interface FastifyInstance {
    metrics: AwahMetrics
    aggregator: MetricsAggregator
  }
}

export const telemetryPlugin = fp(
  async (app: FastifyInstance) => {
    const metrics = new AwahMetrics(app.env.NODE_ID)
    app.decorate('metrics', metrics)

    const aggregator = new MetricsAggregator({
      db: app.db,
      logger: app.log,
      intervalMs: app.env.AGGREGATOR_INTERVAL_MS,
      lookbackHours: app.env.AGGREGATOR_LOOKBACK_HOURS,
    })
    app.decorate('aggregator', aggregator)

    /**
     * Every replica aggregates the same window and reaches the same result —
     * the upsert makes the concurrency harmless. Electing one aggregator would
     * require coordination and create a point of failure for a task that needs
     * neither of them.
     */
    aggregator.start()

    app.addHook('onClose', async () => {
      aggregator.stop()
    })
  },
  { name: 'awah-telemetry', dependencies: ['awah-sessions'] },
)
