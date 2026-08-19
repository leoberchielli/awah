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
     * Todas as réplicas agregam a mesma janela e chegam ao mesmo resultado — o
     * upsert torna a concorrência inofensiva. Eleger um agregador exigiria
     * coordenação e criaria um ponto de falha para uma tarefa que não precisa
     * de nenhum dos dois.
     */
    aggregator.start()

    app.addHook('onClose', async () => {
      aggregator.stop()
    })
  },
  { name: 'awah-telemetry', dependencies: ['awah-sessions'] },
)
