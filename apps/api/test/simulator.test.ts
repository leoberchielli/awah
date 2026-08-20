import { describe, expect, it, vi } from 'vitest'
import { SimulatorAdapter } from '../src/engines/simulator/adapter'
import {
  DEFAULT_SCENARIO,
  SCENARIOS,
  type Scenario,
  scenarioForSessionName,
} from '../src/engines/simulator/scenario'
import type { EngineEvent } from '../src/engines/types'

/**
 * The simulator is the only engine whose job is to lie, so it is also the one
 * whose behaviour has to be pinned hardest: a fake that quietly stops failing
 * turns every test above it into a test of the happy path only, and does it
 * without anything going red.
 */

function collect(scenario: Partial<Scenario>, seed = 1) {
  const events: EngineEvent[] = []
  const adapter = new SimulatorAdapter({
    sessionId: '00000000-0000-4000-8000-000000000001',
    onEvent: (event) => events.push(event),
    scenario,
    seed,
  })
  return { adapter, events }
}

const statuses = (events: EngineEvent[]) =>
  events.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status)

describe('simulator engine', () => {
  describe('connecting', () => {
    it('reaches connected and reports itself ready', async () => {
      const { adapter, events } = collect({ pairingMs: 0, meanUptimeMs: 0, inboundPerMinute: 0 })
      await adapter.connect()

      expect(statuses(events)).toEqual(['connecting', 'connected'])
      expect(events.some((e) => e.type === 'paired')).toBe(true)
      expect(adapter.isReady()).toBe(true)
    })

    it('shows a QR while pairing, and drops it once paired', async () => {
      vi.useFakeTimers()
      try {
        const { adapter, events } = collect({
          pairingMs: 50,
          meanUptimeMs: 0,
          inboundPerMinute: 0,
        })
        const connecting = adapter.connect()

        await vi.advanceTimersByTimeAsync(1)
        expect(adapter.currentQr()).toMatch(/^simulator:/)
        expect(events.some((e) => e.type === 'qr')).toBe(true)

        await vi.advanceTimersByTimeAsync(60)
        await connecting
        expect(adapter.currentQr()).toBeNull()
        expect(statuses(events)).toEqual(['connecting', 'pairing', 'connected'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('refuses to send before it is connected', async () => {
      const { adapter } = collect({})
      await expect(adapter.sendText('5511999999999@s.whatsapp.net', 'hi')).rejects.toThrow(
        /not connected/i,
      )
    })
  })

  describe('the delivery funnel', () => {
    it('acknowledges sent, then delivered, then read — in that order', async () => {
      vi.useFakeTimers()
      try {
        const { adapter, events } = collect({
          ...SCENARIOS.perfect,
          pairingMs: 0,
          medianLatencyMs: 100,
          latencySigma: 0.01,
        })
        await adapter.connect()
        await adapter.sendText('5511999999999@s.whatsapp.net', 'hi')

        await vi.advanceTimersByTimeAsync(5_000)

        const acks = events
          .filter((e) => e.type === 'message.status')
          .map((e) => (e as { status: string }).status)
        expect(acks).toEqual(['sent', 'delivered', 'read'])
      } finally {
        vi.useRealTimers()
      }
    })

    /**
     * The case the dashboard exists to surface. A gateway that always delivers
     * makes the funnel a straight line, and a straight line hides the exact
     * failure an operator needs to see: messages leaving and never landing.
     */
    it('leaves a share of messages sent and never delivered', async () => {
      vi.useFakeTimers()
      try {
        const { adapter, events } = collect({ ...SCENARIOS.silent, pairingMs: 0 })
        await adapter.connect()
        for (let i = 0; i < 5; i++) {
          await adapter.sendText(`551199999000${i}@s.whatsapp.net`, 'hi')
        }
        await vi.advanceTimersByTimeAsync(60_000)

        const acks = events
          .filter((e) => e.type === 'message.status')
          .map((e) => (e as { status: string }).status)
        expect(acks).toHaveLength(5)
        expect(new Set(acks)).toEqual(new Set(['sent']))
      } finally {
        vi.useRealTimers()
      }
    })

    it('fails outright often enough to exercise retry', async () => {
      const { adapter } = collect({ sendFailureRate: 1, pairingMs: 0, meanUptimeMs: 0 })
      await adapter.connect()
      await expect(adapter.sendText('5511999999999@s.whatsapp.net', 'hi')).rejects.toThrow()
    })

    it('gives every message its own engine id', async () => {
      const { adapter } = collect({ ...SCENARIOS.perfect, pairingMs: 0 })
      await adapter.connect()

      const ids = new Set<string>()
      for (let i = 0; i < 20; i++) {
        const sent = await adapter.sendText('5511999999999@s.whatsapp.net', 'hi')
        ids.add(sent.engineMessageId)
      }
      expect(ids.size).toBe(20)
    })
  })

  describe('inbound traffic', () => {
    /**
     * Without messages coming the other way the risk engine's new-contact
     * signal never moves and the integrations never fire, which is to say the
     * two things hardest to test would stay untested.
     */
    it('receives messages, some of them from numbers never seen before', async () => {
      vi.useFakeTimers()
      try {
        const { adapter, events } = collect({
          pairingMs: 0,
          meanUptimeMs: 0,
          inboundPerMinute: 600,
          newContactRate: 0.5,
        })
        await adapter.connect()
        await vi.advanceTimersByTimeAsync(60_000)

        const inbound = events.filter((e) => e.type === 'message.received')
        expect(inbound.length).toBeGreaterThan(5)
        expect(inbound.every((e) => (e as { fromMe: boolean }).fromMe)).toBe(false)

        const chats = new Set(inbound.map((e) => (e as { chatId: string }).chatId))
        expect(chats.size).toBeGreaterThan(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('dropping', () => {
    it('closes with a code from the real disconnect table', async () => {
      vi.useFakeTimers()
      try {
        const { adapter, events } = collect({
          pairingMs: 0,
          inboundPerMinute: 0,
          meanUptimeMs: 1_000,
        })
        await adapter.connect()
        await vi.advanceTimersByTimeAsync(120_000)

        const closed = events.find((e) => e.type === 'closed') as
          | { rawCode: number | null; loggedOut: boolean; shouldReconnect: boolean }
          | undefined
        expect(closed).toBeDefined()
        expect([401, 408, 428, 515]).toContain(closed?.rawCode)
        // A logout must never be retried; anything else must.
        expect(closed?.shouldReconnect).toBe(!closed?.loggedOut)
      } finally {
        vi.useRealTimers()
      }
    })

    it('reports a requested logout as logged out, and stops', async () => {
      const { adapter, events } = collect({ pairingMs: 0, meanUptimeMs: 0, inboundPerMinute: 0 })
      await adapter.connect()
      await adapter.disconnect({ logout: true })

      const closed = events.find((e) => e.type === 'closed') as {
        loggedOut: boolean
        rawCode: number | null
      }
      expect(closed.loggedOut).toBe(true)
      expect(closed.rawCode).toBe(401)
      expect(adapter.isReady()).toBe(false)
    })

    it('leaves no timer running after disconnect', async () => {
      vi.useFakeTimers()
      try {
        const { adapter, events } = collect({
          pairingMs: 0,
          inboundPerMinute: 600,
          meanUptimeMs: 1_000,
        })
        await adapter.connect()
        await adapter.disconnect()
        const afterDisconnect = events.length

        await vi.advanceTimersByTimeAsync(300_000)
        expect(events).toHaveLength(afterDisconnect)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('the scenario a session name asks for', () => {
    it('reads the scenario out of the middle segment', () => {
      expect(scenarioForSessionName('sim:degraded:abc')).toBe(SCENARIOS.degraded)
      expect(scenarioForSessionName('sim:mature:abc')).toBe(SCENARIOS.mature)
    })

    /**
     * A typo in a scenario name used to be indistinguishable from a healthy
     * run, which is the worst way to fail: the operator asks for `degrded` and
     * reads the resulting green dashboard as proof the degraded path is fine.
     * Falling back to healthy is still the right call — refusing to start would
     * strand a load run — but it is pinned here so the fallback is a decision
     * rather than an accident.
     */
    it('falls back to healthy for a name it does not know', () => {
      expect(scenarioForSessionName('sim:nonsense:abc')).toBe(SCENARIOS.healthy)
      expect(scenarioForSessionName('no-colons-at-all')).toBe(SCENARIOS.healthy)
    })

    /**
     * The warm-up curve reads the pairing date, so age decides the caps before
     * any delivery rate gets to matter. `healthy` has to stay at day zero —
     * that is what pairing a number actually gives you — and `mature` has to
     * clear the thirty-day milestone, or it releases only part of the volume
     * and the "fully warmed" run silently is not one.
     */
    it('keeps healthy at day zero and mature past the last milestone', () => {
      expect(DEFAULT_SCENARIO.ageDays).toBe(0)
      expect(SCENARIOS.healthy?.ageDays).toBeUndefined()
      expect(SCENARIOS.mature?.ageDays).toBeGreaterThanOrEqual(30)
    })
  })

  describe('determinism', () => {
    /**
     * A run that cannot be replayed is a run that cannot be debugged: the whole
     * value of a seed is that a failure at message 4,812 comes back.
     */
    it('replays identically for the same seed', async () => {
      const run = async (seed: number) => {
        // A failure rate high enough that two seeds diverge: the engine id is a
        // counter, so what the seed actually decides is which sends throw.
        const { adapter, events } = collect(
          { pairingMs: 0, meanUptimeMs: 0, sendFailureRate: 0.5 },
          seed,
        )
        await adapter.connect()
        const ids: string[] = []
        for (let i = 0; i < 10; i++) {
          try {
            ids.push((await adapter.sendText('5511999999999@s.whatsapp.net', 'hi')).engineMessageId)
          } catch {
            ids.push('threw')
          }
        }
        return { ids, events: events.length }
      }

      expect(await run(42)).toEqual(await run(42))
      expect((await run(42)).ids).not.toEqual((await run(7)).ids)
    })
  })
})
