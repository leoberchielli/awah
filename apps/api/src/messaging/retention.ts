import { type Database, eq, schema } from '@awah/db'

interface CacheEntry {
  retentionDays: number
  expiresAt: number
}

/**
 * Resolve a política de retenção de uma organização.
 *
 * O valor é consultado em toda mensagem que entra ou sai, e muda raramente —
 * daí o cache curto. Sessenta segundos é o atraso máximo entre alguém mudar a
 * política no dashboard e ela valer para mensagens novas; mensagens já gravadas
 * não são afetadas de qualquer forma.
 */
export class RetentionResolver {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly db: Database,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async retentionDays(orgId: string): Promise<number> {
    const cached = this.cache.get(orgId)
    if (cached && cached.expiresAt > this.now()) return cached.retentionDays

    const [row] = await this.db
      .select({ retentionDays: schema.orgs.retentionDays })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1)

    const retentionDays = row?.retentionDays ?? 30
    this.cache.set(orgId, { retentionDays, expiresAt: this.now() + this.ttlMs })
    return retentionDays
  }

  invalidate(orgId: string): void {
    this.cache.delete(orgId)
  }
}

export interface RetentionDecision {
  /** Corpo a persistir. Nulo quando a organização não guarda conteúdo. */
  body: string | null
  /** Quando o conteúdo deve ser apagado. Nulo significa reter para sempre. */
  contentExpiresAt: Date | null
}

/**
 * Aplica a política ao conteúdo de uma mensagem.
 *
 * `0` nunca persiste corpo — a linha nasce só com metadados, e os KPIs de
 * volume e latência continuam funcionando. `-1` retém para sempre. Qualquer
 * outro valor marca a data em que o corpo será apagado, degradando a linha para
 * metadados sem perder o histórico de contagem.
 */
export function applyRetention(
  body: string | null,
  retentionDays: number,
  now: Date = new Date(),
): RetentionDecision {
  if (retentionDays === 0) {
    return { body: null, contentExpiresAt: null }
  }

  if (retentionDays < 0) {
    return { body, contentExpiresAt: null }
  }

  return {
    body,
    contentExpiresAt: new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000),
  }
}
