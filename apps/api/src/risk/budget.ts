import { randomUUID } from 'node:crypto'
import { and, type Database, eq, schema } from '@awah/db'
import type Redis from 'ioredis'
import type { SessionLimits } from './limits'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Outlives the 24 h window with room to spare; dead sessions do not leak. */
const KEY_TTL_SECONDS = 26 * 60 * 60

export interface BudgetUsage {
  minute: number
  hour: number
  day: number
  newContactsToday: number
}

export interface BudgetVerdict {
  /** The window that is full, or null when a slot is free. */
  exceeded: keyof BudgetUsage | null
  usage: BudgetUsage
  /** When the full window opens. Null when nothing is blocking. */
  availableAt: Date | null
  /**
   * The slot this send is holding, to be released if it never goes out.
   *
   * Null when the budget refused, and null on the read-only `check` path.
   */
  reservation: string | null
}

/**
 * Reserve a slot in every window at once, or refuse — with nothing in between.
 *
 * This exists because the obvious shape does not work. Reading the counters,
 * deciding, and recording the send after it lands leaves a gap the width of an
 * entire delivery: the typing indicator, the human jitter of several seconds,
 * and the round trip to WhatsApp. With fifty workers running in parallel, every
 * one of them reads the same empty window inside that gap and every one of them
 * is allowed through. A benchmark caught a session capped at one message per
 * minute sending twenty-six in twenty seconds.
 *
 * Redis runs a script to completion before serving anything else, so counting
 * and reserving inside one becomes a single indivisible step and the cap holds
 * no matter how many workers ask at the same instant.
 *
 * KEYS: the sends window, the new-contacts window.
 * ARGV: now, minute/hour/day spans, the four limits, whether the recipient is
 *       new, the member to store, the chat id, the key TTL.
 * Returns: the exceeded window (empty when allowed) plus the four counts, read
 *          before the reservation so the reported usage is what the decision
 *          was actually made on.
 */
const RESERVE_SCRIPT = `
local sent, fresh = KEYS[1], KEYS[2]
local now = tonumber(ARGV[1])
local minuteMs, hourMs, dayMs = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local perMinute, perHour, perDay = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
local newPerDay = tonumber(ARGV[8])
local isNew = tonumber(ARGV[9])
local member, chatId, ttl = ARGV[10], ARGV[11], tonumber(ARGV[12])

-- Pruning first, so a long-idle session is not judged on entries that have
-- already left the largest window.
redis.call('ZREMRANGEBYSCORE', sent, '-inf', now - dayMs)
redis.call('ZREMRANGEBYSCORE', fresh, '-inf', now - dayMs)

local minute = redis.call('ZCOUNT', sent, now - minuteMs, '+inf')
local hour = redis.call('ZCOUNT', sent, now - hourMs, '+inf')
local day = redis.call('ZCOUNT', sent, now - dayMs, '+inf')
local newToday = redis.call('ZCOUNT', fresh, now - dayMs, '+inf')

-- Same order as the report: the most restrictive window is named first, so the
-- ETA handed back is the one that actually applies.
local exceeded = ''
if isNew == 1 and newToday >= newPerDay then
  exceeded = 'newContactsToday'
elseif minute >= perMinute then
  exceeded = 'minute'
elseif hour >= perHour then
  exceeded = 'hour'
elseif day >= perDay then
  exceeded = 'day'
end

if exceeded == '' then
  redis.call('ZADD', sent, now, member)
  redis.call('EXPIRE', sent, ttl)
  if isNew == 1 then
    redis.call('ZADD', fresh, now, chatId)
    redis.call('EXPIRE', fresh, ttl)
  end
end

return { exceeded, minute, hour, day, newToday }
`

/**
 * Sliding-window send counters.
 *
 * A sliding window and not a bucket per clock hour: a bucket would let you send
 * the whole cap at 13:59 and the whole cap again at 14:00, which is precisely
 * the burst we are trying to avoid. The ZSET stores the instant of every send
 * and the count asks "how many in the last N seconds".
 *
 * It lives in Redis because it is read on the hot path of every send, and
 * because from wave 4 on several replicas share the same per-session budget.
 */
