import { randomUUID } from 'node:crypto'
import { createDb, type Database, eq, schema } from '@awah/db'
import Redis from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BudgetTracker } from '../../src/risk/budget'
import { RiskEngine } from '../../src/risk/engine'
import { DEFAULT_LIMITS } from '../../src/risk/limits'
import { createSession, type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

describe.skipIf(!hasInfra)('motor de risco', () => {
  let handle: ReturnType<typeof createDb>
  let db: Database
  let redis: Redis
  let org: SeededOrg
  let sessionId: string

  /** Relógio controlado: janela deslizante sem esperar minutos de verdade. */
  let agora = new Date('2026-08-18T12:00:00Z').getTime()
  const now = () => agora

  let budget: BudgetTracker

  beforeAll(async () => {
    handle = createDb({ url: process.env.DATABASE_URL as string, max: 3 })
    db = handle.db
    redis = new Redis(process.env.REDIS_URL as string)
    org = await seedOrg(db)
    sessionId = await createSession(db, org.orgId)
    budget = new BudgetTracker(redis, db, now)
  })

  afterAll(async () => {
    await budget?.reset(sessionId)
    await org?.cleanup()
    await handle?.close()
    await redis?.quit()
  })

  beforeEach(async () => {
    agora = new Date('2026-08-18T12:00:00Z').getTime()
    await budget.reset(sessionId)
  })

  describe('janela deslizante', () => {
    it('conta os envios de cada janela', async () => {
      await budget.record(sessionId, 'a@s.whatsapp.net', false)
      await budget.record(sessionId, 'b@s.whatsapp.net', false)

      const uso = await budget.usage(sessionId)
      expect(uso.minute).toBe(2)
      expect(uso.hour).toBe(2)
      expect(uso.day).toBe(2)
    })

    /**
     * O ponto de usar janela deslizante e não balde de hora cheia: o que saiu há
     * mais de um minuto deixa de contar no minuto, mas continua na hora.
     */
    it('esquece o que saiu da janela conforme o tempo passa', async () => {
      await budget.record(sessionId, 'a@s.whatsapp.net', false)

      agora += 61_000
      const uso = await budget.usage(sessionId)

      expect(uso.minute).toBe(0)
      expect(uso.hour).toBe(1)
      expect(uso.day).toBe(1)
    })

    it('conta contatos novos separadamente', async () => {
      await budget.record(sessionId, 'novo@s.whatsapp.net', true)
      await budget.record(sessionId, 'conhecido@s.whatsapp.net', false)

      const uso = await budget.usage(sessionId)
      expect(uso.day).toBe(2)
      expect(uso.newContactsToday).toBe(1)
    })
  })

  describe('verificação de teto', () => {
    it('libera enquanto há vaga', async () => {
      const verdict = await budget.check(sessionId, DEFAULT_LIMITS, false)
      expect(verdict.exceeded).toBeNull()
      expect(verdict.availableAt).toBeNull()
    })

    it('segura quando a janela do minuto enche', async () => {
      const limites = { ...DEFAULT_LIMITS, perMinute: 3 }
      for (let i = 0; i < 3; i++) {
        await budget.record(sessionId, `c${i}@s.whatsapp.net`, false)
      }

      const verdict = await budget.check(sessionId, limites, false)
      expect(verdict.exceeded).toBe('minute')
      expect(verdict.availableAt).not.toBeNull()
    })

    /**
     * A ETA precisa ser real, não um palpite: é o instante em que o envio mais
     * antigo sai da janela. É isso que permite mostrar "sai às 14h03" em vez de
     * "tente de novo depois".
     */
    it('calcula a ETA a partir do envio mais antigo da janela', async () => {
      const limites = { ...DEFAULT_LIMITS, perMinute: 2 }
      await budget.record(sessionId, 'a@s.whatsapp.net', false)
      agora += 20_000
      await budget.record(sessionId, 'b@s.whatsapp.net', false)

      const verdict = await budget.check(sessionId, limites, false)
      // O primeiro entrou 20 s atrás: a vaga abre 40 s à frente.
      const esperado = agora + 40_000
      expect(verdict.availableAt?.getTime()).toBe(esperado)
    })

    it('segura por contato novo sem bloquear conversa existente', async () => {
      const limites = { ...DEFAULT_LIMITS, newContactsPerDay: 1 }
      await budget.record(sessionId, 'primeiro@s.whatsapp.net', true)

      const paraNovo = await budget.check(sessionId, limites, true)
      const paraConhecido = await budget.check(sessionId, limites, false)

      expect(paraNovo.exceeded).toBe('newContactsToday')
      // Quem já conversa com a sessão continua sendo atendido.
      expect(paraConhecido.exceeded).toBeNull()
    })
  })

  describe('reconhecimento de contato', () => {
    it('trata destinatário inédito como novo', async () => {
      expect(await budget.isKnownContact(sessionId, 'inedito@s.whatsapp.net')).toBe(false)
    })

    it('reconhece quem já recebeu envio', async () => {
      await budget.record(sessionId, 'ja-falei@s.whatsapp.net', true)
      expect(await budget.isKnownContact(sessionId, 'ja-falei@s.whatsapp.net')).toBe(true)
    })

    /**
     * O Redis é cache, não fonte de verdade. Sem o fallback ao Postgres, um
     * restart faria a base inteira de contatos parecer nova e o teto diário
     * travaria quem só está respondendo conversas antigas.
     */
    it('recupera do Postgres quando o cache foi perdido', async () => {
      const chatId = 'historico@s.whatsapp.net'
      await db.insert(schema.messages).values({
        orgId: org.orgId,
        sessionId,
        chatId,
        engineMessageId: randomUUID(),
        direction: 'outbound',
        type: 'text',
        status: 'sent',
        occurredAt: new Date(),
      })

      await budget.reset(sessionId)
      expect(await budget.isKnownContact(sessionId, chatId)).toBe(true)
    })
  })

  describe('decisão do motor', () => {
    it('libera envio normal com jitter', async () => {
      const engine = new RiskEngine({ db, budget, now })
      const decisao = await engine.evaluate({
        sessionId,
        chatId: 'alguem@s.whatsapp.net',
        textLength: 20,
      })

      expect(['delayed', 'throttled']).toContain(decisao.action)
      expect(decisao.delayMs).toBeGreaterThan(0)
      expect(decisao.typingMs).toBeGreaterThan(0)
    })

    /** Nunca descarta: segura com hora marcada e devolve o motivo em português. */
    it('segura quando o orçamento acabou, sem perder a mensagem', async () => {
      await db
        .update(schema.sessions)
        .set({ config: { limits: { perMinute: 1 } }, pairedAt: new Date('2026-01-01') })
        .where(eq(schema.sessions.id, sessionId))

      await budget.record(sessionId, 'ja@s.whatsapp.net', false)

      const engine = new RiskEngine({ db, budget, now })
      const decisao = await engine.evaluate({
        sessionId,
        chatId: 'outro@s.whatsapp.net',
        textLength: 10,
      })

      expect(decisao.action).toBe('held')
      expect(decisao.availableAt).not.toBeNull()
      expect(decisao.reason).toMatch(/per minute/i)
    })

    it('o override explícito passa por cima do teto', async () => {
      await budget.record(sessionId, 'ja@s.whatsapp.net', false)

      const engine = new RiskEngine({ db, budget, now })
      const decisao = await engine.evaluate({
        sessionId,
        chatId: 'urgente@s.whatsapp.net',
        textLength: 10,
        bypass: true,
      })

      expect(decisao.action).toBe('allowed')
      expect(decisao.delayMs).toBe(0)
      expect(decisao.reason).toMatch(/override/i)
    })

    it('desligado, libera tudo na hora', async () => {
      const engine = new RiskEngine({ db, budget, now, enabled: false })
      const decisao = await engine.evaluate({
        sessionId,
        chatId: 'qualquer@s.whatsapp.net',
        textLength: 10,
      })

      expect(decisao.action).toBe('allowed')
      expect(decisao.delayMs).toBe(0)
    })

    it('o retrato traz score, uso e limites já com warmup', async () => {
      await db
        .update(schema.sessions)
        .set({ config: {}, pairedAt: new Date(agora - 24 * 60 * 60 * 1000) })
        .where(eq(schema.sessions.id, sessionId))

      const engine = new RiskEngine({ db, budget, now })
      const snapshot = await engine.snapshot(sessionId)

      expect(snapshot).not.toBeNull()
      expect(snapshot?.ageInDays).toBeCloseTo(1, 1)
      // Um dia de idade libera 10% do teto.
      expect(snapshot?.warmupFactor).toBeCloseTo(0.1, 2)
      expect(snapshot?.limits.perDay).toBeLessThan(DEFAULT_LIMITS.perDay)
      expect(snapshot?.score.factors).toHaveLength(4)
    })
  })
})
