import { randomUUID } from 'node:crypto'
import { createDb, type Database, eq, schema } from '@awah/db'
import Redis from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BudgetTracker } from '../../src/risk/budget'
import { RiskEngine } from '../../src/risk/engine'
import { DEFAULT_LIMITS } from '../../src/risk/limits'
import { createSession, type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

describe.skipIf(!hasInfra)('risk engine', () => {
  let handle: ReturnType<typeof createDb>
  let db: Database
  let redis: Redis
  let org: SeededOrg
  let sessionId: string

  /** Controlled clock: a sliding window without waiting real minutes. */
  let nowMs = new Date('2026-08-18T12:00:00Z').getTime()
  const now = () => nowMs

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
    nowMs = new Date('2026-08-18T12:00:00Z').getTime()
    await budget.reset(sessionId)
  })

  describe('sliding window', () => {
    it('counts the sends in each window', async () => {
      await budget.record(sessionId, 'a@s.whatsapp.net', false)
      await budget.record(sessionId, 'b@s.whatsapp.net', false)

      const usage = await budget.usage(sessionId)
      expect(usage.minute).toBe(2)
      expect(usage.hour).toBe(2)
      expect(usage.day).toBe(2)
    })

    /**
     * The point of a sliding window instead of a whole-hour bucket: what went
     * out more than a minute ago stops counting in the minute, but stays in the
     * hour.
     */
    it('forgets what left the window as time passes', async () => {
      await budget.record(sessionId, 'a@s.whatsapp.net', false)

      nowMs += 61_000
      const usage = await budget.usage(sessionId)

      expect(usage.minute).toBe(0)
      expect(usage.hour).toBe(1)
      expect(usage.day).toBe(1)
    })

    it('counts new contacts separately', async () => {
      await budget.record(sessionId, 'novo@s.whatsapp.net', true)
      await budget.record(sessionId, 'conhecido@s.whatsapp.net', false)

      const usage = await budget.usage(sessionId)
      expect(usage.day).toBe(2)
      expect(usage.newContactsToday).toBe(1)
    })
  })

  describe('cap check', () => {
    it('allows while there is room', async () => {
      const verdict = await budget.check(sessionId, DEFAULT_LIMITS, false)
      expect(verdict.exceeded).toBeNull()
      expect(verdict.availableAt).toBeNull()
    })

    it('holds when the minute window fills up', async () => {
      const limits = { ...DEFAULT_LIMITS, perMinute: 3 }
      for (let i = 0; i < 3; i++) {
        await budget.record(sessionId, `c${i}@s.whatsapp.net`, false)
      }

      const verdict = await budget.check(sessionId, limits, false)
      expect(verdict.exceeded).toBe('minute')
      expect(verdict.availableAt).not.toBeNull()
    })

    /**
     * The ETA has to be real, not a guess: it is the instant the oldest send
     * leaves the window. That is what lets the panel say "goes out at 14:03"
     * instead of "try again later".
     */
    it('computes the ETA from the oldest send in the window', async () => {
      const limits = { ...DEFAULT_LIMITS, perMinute: 2 }
      await budget.record(sessionId, 'a@s.whatsapp.net', false)
      nowMs += 20_000
      await budget.record(sessionId, 'b@s.whatsapp.net', false)

      const verdict = await budget.check(sessionId, limits, false)
      // The first landed 20 s ago: the slot opens 40 s from now.
      const expected = nowMs + 40_000
      expect(verdict.availableAt?.getTime()).toBe(expected)
    })

    it('holds for a new contact without blocking an existing conversation', async () => {
      const limits = { ...DEFAULT_LIMITS, newContactsPerDay: 1 }
      await budget.record(sessionId, 'primeiro@s.whatsapp.net', true)

      const toNew = await budget.check(sessionId, limits, true)
      const toKnown = await budget.check(sessionId, limits, false)

      expect(toNew.exceeded).toBe('newContactsToday')
      // Anyone already in a conversation with the session keeps being served.
      expect(toKnown.exceeded).toBeNull()
    })
  })

  describe('contact recognition', () => {
    it('treats a never-seen recipient as new', async () => {
      expect(await budget.isKnownContact(sessionId, 'inedito@s.whatsapp.net')).toBe(false)
    })

    it('recognises someone who has already received a send', async () => {
      await budget.record(sessionId, 'ja-falei@s.whatsapp.net', true)
      expect(await budget.isKnownContact(sessionId, 'ja-falei@s.whatsapp.net')).toBe(true)
    })

    /**
     * Redis is a cache, not the source of truth. Without the Postgres fallback,
     * a restart would make the whole contact base look new, and the daily cap
     * would freeze someone who is only replying to old conversations.
     */
    it('recovers from Postgres when the cache was lost', async () => {
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

  describe('engine decision', () => {
    it('allows a normal send with jitter', async () => {
      const engine = new RiskEngine({ db, budget, now })
      const decision = await engine.evaluate({
        sessionId,
        chatId: 'someone@s.whatsapp.net',
        textLength: 20,
      })

      expect(['delayed', 'throttled']).toContain(decision.action)
      expect(decision.delayMs).toBeGreaterThan(0)
      expect(decision.typingMs).toBeGreaterThan(0)
    })

    /** Never dropped: held with a time on it, and the reason comes back in words. */
    it('holds when the budget ran out, without losing the message', async () => {
      await db
        .update(schema.sessions)
        .set({ config: { limits: { perMinute: 1 } }, pairedAt: new Date('2026-01-01') })
        .where(eq(schema.sessions.id, sessionId))

      await budget.record(sessionId, 'ja@s.whatsapp.net', false)

      const engine = new RiskEngine({ db, budget, now })
      const decision = await engine.evaluate({
        sessionId,
        chatId: 'other@s.whatsapp.net',
        textLength: 10,
      })

      expect(decision.action).toBe('held')
      expect(decision.availableAt).not.toBeNull()
      expect(decision.reason).toMatch(/per minute/i)
    })

    it('an explicit override goes over the cap', async () => {
      await budget.record(sessionId, 'ja@s.whatsapp.net', false)

      const engine = new RiskEngine({ db, budget, now })
      const decision = await engine.evaluate({
        sessionId,
        chatId: 'urgente@s.whatsapp.net',
        textLength: 10,
        bypass: true,
      })

      expect(decision.action).toBe('allowed')
      expect(decision.delayMs).toBe(0)
      expect(decision.reason).toMatch(/override/i)
    })

    it('switched off, it releases everything right away', async () => {
      const engine = new RiskEngine({ db, budget, now, enabled: false })
      const decision = await engine.evaluate({
        sessionId,
        chatId: 'qualquer@s.whatsapp.net',
        textLength: 10,
      })

      expect(decision.action).toBe('allowed')
      expect(decision.delayMs).toBe(0)
    })

    it('the snapshot carries score, usage and limits with warm-up already applied', async () => {
      await db
        .update(schema.sessions)
        .set({ config: {}, pairedAt: new Date(nowMs - 24 * 60 * 60 * 1000) })
        .where(eq(schema.sessions.id, sessionId))

      const engine = new RiskEngine({ db, budget, now })
      const snapshot = await engine.snapshot(sessionId)

      expect(snapshot).not.toBeNull()
      expect(snapshot?.ageInDays).toBeCloseTo(1, 1)
      // One day of age unlocks 10% of the cap.
      expect(snapshot?.warmupFactor).toBeCloseTo(0.1, 2)
      expect(snapshot?.limits.perDay).toBeLessThan(DEFAULT_LIMITS.perDay)
      expect(snapshot?.score.factors).toHaveLength(4)
    })
  })
})
