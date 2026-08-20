import { type Database, sql } from '@awah/db'
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client'

/**
 * Registro de métricas em formato Prometheus.
 *
 * Separado dos agregados horários de propósito: aqui vive o que interessa a
 * quem opera a infraestrutura agora — fila crescendo, sessão caindo, latência
 * subindo. Os agregados respondem "como foi ontem"; isto responde "o que está
 * acontecendo neste segundo".
 */
export class AwahMetrics {
  readonly registry = new Registry()

  /** Contadores incrementados no caminho quente. */
  readonly messagesSent: Counter<'session'>
  readonly messagesReceived: Counter<'session'>
  readonly messagesFailed: Counter<'session'>
  readonly riskDecisions: Counter<'action'>
  readonly webhookDeliveries: Counter<'outcome'>
  readonly sessionDisconnects: Counter<'cause'>

  readonly sendDuration: Histogram<'result'>
  readonly webhookDuration: Histogram<'outcome'>

  /** Estado do momento, preenchido a cada coleta. */
  private readonly sessionsByStatus: Gauge<'status'>
  private readonly sessionsOwned: Gauge<string>
  private readonly outboxDepth: Gauge<'status'>
  private readonly webhookDepth: Gauge<'status'>

  constructor(nodeId: string) {
    // Toda série carrega o nó, para distinguir réplicas no mesmo scrape.
    this.registry.setDefaultLabels({ node: nodeId })

    // Heap, GC e atraso do event loop — o que denuncia um nó doente.
    collectDefaultMetrics({ register: this.registry, prefix: 'awah_' })

    this.messagesSent = new Counter({
      name: 'awah_messages_sent_total',
      help: 'Messages successfully handed to the engine.',
      labelNames: ['session'],
      registers: [this.registry],
    })

    this.messagesReceived = new Counter({
      name: 'awah_messages_received_total',
      help: 'Messages received from third parties.',
      labelNames: ['session'],
      registers: [this.registry],
    })

    this.messagesFailed = new Counter({
      name: 'awah_messages_failed_total',
      help: 'Sends that exhausted their attempts and went to the dead-letter queue.',
      labelNames: ['session'],
      registers: [this.registry],
    })

    this.riskDecisions = new Counter({
      name: 'awah_risk_decisions_total',
      help: 'Risk engine decisions by action type.',
      labelNames: ['action'],
      registers: [this.registry],
    })

    this.webhookDeliveries = new Counter({
      name: 'awah_webhook_deliveries_total',
      help: 'Webhook delivery attempts by outcome.',
      labelNames: ['outcome'],
      registers: [this.registry],
    })

    this.sessionDisconnects = new Counter({
      name: 'awah_session_disconnects_total',
      help: 'Session drops by translated cause.',
      labelNames: ['cause'],
      registers: [this.registry],
    })

    this.sendDuration = new Histogram({
      name: 'awah_send_duration_seconds',
      help: 'Time between claiming the send and the engine confirming it.',
      labelNames: ['result'],
      // Faixas escolhidas para o caminho real: o jitter humano coloca a maioria
      // dos envios entre 1 s e 30 s, e a cauda importa mais que a média.
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
      registers: [this.registry],
    })

    this.webhookDuration = new Histogram({
      name: 'awah_webhook_duration_seconds',
      help: 'Response time of the endpoint that receives the webhook.',
      labelNames: ['outcome'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      registers: [this.registry],
    })

    this.sessionsByStatus = new Gauge({
      name: 'awah_sessions',
      help: 'Sessions by state, across the whole cluster.',
      labelNames: ['status'],
      registers: [this.registry],
    })

    this.sessionsOwned = new Gauge({
      name: 'awah_sessions_owned',
      help: 'Sessions this node currently owns.',
      registers: [this.registry],
    })

    this.outboxDepth = new Gauge({
      name: 'awah_outbox_depth',
      help: 'Queued sends by state.',
      labelNames: ['status'],
      registers: [this.registry],
    })

    this.webhookDepth = new Gauge({
      name: 'awah_webhook_depth',
      help: 'Pending webhook deliveries by state.',
      labelNames: ['status'],
      registers: [this.registry],
    })
  }

  /**
   * Atualiza os gauges de estado.
   *
   * Roda no momento do scrape, e não em laço próprio: manter isso atualizado
   * continuamente custaria consultas que ninguém leria entre um scrape e outro.
   */
  async collect(db: Database, ownedSessions: number): Promise<void> {
    this.sessionsOwned.set(ownedSessions)

    const sessoes = await db.execute(sql`
      SELECT status, count(*)::int AS total FROM sessions GROUP BY status
    `)
    this.sessionsByStatus.reset()
    for (const row of sessoes) {
      const r = row as Record<string, unknown>
      this.sessionsByStatus.set({ status: String(r.status) }, Number(r.total))
    }

    const fila = await db.execute(sql`
      SELECT status, count(*)::int AS total FROM outbox_messages
      WHERE status IN ('queued', 'sending', 'dead') GROUP BY status
    `)
    this.outboxDepth.reset()
    for (const row of fila) {
      const r = row as Record<string, unknown>
      this.outboxDepth.set({ status: String(r.status) }, Number(r.total))
    }

    const webhooks = await db.execute(sql`
      SELECT status, count(*)::int AS total FROM webhook_deliveries
      WHERE status IN ('pending', 'retrying', 'dead') GROUP BY status
    `)
    this.webhookDepth.reset()
    for (const row of webhooks) {
      const r = row as Record<string, unknown>
      this.webhookDepth.set({ status: String(r.status) }, Number(r.total))
    }
  }

  render(): Promise<string> {
    return this.registry.metrics()
  }

  get contentType(): string {
    return this.registry.contentType
  }
}