export class BudgetTracker {
  constructor(
    private readonly redis: Redis,
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  private sentKey(sessionId: string): string {
    return `awah:risk:${sessionId}:sent`
  }

  private newContactsKey(sessionId: string): string {
    return `awah:risk:${sessionId}:new-contacts`
  }

  private contactsKey(sessionId: string): string {
    return `awah:risk:${sessionId}:contacts`
  }

  async usage(sessionId: string): Promise<BudgetUsage> {
    const nowMs = this.now()
    const sent = this.sentKey(sessionId)

    const [minute, hour, day, newContactsToday] = await Promise.all([
      this.redis.zcount(sent, nowMs - MINUTE, '+inf'),
      this.redis.zcount(sent, nowMs - HOUR, '+inf'),
      this.redis.zcount(sent, nowMs - DAY, '+inf'),
      this.redis.zcount(this.newContactsKey(sessionId), nowMs - DAY, '+inf'),
    ])

    return { minute, hour, day, newContactsToday }
  }

  /**
   * Checks the windows against the limits already adjusted by warm-up.
   *
   * Order matters: it reports the most restrictive window first, so the ETA
   * handed back to the user is the one that actually applies.
   */
  async check(
    sessionId: string,
    limits: SessionLimits,
    isNewContact: boolean,
  ): Promise<BudgetVerdict> {
    const usage = await this.usage(sessionId)

    if (isNewContact && usage.newContactsToday >= limits.newContactsPerDay) {
      return {
        exceeded: 'newContactsToday',
        usage,
        availableAt: await this.windowOpensAt(this.newContactsKey(sessionId), DAY),
        reservation: null,
      }
    }

    if (usage.minute >= limits.perMinute) {
      return {
        exceeded: 'minute',
        usage,
        availableAt: await this.windowOpensAt(this.sentKey(sessionId), MINUTE),
        reservation: null,
      }
    }

    if (usage.hour >= limits.perHour) {
      return {
        exceeded: 'hour',
        usage,
        availableAt: await this.windowOpensAt(this.sentKey(sessionId), HOUR),
        reservation: null,
      }
    }

    if (usage.day >= limits.perDay) {
      return {
        exceeded: 'day',
        usage,
        availableAt: await this.windowOpensAt(this.sentKey(sessionId), DAY),
        reservation: null,
      }
    }

    return { exceeded: null, usage, availableAt: null, reservation: null }
  }

  /**
   * Takes a slot if every window has one, atomically.
   *
   * This is what the send path calls. `check` stays for the dashboard, which
   * only reports and must not consume anything by looking.
   */
  async reserve(
    sessionId: string,
    limits: SessionLimits,
    isNewContact: boolean,
    chatId: string,
  ): Promise<BudgetVerdict> {
    const nowMs = this.now()
    const sent = this.sentKey(sessionId)
    const fresh = this.newContactsKey(sessionId)

    /*
     * The member has to be unique per send. Keying it by instant and chat alone
     * would make two sends to the same conversation in the same millisecond a
     * single ZSET entry, and the budget would undercount exactly when traffic
     * is heaviest.
     */
    const member = `${nowMs}:${chatId}:${randomUUID()}`

    const raw = (await this.redis.eval(
      RESERVE_SCRIPT,
      2,
      sent,
      fresh,
      String(nowMs),
      String(MINUTE),
      String(HOUR),
      String(DAY),
      String(limits.perMinute),
      String(limits.perHour),
      String(limits.perDay),
      String(limits.newContactsPerDay),
      isNewContact ? '1' : '0',
      member,
      chatId,
      String(KEY_TTL_SECONDS),
    )) as [string, number, number, number, number]

    const [exceeded, minute, hour, day, newContactsToday] = raw
    const usage: BudgetUsage = { minute, hour, day, newContactsToday }

    if (exceeded === '') {
      return { exceeded: null, usage, availableAt: null, reservation: member }
    }

    const key = exceeded === 'newContactsToday' ? fresh : sent
    const span = exceeded === 'minute' ? MINUTE : exceeded === 'hour' ? HOUR : DAY

    return {
      exceeded: exceeded as keyof BudgetUsage,
      usage,
      availableAt: await this.windowOpensAt(key, span),
      reservation: null,
    }
  }

  /**
   * Gives a reserved slot back.
   *
   * A send that was refused by the engine, or that never left because the
   * session dropped mid-jitter, must not spend budget — otherwise a number
   * having a bad afternoon quietly loses its whole daily allowance to messages
   * that never reached anybody.
   */
  async release(sessionId: string, reservation: string, isNewContact: boolean, chatId: string) {
    const pipeline = this.redis.pipeline()
    pipeline.zrem(this.sentKey(sessionId), reservation)
    /*
     * The new-contact entry only comes back if this send is the reason it is
     * there. A second message to the same recipient may already have landed and
     * made the contact genuinely known, and removing the mark then would let
     * the daily cap be spent twice on one person.
     */
    if (isNewContact) {
      pipeline.sismember(this.contactsKey(sessionId), chatId)
    }
    const results = await pipeline.exec()

    if (isNewContact && results?.[1]?.[1] === 0) {
      await this.redis.zrem(this.newContactsKey(sessionId), chatId)
    }
  }

  /**
   * When the window has a free slot again: the instant the oldest entry inside
   * it leaves. Returning this — and not a fixed delay — is what lets us show an
   * honest ETA on the dashboard instead of "try again later".
   */
  private async windowOpensAt(key: string, windowMs: number): Promise<Date> {
    const nowMs = this.now()

    // The oldest entry still inside the window; when it leaves, a slot opens.
    const oldest = await this.redis.zrangebyscore(
      key,
      nowMs - windowMs,
      '+inf',
      'WITHSCORES',
      'LIMIT',
      0,
      1,
    )

    const score = oldest[1]
    if (!score) return new Date(nowMs + 1000)

    const expiresAt = Number(score) + windowMs
    // A short floor avoids a tight re-evaluation loop when a slot is imminent.
    return new Date(Math.max(expiresAt, nowMs + 250))
  }

  /**
   * Confirms a delivered send.
   *
   * When the send came through `reserve`, the windows were already written at
   * decision time and all that is left is to remember the contact. The
   * `reserved` flag is false only on the paths that skip the budget entirely —
   * the engine switched off, or an explicit client override — and there the
   * write still has to happen here, or those sends would be invisible to every
   * window and to the score built on top of them.
   */
  async record(
    sessionId: string,
    chatId: string,
    isNewContact: boolean,
    reserved = false,
  ): Promise<void> {
    const nowMs = this.now()
    const pipeline = this.redis.pipeline()

    if (!reserved) {
      const sent = this.sentKey(sessionId)
      pipeline.zadd(sent, nowMs, `${nowMs}:${chatId}:${randomUUID()}`)
      // Prunes what left the largest window, so the ZSET cannot grow forever.
      pipeline.zremrangebyscore(sent, '-inf', nowMs - DAY)
      pipeline.expire(sent, KEY_TTL_SECONDS)

      if (isNewContact) {
        const fresh = this.newContactsKey(sessionId)
        pipeline.zadd(fresh, nowMs, chatId)
        pipeline.zremrangebyscore(fresh, '-inf', nowMs - DAY)
        pipeline.expire(fresh, KEY_TTL_SECONDS)
      }
    }

    pipeline.sadd(this.contactsKey(sessionId), chatId)
    pipeline.expire(this.contactsKey(sessionId), KEY_TTL_SECONDS)

    await pipeline.exec()
  }

  /**
   * Whether this session has already exchanged a message with the recipient.
   *
   * Redis is a cache, not the source of truth: a miss goes to Postgres and
   * repopulates. Without that fallback, a Redis restart would make the entire
   * contact base look new, and the daily cap on new contacts would lock up an
   * operation that is only replying to old conversations.
   */
  async isKnownContact(sessionId: string, chatId: string): Promise<boolean> {
    const cached = await this.redis.sismember(this.contactsKey(sessionId), chatId)
    if (cached === 1) return true

    const [existing] = await this.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.sessionId, sessionId), eq(schema.messages.chatId, chatId)))
      .limit(1)

    if (!existing) return false

    await this.redis.sadd(this.contactsKey(sessionId), chatId)
    await this.redis.expire(this.contactsKey(sessionId), KEY_TTL_SECONDS)
    return true
  }

  /** Zeroes a session's counters. Used on logout and in tests. */
  async reset(sessionId: string): Promise<void> {
    await this.redis.del(
      this.sentKey(sessionId),
      this.newContactsKey(sessionId),
      this.contactsKey(sessionId),
    )
  }
}
