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
}

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
    const agora = this.now()
    const sent = this.sentKey(sessionId)

    const [minute, hour, day, newContactsToday] = await Promise.all([
      this.redis.zcount(sent, agora - MINUTE, '+inf'),
      this.redis.zcount(sent, agora - HOUR, '+inf'),
      this.redis.zcount(sent, agora - DAY, '+inf'),
      this.redis.zcount(this.newContactsKey(sessionId), agora - DAY, '+inf'),
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
      }
    }

    if (usage.minute >= limits.perMinute) {
      return {
        exceeded: 'minute',
        usage,
        availableAt: await this.windowOpensAt(this.sentKey(sessionId), MINUTE),
      }
    }

    if (usage.hour >= limits.perHour) {
      return {
        exceeded: 'hour',
        usage,
        availableAt: await this.windowOpensAt(this.sentKey(sessionId), HOUR),
      }
    }

    if (usage.day >= limits.perDay) {
      return {
        exceeded: 'day',
        usage,
        availableAt: await this.windowOpensAt(this.sentKey(sessionId), DAY),
      }
    }

    return { exceeded: null, usage, availableAt: null }
  }

  /**
   * When the window has a free slot again: the instant the oldest entry inside
   * it leaves. Returning this — and not a fixed delay — is what lets us show an
   * honest ETA on the dashboard instead of "try again later".
   */
  private async windowOpensAt(key: string, windowMs: number): Promise<Date> {
    const agora = this.now()

    // The oldest entry still inside the window; when it leaves, a slot opens.
    const maisAntigo = await this.redis.zrangebyscore(
      key,
      agora - windowMs,
      '+inf',
      'WITHSCORES',
      'LIMIT',
      0,
      1,
    )

    const score = maisAntigo[1]
    if (!score) return new Date(agora + 1000)

    const expira = Number(score) + windowMs
    // A short floor avoids a tight re-evaluation loop when a slot is imminent.
    return new Date(Math.max(expira, agora + 250))
  }

  /** Records the send in the windows. Called after successful delivery. */
  async record(sessionId: string, chatId: string, isNewContact: boolean): Promise<void> {
    const agora = this.now()
    const sent = this.sentKey(sessionId)
    const pipeline = this.redis.pipeline()

    pipeline.zadd(sent, agora, `${agora}:${chatId}`)
    // Prunes what left the largest window, so the ZSET cannot grow forever.
    pipeline.zremrangebyscore(sent, '-inf', agora - DAY)
    pipeline.expire(sent, KEY_TTL_SECONDS)

    if (isNewContact) {
      const novos = this.newContactsKey(sessionId)
      pipeline.zadd(novos, agora, chatId)
      pipeline.zremrangebyscore(novos, '-inf', agora - DAY)
      pipeline.expire(novos, KEY_TTL_SECONDS)
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
