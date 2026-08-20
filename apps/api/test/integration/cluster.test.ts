import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CommandBus } from '../../src/cluster/commands'
import { SessionLease } from '../../src/cluster/lease'
import { QrCache } from '../../src/cluster/qr-cache'
import type { ManagerLogger } from '../../src/sessions/manager'

const hasInfra = Boolean(process.env.REDIS_URL)

const silencioso: ManagerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

const espera = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

  describe('posse de sessão', () => {
    /**
     * The cluster's central guarantee. Two replicas with the same auth state
     * open two sockets to the same number, and WhatsApp knocks both offline in
     * turn with 440.
     */
    it('só um nó ganha a posse', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      const nodeB = new SessionLease(redis, 'awah-2')

      const [ganhouA, ganhouB] = await Promise.all([
        nodeA.acquire(sessionId),
        nodeB.acquire(sessionId),
      ])

      expect([ganhouA, ganhouB].filter(Boolean)).toHaveLength(1)
      await nodeA.release(sessionId)
      await nodeB.release(sessionId)
    })

    it('identifica o dono', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      await nodeA.acquire(sessionId)

      expect(await nodeA.owner(sessionId)).toBe('awah-1')
      expect(await nodeA.isMine(sessionId)).toBe(true)

      const nodeB = new SessionLease(redis, 'awah-2')
      expect(await nodeB.isMine(sessionId)).toBe(false)

      await nodeA.release(sessionId)
    })

    it('renova a posse de quem é dono', async () => {
      const nodeA = new SessionLease(redis, 'awah-1', { ttlMs: 3000 })
      await nodeA.acquire(sessionId)

      expect(await nodeA.renew(sessionId)).toBe(true)
      await nodeA.release(sessionId)
    })

    /**
     * The Lua compare-and-swap exists for this: without it, a node that lost
     * ownership could extend someone else's with a blind PEXPIRE.
     */
    it('não deixa um nó renovar posse alheia', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      const nodeB = new SessionLease(redis, 'awah-2')

      await nodeA.acquire(sessionId)
      expect(await nodeB.renew(sessionId)).toBe(false)
      // A's ownership is still intact.
      expect(await nodeA.owner(sessionId)).toBe('awah-1')

      await nodeA.release(sessionId)
    })

    it('não deixa um nó soltar posse alheia', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      const nodeB = new SessionLease(redis, 'awah-2')

      await nodeA.acquire(sessionId)
      await nodeB.release(sessionId)

      expect(await nodeA.owner(sessionId)).toBe('awah-1')
      await nodeA.release(sessionId)
    })

    /** This is what makes failover possible with no coordinator and no election. */
    it('a posse expira sozinha quando ninguém renova', async () => {
      const efemero = new SessionLease(redis, 'awah-morto', { ttlMs: 3000 })
      await efemero.acquire(sessionId)
      expect(await efemero.owner(sessionId)).toBe('awah-morto')

      await espera(3200)

      expect(await efemero.owner(sessionId)).toBeNull()
      // And another node can take over.
      const sobrevivente = new SessionLease(redis, 'awah-2')
      expect(await sobrevivente.acquire(sessionId)).toBe(true)
      await sobrevivente.release(sessionId)
    })

    it('consulta a posse de várias sessões de uma vez', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      const withOwner = randomUUID()
      const withoutOwner = randomUUID()

      await nodeA.acquire(withOwner)
      const owners = await nodeA.owners([withOwner, withoutOwner])

      expect(owners.get(withOwner)).toBe('awah-1')
      expect(owners.has(withoutOwner)).toBe(false)

      await nodeA.release(withOwner)
    })

    it('lista vazia não vai ao Redis', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      expect((await nodeA.owners([])).size).toBe(0)
    })
  })

  describe('QR compartilhado', () => {
    it('o que um nó publica, outro lê', async () => {
      const fromOwner = new QrCache(redis)
      const deOutroNo = new QrCache(redis)

      await fromOwner.publish(sessionId, '2@codigo-de-pareamento')
      expect(await deOutroNo.read(sessionId)).toBe('2@codigo-de-pareamento')

      await fromOwner.clear(sessionId)
      expect(await deOutroNo.read(sessionId)).toBeNull()
    })

    it('sessão sem pareamento em curso não tem QR', async () => {
      expect(await new QrCache(redis).read(randomUUID())).toBeNull()
    })
  })

  describe('roteamento de comandos', () => {
    let publisher: Redis
    let ownerSubscriber: Redis
    let subscriberEmissor: Redis
    let owner: CommandBus
    let emissor: CommandBus

    beforeAll(async () => {
      publisher = redis.duplicate()
      ownerSubscriber = redis.duplicate()
      subscriberEmissor = redis.duplicate()

      /**
       * ioredis connects lazily. In production the connections come up at boot,
       * long before the first command; here they are born the millisecond
       * before the test, and without this warm-up the first exchange races the
       * handshake.
       */
      await Promise.all([publisher.ping(), ownerSubscriber.ping(), subscriberEmissor.ping()])

      owner = new CommandBus({
        publisher,
        subscriber: ownerSubscriber,
        nodeId: 'awah-dono',
        logger: silencioso,
      })
      emissor = new CommandBus({
        publisher,
        subscriber: subscriberEmissor,
        nodeId: 'awah-emissor',
        logger: silencioso,
        timeoutMs: 2000,
      })
    })

    afterAll(async () => {
      await owner?.close()
      await emissor?.close()
      await Promise.allSettled([
        publisher?.quit(),
        ownerSubscriber?.quit(),
        subscriberEmissor?.quit(),
      ])
    })

    /**
     * Without this, stopping a session would work or not depending on which
     * replica the load balancer picked — intermittent behaviour nobody can debug.
     */
    it('entrega o comando ao dono e devolve o resultado', async () => {
      await owner.claim(sessionId, async (request) => ({
        executado: request.command,
        to: request.sessionId,
      }))

      const resposta = await emissor.send({
        sessionId,
        orgId: randomUUID(),
        command: 'stop',
      })

      expect(resposta.ok).toBe(true)
      expect(resposta.result).toEqual({ executado: 'stop', to: sessionId })

      await owner.unclaim(sessionId)
    })

    it('leva o payload junto', async () => {
      await owner.claim(sessionId, async (request) => ({
        recebido: request.payload?.phoneNumber,
      }))

      const resposta = await emissor.send({
        sessionId,
        orgId: randomUUID(),
        command: 'pairing-code',
        payload: { phoneNumber: '5511999999999' },
      })

      expect(resposta.result).toEqual({ recebido: '5511999999999' })
      await owner.unclaim(sessionId)
    })

    it('propaga a falha do dono em vez de silenciar', async () => {
      await owner.claim(sessionId, async () => {
        throw new Error('sessão já estava parada')
      })

      const resposta = await emissor.send({ sessionId, orgId: randomUUID(), command: 'stop' })

      expect(resposta.ok).toBe(false)
      expect(resposta.error).toContain('já estava parada')

      await owner.unclaim(sessionId)
    })

    /** A dead node must not leave the caller waiting forever. */
    it('devolve erro de timeout quando ninguém atende', async () => {
      const resposta = await emissor.send({
        sessionId: randomUUID(),
        orgId: randomUUID(),
        command: 'stop',
      })

      expect(resposta.ok).toBe(false)
      expect(resposta.error).toMatch(/did not respond/i)
    })

    it('para de atender depois de soltar a sessão', async () => {
      await owner.claim(sessionId, async () => ({ ok: true }))
      await owner.unclaim(sessionId)

      const resposta = await emissor.send({ sessionId, orgId: randomUUID(), command: 'stop' })
      expect(resposta.ok).toBe(false)
    })
  })
})
