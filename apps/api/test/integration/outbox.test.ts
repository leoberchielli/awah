import { randomUUID } from 'node:crypto'
import { createDb, type Database, eq, schema, sql } from '@awah/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { claimOutbox, markFailed, markSent, recoverStuck, release } from '../../src/messaging/queue'
import { OutboxRepository } from '../../src/repos/outbox'
import { createSession, type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasInfra)('fila de envio', () => {
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

  describe('idempotência', () => {
    it('não duplica o mesmo clientMessageId', async () => {
      const id = randomUUID()
      const primeira = await enqueue('5511900000001@s.whatsapp.net', 'oi', id)
      const segunda = await enqueue('5511900000001@s.whatsapp.net', 'oi de novo', id)

      expect(primeira.created).toBe(true)
      expect(segunda.created).toBe(false)
      expect(segunda.row.id).toBe(primeira.row.id)

      const todos = await repo.list()
      expect(todos).toHaveLength(1)
    })

    /** O retry do cliente devolve a linha original, não a segunda tentativa. */
    it('devolve o envio original no reenvio', async () => {
      const id = randomUUID()
      await enqueue('5511900000002@s.whatsapp.net', 'texto original', id)
      const repetido = await enqueue('5511900000002@s.whatsapp.net', 'texto diferente', id)

      const persistido = await repo.findByClientId(id)
      expect(persistido?.id).toBe(repetido.row.id)
    })
  })

  describe('FIFO por chat', () => {
    /**
     * A garantia central da fila: dentro de uma conversa, a ordem é a de
     * chegada, e nunca há dois envios saindo ao mesmo tempo para o mesmo chat.
     */
    it('reserva apenas a cabeça da fila de cada chat', async () => {
      const chat = '5511911111111@s.whatsapp.net'
      const primeira = await enqueue(chat, 'mensagem 1')
      await enqueue(chat, 'mensagem 2')
      await enqueue(chat, 'mensagem 3')

      const reservados = await claimOutbox(db, [sessionId], 10)

      expect(reservados).toHaveLength(1)
      expect(reservados[0]?.id).toBe(primeira.row.id)
      expect(reservados[0]?.payload.text).toBe('mensagem 1')
    })

    it('não libera a próxima enquanto a anterior está saindo', async () => {
      const chat = '5511922222222@s.whatsapp.net'
      await enqueue(chat, 'primeira')
      await enqueue(chat, 'segunda')

      await claimOutbox(db, [sessionId], 10)
      // A primeira segue em 'sending'; o segundo ciclo não pode pegar nada.
      const segundoCiclo = await claimOutbox(db, [sessionId], 10)

      expect(segundoCiclo).toHaveLength(0)
    })

    it('libera a seguinte depois que a anterior conclui', async () => {
      const chat = '5511933333333@s.whatsapp.net'
      await enqueue(chat, 'primeira')
      const segunda = await enqueue(chat, 'segunda')

      const [reservada] = await claimOutbox(db, [sessionId], 10)
      if (!reservada) throw new Error('nada reservado')
      await markSent(db, reservada.id, 'ENGINE-1')

      const proximo = await claimOutbox(db, [sessionId], 10)
      expect(proximo).toHaveLength(1)
      expect(proximo[0]?.id).toBe(segunda.row.id)
    })

    /** Chats distintos não bloqueiam uns aos outros — é o paralelismo do §4.2. */
    it('reserva chats diferentes em paralelo', async () => {
      await enqueue('5511944444444@s.whatsapp.net', 'para A')
      await enqueue('5511955555555@s.whatsapp.net', 'para B')
      await enqueue('5511966666666@s.whatsapp.net', 'para C')

      const reservados = await claimOutbox(db, [sessionId], 10)
      expect(reservados).toHaveLength(3)
    })
  })

  describe('exclusividade entre workers', () => {
    it('não entrega o mesmo envio a dois consumidores', async () => {
      await enqueue('5511977777777@s.whatsapp.net', 'única')

      const [a, b] = await Promise.all([
        claimOutbox(db, [sessionId], 10),
        claimOutbox(db, [sessionId], 10),
      ])

      expect((a?.length ?? 0) + (b?.length ?? 0)).toBe(1)
    })
  })

  describe('retry e fila morta', () => {
    it('devolve à fila com espera e consome tentativa', async () => {
      await enqueue('5511988888888@s.whatsapp.net', 'vai falhar')
      const [job] = await claimOutbox(db, [sessionId], 1)
      if (!job) throw new Error('nada reservado')

      const resultado = await markFailed(db, job.id, 'timeout na engine', 60_000)
      expect(resultado).toBe('queued')

      const row = await repo.findById(job.id)
      expect(row?.attempts).toBe(1)
      expect(row?.lastError).toContain('timeout')
      expect(row?.availableAt.getTime()).toBeGreaterThan(Date.now() + 30_000)

      // Ainda não elegível: a espera precisa ser respeitada.
      expect(await claimOutbox(db, [sessionId], 10)).toHaveLength(0)
    })

    it('manda para a DLQ ao esgotar as tentativas', async () => {
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

      const morta = await repo.findById(row.id)
      expect(morta?.status).toBe('dead')
      expect(morta?.attempts).toBe(2)
    })

    it('reprocessa um envio morto zerando as tentativas', async () => {
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
      const revivida = await repo.findById(row.id)
      expect(revivida?.status).toBe('queued')
      expect(revivida?.attempts).toBe(0)
      expect(revivida?.lastError).toBeNull()
    })

    /** Sessão fora do ar não é falha de entrega: devolve sem consumir tentativa. */
    it('release não consome tentativa', async () => {
      await enqueue('5511900000010@s.whatsapp.net', 'sessão caiu')
      const [job] = await claimOutbox(db, [sessionId], 1)
      if (!job) throw new Error('nada reservado')

      await release(db, job.id, 0)
      const row = await repo.findById(job.id)

      expect(row?.status).toBe('queued')
      expect(row?.attempts).toBe(0)
    })
  })

  describe('recuperação de envios presos', () => {
    /**
     * Sem isto, um processo que morre no meio de um envio trava a fila daquele
     * chat para sempre: o claim continuaria enxergando um envio em curso que não
     * existe mais em lugar nenhum.
     */
    it('devolve à fila o que ficou preso em sending', async () => {
      await enqueue('5511900000011@s.whatsapp.net', 'órfã')
      const [job] = await claimOutbox(db, [sessionId], 1)
      if (!job) throw new Error('nada reservado')

      // Simula o processo tendo morrido há dez minutos.
      await db.execute(
        sql`UPDATE outbox_messages SET updated_at = now() - interval '10 minutes' WHERE id = ${job.id}::uuid`,
      )

      expect(await recoverStuck(db, 60_000)).toBe(1)
      expect((await repo.findById(job.id))?.status).toBe('queued')

      const reservado = await claimOutbox(db, [sessionId], 10)
      expect(reservado).toHaveLength(1)
    })

    it('não mexe em envio recente', async () => {
      await enqueue('5511900000012@s.whatsapp.net', 'em curso')
      await claimOutbox(db, [sessionId], 1)

      expect(await recoverStuck(db, 60_000)).toBe(0)
    })
  })

  describe('sessões inativas', () => {
    it('não reserva nada quando não há sessão ativa no nó', async () => {
      await enqueue('5511900000013@s.whatsapp.net', 'sem dono')
      expect(await claimOutbox(db, [], 10)).toHaveLength(0)
    })

    it('ignora envios de sessões que não são deste nó', async () => {
      await enqueue('5511900000014@s.whatsapp.net', 'de outra sessão')
      const outraSessao = await createSession(db, org.orgId)

      expect(await claimOutbox(db, [outraSessao], 10)).toHaveLength(0)
    })
  })
})
