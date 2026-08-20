import { type Database, eq, schema } from '@awah/db'

interface CacheEntry {
  retentionDays: number
  expiresAt: number
}

/**
 * Resolves an organization's retention policy.
 *
 * The value is looked up on every message in or out, and rarely changes —
 * hence the short cache. Sixty seconds is the longest delay between someone
 * changing the policy in the dashboard and it holding for new messages;
 * messages already written are unaffected either way.
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
  /** Body to persist. Null when the organization keeps no content. */
  body: string | null
  /** When the content should be erased. Null means keep it forever. */
  contentExpiresAt: Date | null
}

/**
 * Applies the policy to a message's content.
 *
 * `0` never persists a body — the row is born with metadata only, and the
 * volume and latency KPIs go on working. `-1` keeps it forever. Any other value
 * marks the date the body will be erased, degrading the row to metadata without
 * losing the counting history.
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
