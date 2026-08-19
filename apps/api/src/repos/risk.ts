import { and, desc, eq, type RiskAction, schema } from '@awah/db'
import { TenantRepository } from './base'

export interface RiskEventRow {
  id: string
  sessionId: string
  outboxId: string | null
  action: RiskAction
  score: number
  reason: string
  delayMs: number | null
  budget: unknown
  createdAt: Date
}

export class RiskRepository extends TenantRepository {
  /**
   * Registra a decisão junto do retrato do orçamento no instante em que ela foi
   * tomada.
   *
   * Guardar o snapshot é o que torna o motor auditável meses depois: dá para
   * responder "por que esta mensagem atrasou quarenta segundos às 14h03" sem
   * reconstituir o estado do Redis daquele momento.
   */
  async record(input: {
    sessionId: string
    outboxId?: string | null
    action: RiskAction
    score: number
    reason: string
    delayMs?: number | null
    budget?: Record<string, unknown> | null
  }): Promise<void> {
    await this.db.insert(schema.riskEvents).values({
      orgId: this.orgId,
      sessionId: input.sessionId,
      outboxId: input.outboxId ?? null,
      action: input.action,
      score: input.score,
      reason: input.reason,
      delayMs: input.delayMs ?? null,
      budget: input.budget ?? null,
    })
  }

  async list(filter?: {
    sessionId?: string
    action?: RiskAction
    limit?: number
  }): Promise<RiskEventRow[]> {
    const conditions = [eq(schema.riskEvents.orgId, this.orgId)]
    if (filter?.sessionId) conditions.push(eq(schema.riskEvents.sessionId, filter.sessionId))
    if (filter?.action) conditions.push(eq(schema.riskEvents.action, filter.action))

    return this.db
      .select({
        id: schema.riskEvents.id,
        sessionId: schema.riskEvents.sessionId,
        outboxId: schema.riskEvents.outboxId,
        action: schema.riskEvents.action,
        score: schema.riskEvents.score,
        reason: schema.riskEvents.reason,
        delayMs: schema.riskEvents.delayMs,
        budget: schema.riskEvents.budget,
        createdAt: schema.riskEvents.createdAt,
      })
      .from(schema.riskEvents)
      .where(and(...conditions))
      .orderBy(desc(schema.riskEvents.createdAt))
      .limit(filter?.limit ?? 100)
  }
}
