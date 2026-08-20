import type Redis from 'ioredis'

/**
 * Renew only if we are still the owner.
 *
 * It has to be atomic: between a separate GET and PEXPIRE there is room for the
 * lease to expire and another node to take it, and the PEXPIRE would then
 * extend someone else's ownership — two processes convinced they are in charge
 * of the same session is exactly the scenario that produces the 440 "Session
 * taken over elsewhere".
 */
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`

/** Release only what is ours, for the same reason. */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`

export interface LeaseOptions {
  /** Lease lifetime. Let it pass without a renewal and the session is free. */
  ttlMs?: number
}

/**
 * Exclusive session ownership across replicas.
 *
 * The short TTL with frequent renewal is deliberate: if the owning node dies,
 * nobody renews and the session becomes available within seconds, with no
 * coordinator, no election and no intervention. The price is that the owner has
 * to renew forever — and losing a renewal means releasing the session right
 * then, not insisting.
 */
export class SessionLease {
  private readonly ttlMs: number

  constructor(
    private readonly redis: Redis,
    private readonly nodeId: string,
    options: LeaseOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 15_000
  }

  private key(sessionId: string): string {
    return `awah:lease:${sessionId}`
  }

  /** SET NX: only one node wins, even with all of them trying at once. */
  async acquire(sessionId: string): Promise<boolean> {
    const result = await this.redis.set(this.key(sessionId), this.nodeId, 'PX', this.ttlMs, 'NX')
    return result === 'OK'
  }

  /** Returns false when ownership is lost — the caller must release the session. */
  async renew(sessionId: string): Promise<boolean> {
    const result = await this.redis.eval(
      RENEW_SCRIPT,
      1,
      this.key(sessionId),
      this.nodeId,
      String(this.ttlMs),
    )
    return result === 1
  }

  async release(sessionId: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, this.key(sessionId), this.nodeId)
  }

  async owner(sessionId: string): Promise<string | null> {
    return this.redis.get(this.key(sessionId))
  }

  async isMine(sessionId: string): Promise<boolean> {
    return (await this.owner(sessionId)) === this.nodeId
  }

  /** Which of the given sessions are held by someone. */
  async owners(sessionIds: string[]): Promise<Map<string, string>> {
    if (sessionIds.length === 0) return new Map()

    const values = await this.redis.mget(sessionIds.map((id) => this.key(id)))
    const map = new Map<string, string>()

    sessionIds.forEach((id, index) => {
      const owner = values[index]
      if (owner) map.set(id, owner)
    })

    return map
  }
}
