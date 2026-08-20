import { randomUUID } from 'node:crypto'
import { createDb, type Database, eq, schema, sql } from '@awah/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { claimOutbox, markFailed, markSent, recoverStuck, release } from '../../src/messaging/queue'
import { OutboxRepository } from '../../src/repos/outbox'
import { createSession, type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasInfra)('outbox queue', () => {
  let handle: ReturnType<typeof createDb>
  let db: Database
  let org: SeededOrg
  let sessionId: string
  let repo: OutboxRepository

  const enqueue = (chatId: string, text: string, clientMessageId = randomUUID()) =>
    repo.enqueue({
      sessionId,
      chatId,
      clientMessageId,
      type: 'text',
      payload: { text },
    })

  beforeAll(async () => {
    handle = createDb({ url: process.env.DATABASE_URL as string, max: 3 })
    db = handle.db
    org = await seedOrg(db)
    sessionId = await createSession(db, org.orgId)
    repo = new OutboxRepository(db, org.orgId)
  })

  afterAll(async () => {
    await org?.cleanup()
    await handle?.close()
  })

  beforeEach(async () => {
    await db.delete(schema.outboxMessages).where(eq(schema.outboxMessages.orgId, org.orgId))
  })

  describe('idempotency', () => {
    it('does not duplicate the same clientMessageId', async () => {
      const id = randomUUID()
      const first = await enqueue('5511900000001@s.whatsapp.net', 'hi', id)
      const second = await enqueue('5511900000001@s.whatsapp.net', 'oi de novo', id)

      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.row.id).toBe(first.row.id)

      const all = await repo.list()
      expect(all).toHaveLength(1)
    })

    /** The client's retry gets back the original row, not the second attempt. */
    it('returns the original send on a resend', async () => {
      const id = randomUUID()
      await enqueue('5511900000002@s.whatsapp.net', 'texto original', id)
      const repetido = await enqueue('5511900000002@s.whatsapp.net', 'texto diferente', id)

      const persisted = await repo.findByClientId(id)
      expect(persisted?.id).toBe(repetido.row.id)
    })
  })

  describe('FIFO per chat', () => {
    /**
     * The queue's central guarantee: inside one conversation the order is the
     * order of arrival, and two sends never leave for the same chat at once.
     */
    it("claims only the head of each chat's queue", async () => {
      const chat = '5511911111111@s.whatsapp.net'
      const first = await enqueue(chat, 'message 1')
      await enqueue(chat, 'message 2')
      await enqueue(chat, 'message 3')

      const claimed = await claimOutbox(db, [sessionId], 10)

      expect(claimed).toHaveLength(1)
      expect(claimed[0]?.id).toBe(first.row.id)
      expect(claimed[0]?.payload.text).toBe('message 1')
    })

    it('does not release the next one while the previous is going out', async () => {
      const chat = '5511922222222@s.whatsapp.net'
      await enqueue(chat, 'first')
      await enqueue(chat, 'second')

      await claimOutbox(db, [sessionId], 10)
      // The first is still 'sending'; the second cycle must pick up nothing.
      const secondCycle = await claimOutbox(db, [sessionId], 10)

      expect(secondCycle).toHaveLength(0)
    })

    it('releases the next one after the previous completes', async () => {
      const chat = '5511933333333@s.whatsapp.net'
      await enqueue(chat, 'first')
      const second = await enqueue(chat, 'second')

      const [claimed] = await claimOutbox(db, [sessionId], 10)
      if (!claimed) throw new Error('nada reservado')
      await markSent(db, claimed.id, 'ENGINE-1')

      const next = await claimOutbox(db, [sessionId], 10)
      expect(next).toHaveLength(1)
      expect(next[0]?.id).toBe(second.row.id)
    })

    /** Distinct chats do not block each other — this is the §4.2 parallelism. */
    it('claims different chats in parallel', async () => {
      await enqueue('5511944444444@s.whatsapp.net', 'to A')
      await enqueue('5511955555555@s.whatsapp.net', 'to B')
      await enqueue('5511966666666@s.whatsapp.net', 'to C')

      const claimed = await claimOutbox(db, [sessionId], 10)
      expect(claimed).toHaveLength(3)
    })
  })

  describe('exclusivity between workers', () => {
    it('does not hand the same send to two consumers', async () => {
      await enqueue('5511977777777@s.whatsapp.net', 'only one')

      const [a, b] = await Promise.all([
        claimOutbox(db, [sessionId], 10),
        claimOutbox(db, [sessionId], 10),
      ])

      expect((a?.length ?? 0) + (b?.length ?? 0)).toBe(1)
    })
  })

  describe('retry and dead-letter queue', () => {
    it('requeues with a delay and spends an attempt', async () => {
      await enqueue('5511988888888@s.whatsapp.net', 'vai falhar')
      const [job] = await claimOutbox(db, [sessionId], 1)
      if (!job) throw new Error('nada reservado')

      const result = await markFailed(db, job.id, 'timeout na engine', 60_000)
      expect(result).toBe('queued')

      const row = await repo.findById(job.id)
      expect(row?.attempts).toBe(1)
      expect(row?.lastError).toContain('timeout')
      expect(row?.availableAt.getTime()).toBeGreaterThan(Date.now() + 30_000)

      // Not eligible yet: the delay has to be respected.
      expect(await claimOutbox(db, [sessionId], 10)).toHaveLength(0)
    })

    it('sends to the DLQ when the attempts run out', async () => {
      const { row } = await repo.enqueue({
        sessionId,
        chatId: '5511999999999@s.whatsapp.net',
        clientMessageId: randomUUID(),
        type: 'text',
        payload: { text: 'condenada' },
        maxAttempts: 2,
      })

      for (let i = 0; i < 2; i++) {
        await db
          .update(schema.outboxMessages)
          .set({ status: 'sending', availableAt: new Date() })
          .where(eq(schema.outboxMessages.id, row.id))
        await markFailed(db, row.id, `falha ${i + 1}`, 0)
      }

      const dead = await repo.findById(row.id)
      expect(dead?.status).toBe('dead')
      expect(dead?.attempts).toBe(2)
    })

    it('reprocesses a dead send resetting the attempts', async () => {
      const { row } = await repo.enqueue({
        sessionId,
        chatId: '5511900000009@s.whatsapp.net',
        clientMessageId: randomUUID(),
        type: 'text',
        payload: { text: 'ressuscitar' },
        maxAttempts: 1,
      })

      await markFailed(db, row.id, 'falhou', 0)
      expect((await repo.findById(row.id))?.status).toBe('dead')

      expect(await repo.retry(row.id)).toBe(true)
      const revived = await repo.findById(row.id)
      expect(revived?.status).toBe('queued')
      expect(revived?.attempts).toBe(0)
      expect(revived?.lastError).toBeNull()
    })

    /** A session that is down is not a delivery failure: released, no attempt spent. */
    it('release spends no attempt', async () => {
      await enqueue('5511900000010@s.whatsapp.net', 'session dropped')
      const [job] = await claimOutbox(db, [sessionId], 1)
      if (!job) throw new Error('nada reservado')

      await release(db, job.id, 0)
      const row = await repo.findById(job.id)

      expect(row?.status).toBe('queued')
      expect(row?.attempts).toBe(0)
    })
  })

  describe('recovery of stuck sends', () => {
    /**
     * Without this, a process that dies mid-send jams that chat's queue for
     * good: the claim would keep seeing a send in flight that no longer exists
     * anywhere.
     */
    it('requeues what got stuck in sending', async () => {
      await enqueue('5511900000011@s.whatsapp.net', 'orphan')
      const [job] = await claimOutbox(db, [sessionId], 1)
      if (!job) throw new Error('nada reservado')

      // Pretend the process died ten minutes ago.
      await db.execute(
        sql`UPDATE outbox_messages SET updated_at = now() - interval '10 minutes' WHERE id = ${job.id}::uuid`,
      )

      expect(await recoverStuck(db, 60_000)).toBe(1)
      expect((await repo.findById(job.id))?.status).toBe('queued')

      const claimed = await claimOutbox(db, [sessionId], 10)
      expect(claimed).toHaveLength(1)
    })

    it('does not touch a recent send', async () => {
      await enqueue('5511900000012@s.whatsapp.net', 'em curso')
      await claimOutbox(db, [sessionId], 1)

      expect(await recoverStuck(db, 60_000)).toBe(0)
    })
  })

  describe('inactive sessions', () => {
    it('claims nothing when the node has no active session', async () => {
      await enqueue('5511900000013@s.whatsapp.net', 'no owner')
      expect(await claimOutbox(db, [], 10)).toHaveLength(0)
    })

    it('ignores sends from sessions that are not on this node', async () => {
      await enqueue('5511900000014@s.whatsapp.net', 'from another session')
      const otherSession = await createSession(db, org.orgId)

      expect(await claimOutbox(db, [otherSession], 10)).toHaveLength(0)
    })
  })
})
