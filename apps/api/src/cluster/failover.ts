import { type Database, sql } from '@awah/db'
import type { ManagerLogger, SessionManager } from '../sessions/manager'
import type { SessionLease } from './lease'

export interface FailoverScannerDeps {
  db: Database
  lease: SessionLease
  sessions: SessionManager
  logger: ManagerLogger
  intervalMs: number
  /** Teto de adoções por ciclo, para um nó não engolir a frota inteira de uma vez. */
  batchSize: number
}

interface OrphanRow {
  id: string
  orgId: string
  name: string
}

/**
 * Adoção de sessões órfãs.
 *
 * Uma sessão fica órfã quando o nó que a detinha some sem soltar a posse — kill
 * -9, OOM, máquina desligada. O lease expira sozinho em segundos e a sessão
 * passa a não ter dono, mas continua com `desired_state = 'running'`: alguém
 * pediu que ela estivesse no ar e ninguém pediu o contrário.
 *
 * O varredor é o que fecha esse ciclo sem coordenador nem eleição. Todos os nós
 * varrem, todos tentam adquirir, e o SET NX decide — quem perde a corrida
 * simplesmente segue para a próxima sessão.
 */
export class FailoverScanner {
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  private scanning = false

  constructor(private readonly deps: FailoverScannerDeps) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.scheduleNext()
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
      void this.scan().finally(() => this.scheduleNext())
    }, this.deps.intervalMs)
    this.timer.unref()
  }

  /** Candidatas: querem estar no ar e não estão rodando aqui. */
  private async candidates(): Promise<OrphanRow[]> {
    const result = await this.deps.db.execute(sql`
      SELECT id, org_id, name
      FROM sessions
      WHERE desired_state = 'running'
        AND engine = 'baileys'
        AND status <> 'logged_out'
        AND status <> 'banned'
      ORDER BY updated_at
      LIMIT ${this.deps.batchSize * 4}
    `)

    return [...result].map((row) => {
      const r = row as Record<string, unknown>
      return { id: String(r.id), orgId: String(r.org_id), name: String(r.name) }
    })
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.stopped) return
    this.scanning = true

    try {
      const candidatas = (await this.candidates()).filter(
        (c) => !this.deps.sessions.isRunning(c.id),
      )
      if (candidatas.length === 0) return

      /**
       * Uma consulta de posse para o lote inteiro. Perguntar sessão a sessão
       * multiplicaria as idas ao Redis por um número que cresce com a frota,
       * num laço que roda em todos os nós ao mesmo tempo.
       */
      const donos = await this.deps.lease.owners(candidatas.map((c) => c.id))
      const orfas = candidatas.filter((c) => !donos.has(c.id)).slice(0, this.deps.batchSize)

      if (orfas.length === 0) return

      for (const orfa of orfas) {
        // `adopt` tenta o lease; perder a corrida para outro nó é resultado normal.
        const assumiu = await this.deps.sessions.adopt(orfa.orgId, orfa.id)
        if (assumiu) {
          this.deps.logger.info(
            { sessionId: orfa.id, name: orfa.name },
            'orphan session adopted by this node',
          )
        }
      }
    } catch (error) {
      this.deps.logger.error({ err: error }, 'failover scan failed')
    } finally {
      this.scanning = false
    }
  }
}
