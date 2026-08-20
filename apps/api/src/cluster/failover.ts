import { type Database, sql } from '@awah/db'
import type { ManagerLogger, SessionManager } from '../sessions/manager'
import type { SessionLease } from './lease'

export interface FailoverScannerDeps {
  db: Database
  lease: SessionLease
  sessions: SessionManager
  logger: ManagerLogger
  intervalMs: number
  /** Cap on adoptions per cycle, so one node cannot swallow the whole fleet at once. */
  batchSize: number
}

interface OrphanRow {
  id: string
  orgId: string
  name: string
}

/**
 * Adoption of orphaned sessions.
 *
 * A session is orphaned when the node that held it disappears without releasing
 * ownership — kill -9, OOM, machine powered off. The lease expires on its own
 * within seconds and the session is left with no owner, but it still carries
 * `desired_state = 'running'`: someone asked for it to be up and nobody asked
 * for the opposite.
 *
 * The scanner is what closes that loop, with no coordinator and no election.
 * Every node scans, every node tries to acquire, and SET NX decides — whoever
 * loses the race simply moves on to the next session.
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

  /** Candidates: they want to be up and they are not running here. */
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
      const candidates = (await this.candidates()).filter(
        (c) => !this.deps.sessions.isRunning(c.id),
      )
      if (candidates.length === 0) return

      /**
       * One ownership lookup for the whole batch. Asking session by session
       * would multiply the round trips to Redis by a number that grows with
       * the fleet, in a loop that runs on every node at the same time.
       */
      const owners = await this.deps.lease.owners(candidates.map((c) => c.id))
      const orphans = candidates.filter((c) => !owners.has(c.id)).slice(0, this.deps.batchSize)

      if (orphans.length === 0) return

      for (const orphan of orphans) {
        // `adopt` tries for the lease; losing the race to another node is normal.
        const adopted = await this.deps.sessions.adopt(orphan.orgId, orphan.id)
        if (adopted) {
          this.deps.logger.info(
            { sessionId: orphan.id, name: orphan.name },
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
