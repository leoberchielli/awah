import type Redis from 'ioredis'

/**
 * Pairing QR shared across replicas.
 *
 * The QR is born in the memory of the node that holds the session, but the
 * request that goes looking for it can land on any other one. Routing the
 * request to the owner would solve it; publishing to a common place is simpler
 * and faster, and the data is ephemeral by nature — WhatsApp swaps the code
 * every few seconds, so a stale cache is not a problem to avoid, it is the
 * expected behavior.
 *
 * The short TTL makes sure the QR of an already-paired session is not still
 * available after it stopped being valid.
 */
export class QrCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds = 90,
  ) {}

  private key(sessionId: string): string {
    return `awah:qr:${sessionId}`
  }

  async publish(sessionId: string, qr: string): Promise<void> {
    await this.redis.set(this.key(sessionId), qr, 'EX', this.ttlSeconds)
  }

  async read(sessionId: string): Promise<string | null> {
    return this.redis.get(this.key(sessionId))
  }

  /** Called on pairing or shutting down: the code stopped being valid. */
  async clear(sessionId: string): Promise<void> {
    await this.redis.del(this.key(sessionId))
  }
}
