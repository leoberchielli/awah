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
     * A garantia central do cluster. Duas réplicas com o mesmo auth state abrem
     * dois sockets para o mesmo número, e o WhatsApp derruba os dois
     * alternadamente com 440.
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
     * O compare-and-swap em Lua existe para isto: sem ele, um nó que perdeu a
     * posse poderia estender a posse alheia com um PEXPIRE cego.
     */
    it('não deixa um nó renovar posse alheia', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      const nodeB = new SessionLease(redis, 'awah-2')

      await nodeA.acquire(sessionId)
      expect(await nodeB.renew(sessionId)).toBe(false)
      // A posse de A continua intacta.
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

    /** É o que torna o failover possível sem coordenador nem eleição. */
    it('a posse expira sozinha quando ninguém renova', async () => {
      const efemero = new SessionLease(redis, 'awah-morto', { ttlMs: 3000 })
      await efemero.acquire(sessionId)
      expect(await efemero.owner(sessionId)).toBe('awah-morto')

      await espera(3200)

      expect(await efemero.owner(sessionId)).toBeNull()
      // E outro nó consegue assumir.
      const sobrevivente = new SessionLease(redis, 'awah-2')
      expect(await sobrevivente.acquire(sessionId)).toBe(true)
      await sobrevivente.release(sessionId)
    })

    it('consulta a posse de várias sessões de uma vez', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      const comDono = randomUUID()
      const semDono = randomUUID()

      await nodeA.acquire(comDono)
      const donos = await nodeA.owners([comDono, semDono])

      expect(donos.get(comDono)).toBe('awah-1')
      expect(donos.has(semDono)).toBe(false)

      await nodeA.release(comDono)
    })

    it('lista vazia não vai ao Redis', async () => {
      const nodeA = new SessionLease(redis, 'awah-1')
      expect((await nodeA.owners([])).size).toBe(0)
    })
  })

  describe('QR compartilhado', () => {
    it('o que um nó publica, outro lê', async () => {
      const doDono = new QrCache(redis)
      const deOutroNo = new QrCache(redis)

      await doDono.publish(sessionId, '2@codigo-de-pareamento')
      expect(await deOutroNo.read(sessionId)).toBe('2@codigo-de-pareamento')

      await doDono.clear(sessionId)
      expect(await deOutroNo.read(sessionId)).toBeNull()
    })

    it('sessão sem pareamento em curso não tem QR', async () => {
      expect(await new QrCache(redis).read(randomUUID())).toBeNull()
    })
  })

  describe('roteamento de comandos', () => {
    let publisher: Redis
    let subscriberDono: Redis
    let subscriberEmissor: Redis
    let dono: CommandBus
    let emissor: CommandBus

    beforeAll(async () => {
      publisher = redis.duplicate()
      subscriberDono = redis.duplicate()
      subscriberEmissor = redis.duplicate()

      /**
       * O ioredis conecta de forma preguiçosa. Em produção as conexões sobem no
       * boot, muito antes do primeiro comando; aqui elas nascem no milissegundo
       * anterior ao teste, e sem este aquecimento a primeira troca compete com o
       * handshake.
       */
      await Promise.all([publisher.ping(), subscriberDono.ping(), subscriberEmissor.ping()])

      dono = new CommandBus({
        publisher,
        subscriber: subscriberDono,
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
      await dono?.close()
      await emissor?.close()
      await Promise.allSettled([
        publisher?.quit(),
        subscriberDono?.quit(),
        subscriberEmissor?.quit(),
      ])
    })

    /**
     * Sem isto, parar uma sessão funcionaria ou não conforme o balanceador
     * escolhesse a réplica — comportamento intermitente impossível de depurar.
     */
    it('entrega o comando ao dono e devolve o resultado', async () => {
      await dono.claim(sessionId, async (request) => ({
        executado: request.command,
        para: request.sessionId,
      }))

      const resposta = await emissor.send({
        sessionId,
        orgId: randomUUID(),
        command: 'stop',
      })

      expect(resposta.ok).toBe(true)
      expect(resposta.result).toEqual({ executado: 'stop', para: sessionId })

      await dono.unclaim(sessionId)
    })

    it('leva o payload junto', async () => {
      await dono.claim(sessionId, async (request) => ({
        recebido: request.payload?.phoneNumber,
      }))

      const resposta = await emissor.send({
        sessionId,
        orgId: randomUUID(),
        command: 'pairing-code',
        payload: { phoneNumber: '5511999999999' },
      })

      expect(resposta.result).toEqual({ recebido: '5511999999999' })
      await dono.unclaim(sessionId)
    })

    it('propaga a falha do dono em vez de silenciar', async () => {
      await dono.claim(sessionId, async () => {
        throw new Error('sessão já estava parada')
      })

      const resposta = await emissor.send({ sessionId, orgId: randomUUID(), command: 'stop' })

      expect(resposta.ok).toBe(false)
      expect(resposta.error).toContain('já estava parada')

      await dono.unclaim(sessionId)
    })

    /** Nó morto não pode deixar quem pediu esperando para sempre. */
    it('devolve erro de timeout quando ninguém atende', async () => {
      const resposta = await emissor.send({
        sessionId: randomUUID(),
        orgId: randomUUID(),
        command: 'stop',
      })

      expect(resposta.ok).toBe(false)
      expect(resposta.error).toMatch(/não respondeu/i)
    })

    it('para de atender depois de soltar a sessão', async () => {
      await dono.claim(sessionId, async () => ({ ok: true }))
      await dono.unclaim(sessionId)

      const resposta = await emissor.send({ sessionId, orgId: randomUUID(), command: 'stop' })
      expect(resposta.ok).toBe(false)
    })
  })
})
