import { type Database, sql } from '@awah/db'
import type { ManagerLogger } from '../sessions/manager'

export interface AggregatorDeps {
  db: Database
  logger: ManagerLogger
  intervalMs: number
  /**
   * Quantas horas recalcular a cada passada.
   *
   * Não basta agregar a hora corrente: um ACK de leitura chega horas depois do
   * envio, e um webhook em retry pode concluir bem além da hora em que nasceu.
   * Recalcular uma janela move esses números para o balde certo em vez de
   * perdê-los.
   */
  lookbackHours: number
}

/**
 * Materialização dos agregados horários.
 *
 * O dashboard lê exclusivamente de `metrics_hourly`. Varrer as tabelas cruas a
 * cada carregamento de painel é o erro que transforma observabilidade em
 * incidente de banco: a tabela de mensagens cresce sem teto e um `count(*)` por
 * hora sobre trinta dias derruba o Postgres justamente quando alguém está
 * tentando entender por que a operação caiu.
 *
 * Cada consulta é um upsert idempotente — reprocessar a mesma janela produz o
 * mesmo resultado, então uma passada perdida se corrige sozinha na seguinte.
 */
export class MetricsAggregator {
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private running = false

  constructor(private readonly deps: AggregatorDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    // Primeira passada logo no boot, para o painel não nascer vazio.
    void this.aggregate().finally(() => this.scheduleNext())
  }

  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.aggregate().finally(() => this.scheduleNext())
    }, this.deps.intervalMs)
    this.timer.unref()
  }

  /**
   * Roda uma passada completa.
   *
   * Várias réplicas agregam a mesma janela ao mesmo tempo e chegam ao mesmo
   * resultado — o upsert torna a concorrência inofensiva, o que dispensa
   * coordenação entre nós para uma tarefa que não precisa dela.
   */
  async aggregate(): Promise<void> {
    /**
     * O guarda é só contra reentrância — uma passada lenta não pode se sobrepor
     * à seguinte. Barrar também pelo estado do laço tornaria este método
     * inchamável fora dele, e ele precisa funcionar sozinho: em teste, numa
     * rota administrativa ou num job avulso de reprocessamento.
     */
    if (this.running) return
    this.running = true

    const horas = this.deps.lookbackHours

    /**
     * Cada agregação isolada em seu próprio tratamento.
     *
     * Com um `try` único em volta de todas, a primeira falha abortava as
     * seguintes em silêncio — e o sintoma era uma métrica faltando no painel,
     * sem nada no log apontando a causa. Isolar troca "perdi tudo depois do
     * erro" por "perdi só a que quebrou, e sei qual foi".
     */
    const etapas: Array<[string, () => Promise<void>]> = [
      ['volume', () => this.volumeDeMensagens(horas)],
      ['status', () => this.trilhaDeStatus(horas)],
      ['latencia', () => this.latenciaDeEntrega(horas)],
      ['sessoes', () => this.eventosDeSessao(horas)],
      ['risco', () => this.decisoesDeRisco(horas)],
      ['webhooks', () => this.entregaDeWebhooks(horas)],
      ['contatos', () => this.contatosNovos(horas)],
    ]

    try {
      for (const [nome, executar] of etapas) {
        try {
          await executar()
        } catch (error) {
          this.deps.logger.error({ err: error, etapa: nome }, 'falha ao agregar métrica')
        }
      }
    } finally {
      this.running = false
    }
  }

  /** Enviadas e recebidas por hora. */
  private async volumeDeMensagens(horas: number): Promise<void> {
    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, date_trunc('hour', occurred_at),
             'messages.' || direction, count(*)::double precision
      FROM messages
      WHERE occurred_at >= now() - (${horas} || ' hours')::interval
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /**
   * Funil de ACK, contado pelo instante do evento e não pelo da mensagem: uma
   * leitura de hoje sobre mensagem de ontem pertence à hora da leitura.
   */
  private async trilhaDeStatus(horas: number): Promise<void> {
    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT e.org_id, m.session_id, date_trunc('hour', e.occurred_at),
             'status.' || e.status, count(*)::double precision
      FROM message_status_events e
      JOIN messages m ON m.id = e.message_id
      WHERE e.occurred_at >= now() - (${horas} || ' hours')::interval
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /**
   * Percentis de latência até a entrega.
   *
   * Média seria enganosa aqui: a distribuição tem cauda longa — a maioria chega
   * em segundos e algumas levam minutos porque o destinatário estava sem rede.
   * A média some com esse comportamento; o p95 o mostra.
   */
  private async latenciaDeEntrega(horas: number): Promise<void> {
    await this.deps.db.execute(sql`
      WITH latencias AS (
        SELECT m.org_id, m.session_id,
               date_trunc('hour', m.occurred_at) AS bucket,
               EXTRACT(EPOCH FROM (e.occurred_at - m.occurred_at)) * 1000 AS ms
        FROM messages m
        JOIN message_status_events e
          ON e.message_id = m.id AND e.status = 'delivered'
        WHERE m.direction = 'outbound'
          AND m.occurred_at >= now() - (${horas} || ' hours')::interval
          AND e.occurred_at >= m.occurred_at
      )
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, bucket, metrica, valor FROM (
        SELECT org_id, session_id, bucket,
               'latency.delivered.p50' AS metrica,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS valor
        FROM latencias GROUP BY 1, 2, 3
        UNION ALL
        SELECT org_id, session_id, bucket, 'latency.delivered.p95',
               percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)
        FROM latencias GROUP BY 1, 2, 3
        UNION ALL
        SELECT org_id, session_id, bucket, 'latency.delivered.p99',
               percentile_cont(0.99) WITHIN GROUP (ORDER BY ms)
        FROM latencias GROUP BY 1, 2, 3
      ) percentis
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /** Conexões e quedas — base do uptime e do MTBF por sessão. */
  private async eventosDeSessao(horas: number): Promise<void> {
    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, date_trunc('hour', created_at),
             'session.' || type, count(*)::double precision
      FROM session_events
      WHERE created_at >= now() - (${horas} || ' hours')::interval
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /** Quanto o motor de risco segurou, atrasou ou liberou. */
  private async decisoesDeRisco(horas: number): Promise<void> {
    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, date_trunc('hour', created_at),
             'risk.' || action, count(*)::double precision
      FROM risk_events
      WHERE created_at >= now() - (${horas} || ' hours')::interval
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)

    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, date_trunc('hour', created_at),
             'risk.score.avg', avg(score)::double precision
      FROM risk_events
      WHERE created_at >= now() - (${horas} || ' hours')::interval
      GROUP BY 1, 2, 3
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /** Entregas de webhook por desfecho. `session_id` fica nulo: é métrica da org. */
  private async entregaDeWebhooks(horas: number): Promise<void> {
    await this.deps.db.execute(sql`
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, NULL::uuid, date_trunc('hour', created_at),
             'webhook.' || status, count(*)::double precision
      FROM webhook_deliveries
      WHERE created_at >= now() - (${horas} || ' hours')::interval
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }

  /**
   * Destinatários contatados pela primeira vez, por hora.
   *
   * O sinal mais forte de disparo em massa, e o mesmo que o motor de risco
   * limita — tê-lo no histórico permite comparar o comportamento antes e depois
   * de um ajuste de limite.
   */
  private async contatosNovos(horas: number): Promise<void> {
    await this.deps.db.execute(sql`
      WITH primeiro_contato AS (
        SELECT org_id, session_id, chat_id, min(occurred_at) AS iniciado_em
        FROM messages
        WHERE direction = 'outbound'
        GROUP BY 1, 2, 3
      )
      INSERT INTO metrics_hourly (org_id, session_id, bucket, metric, value)
      SELECT org_id, session_id, date_trunc('hour', iniciado_em),
             'contacts.new', count(*)::double precision
      FROM primeiro_contato
      WHERE iniciado_em >= now() - (${horas} || ' hours')::interval
      GROUP BY 1, 2, 3
      ON CONFLICT (org_id, session_id, bucket, metric)
      DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `)
  }
}
