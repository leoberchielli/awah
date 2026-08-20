import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CommandBus } from '../../src/cluster/commands'
import { SessionLease } from '../../src/cluster/lease'
import { QrCache } from '../../src/cluster/qr-cache'
import type { ManagerLogger } from '../../src/sessions/manager'

const hasInfra = Boolean(process.env.REDIS_URL)

const silent: ManagerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!hasInfra)('cluster', () => {
  let redis: Redis
  let sessionId: string

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL as string)
  })

  afterAll(async () => {
    await redis?.quit()
  })

  beforeEach(() => {
    sessionId = randomUUID()
  })

  describe('session ownership', () => {
    /**
     * The cluster's central guarantee. Two replicas with the same auth state
     * open two sockets to the same number, and WhatsApp knocks both offline in
     * turn with 440.
     */
    it('only one node wins ownership', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      const nodeB = new SessionLease(redis, 'awah-2')

      const [wonA, wonB] = await Promise.all([nodeA.acquire(sessionId), nodeB.acquire(sessionId)])

      expect([wonA, wonB].filter(Boolean)).toHaveLength(1)
      await nodeA.release(sessionId)
      await nodeB.release(sessionId)
    })

    it('identifies the owner', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      await nodeA.acquire(sessionId)

      expect(await nodeA.owner(sessionId)).toBe('awah-1')
      expect(await nodeA.isMine(sessionId)).toBe(true)

      const nodeB = new SessionLease(redis, 'awah-2')
      expect(await nodeB.isMine(sessionId)).toBe(false)

      await nodeA.release(sessionId)
    })

    it('renews ownership for the node that owns it', async () => {
      const nodeA = new SessionLease(redis, 'awah-1', { ttlMs: 3000 })
      await nodeA.acquire(sessionId)

      expect(await nodeA.renew(sessionId)).toBe(true)
      await nodeA.release(sessionId)
    })

    /**
     * The Lua compare-and-swap exists for this: without it, a node that lost
     * ownership could extend someone else's with a blind PEXPIRE.
     */
    it("does not let a node renew someone else's ownership", async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      const nodeB = new SessionLease(redis, 'awah-2')

      await nodeA.acquire(sessionId)
      expect(await nodeB.renew(sessionId)).toBe(false)
      // A's ownership is still intact.
      expect(await nodeA.owner(sessionId)).toBe('awah-1')

      await nodeA.release(sessionId)
    })

    it("does not let a node release someone else's ownership", async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      const nodeB = new SessionLease(redis, 'awah-2')

      await nodeA.acquire(sessionId)
      await nodeB.release(sessionId)

      expect(await nodeA.owner(sessionId)).toBe('awah-1')
      await nodeA.release(sessionId)
    })

    /** This is what makes failover possible with no coordinator and no election. */
    it('ownership expires on its own when nobody renews it', async () => {
      const ephemeral = new SessionLease(redis, 'awah-morto', { ttlMs: 3000 })
      await ephemeral.acquire(sessionId)
      expect(await ephemeral.owner(sessionId)).toBe('awah-morto')

      await sleep(3200)

      expect(await ephemeral.owner(sessionId)).toBeNull()
      // And another node can take over.
      const survivor = new SessionLease(redis, 'awah-2')
      expect(await survivor.acquire(sessionId)).toBe(true)
      await survivor.release(sessionId)
    })

    it('queries ownership of several sessions at once', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      const withOwner = randomUUID()
      const withoutOwner = randomUUID()

      await nodeA.acquire(withOwner)
      const owners = await nodeA.owners([withOwner, withoutOwner])

      expect(owners.get(withOwner)).toBe('awah-1')
      expect(owners.has(withoutOwner)).toBe(false)

      await nodeA.release(withOwner)
    })

    it('an empty list never reaches Redis', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      expect((await nodeA.owners([])).size).toBe(0)
    })
  })

  describe('shared QR', () => {
    it('what one node publishes, another reads', async () => {
      const fromOwner = new QrCache(redis)
      const deOutroNo = new QrCache(redis)

      await fromOwner.publish(sessionId, '2@pairing-code')
      expect(await deOutroNo.read(sessionId)).toBe('2@pairing-code')

      await fromOwner.clear(sessionId)
      expect(await deOutroNo.read(sessionId)).toBeNull()
    })

    it('a session with no pairing under way has no QR', async () => {
      expect(await new QrCache(redis).read(randomUUID())).toBeNull()
    })
  })

  describe('command routing', () => {
    let publisher: Redis
    let ownerSubscriber: Redis
    let senderSubscriber: Redis
    let owner: CommandBus
    let sender: CommandBus

    beforeAll(async () => {
      publisher = redis.duplicate()
      ownerSubscriber = redis.duplicate()
      senderSubscriber = redis.duplicate()

      /**
       * ioredis connects lazily. In production the connections come up at boot,
       * long before the first command; here they are born the millisecond
       * before the test, and without this warm-up the first exchange races the
       * handshake.
       */
      await Promise.all([publisher.ping(), ownerSubscriber.ping(), senderSubscriber.ping()])

      owner = new CommandBus({
        publisher,
        subscriber: ownerSubscriber,
        nodeId: 'awah-owner',
        logger: silent,
      })
      sender = new CommandBus({
        publisher,
        subscriber: senderSubscriber,
        nodeId: 'awah-emissor',
        logger: silent,
        timeoutMs: 2000,
      })
    })

    afterAll(async () => {
      await owner?.close()
      await sender?.close()
      await Promise.allSettled([
        publisher?.quit(),
        ownerSubscriber?.quit(),
        senderSubscriber?.quit(),
      ])
    })

    /**
     * Without this, stopping a session would work or not depending on which
     * replica the load balancer picked — intermittent behaviour nobody can debug.
     */
    it('delivers the command to the owner and returns the result', async () => {
      await owner.claim(sessionId, async (request) => ({
        executed: request.command,
        to: request.sessionId,
      }))

      const response = await sender.send({
        sessionId,
        orgId: randomUUID(),
        command: 'stop',
      })

      expect(response.ok).toBe(true)
      expect(response.result).toEqual({ executed: 'stop', to: sessionId })

      await owner.unclaim(sessionId)
    })

    it('carries the payload along', async () => {
      await owner.claim(sessionId, async (request) => ({
        received: request.payload?.phoneNumber,
      }))

      const response = await sender.send({
        sessionId,
        orgId: randomUUID(),
        command: 'pairing-code',
        payload: { phoneNumber: '5511999999999' },
      })

      expect(response.result).toEqual({ received: '5511999999999' })
      await owner.unclaim(sessionId)
    })

    it("propagates the owner's failure instead of swallowing it", async () => {
      await owner.claim(sessionId, async () => {
        throw new Error('session was already stopped')
      })

      const response = await sender.send({ sessionId, orgId: randomUUID(), command: 'stop' })

      expect(response.ok).toBe(false)
      expect(response.error).toContain('already stopped')

      await owner.unclaim(sessionId)
    })

    /** A dead node must not leave the caller waiting forever. */
    it('returns a timeout error when nobody answers', async () => {
      const response = await sender.send({
        sessionId: randomUUID(),
        orgId: randomUUID(),
        command: 'stop',
      })

      expect(response.ok).toBe(false)
      expect(response.error).toMatch(/did not respond/i)
    })

    it('stops answering after releasing the session', async () => {
      await owner.claim(sessionId, async () => ({ ok: true }))
      await owner.unclaim(sessionId)

      const response = await sender.send({ sessionId, orgId: randomUUID(), command: 'stop' })
      expect(response.ok).toBe(false)
    })
  })
})
