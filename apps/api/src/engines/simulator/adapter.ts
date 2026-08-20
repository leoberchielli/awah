import type { MessageStatus } from '@awah/db'
import type { EngineAdapter, EngineCapabilities, EngineEventHandler, SendResult } from '../types'
import { DEFAULT_SCENARIO, type Scenario } from './scenario'

/**
 * An engine that behaves like a paired WhatsApp number without being one.
 *
 * Everything worth trusting in this gateway sits *upstream* of the adapter: the
 * outbox ordering, the risk engine's budget and warm-up, the jitter, the ACK
 * reconciliation, the webhook fan-out, the lease and the failover. None of it
 * can be exercised end to end without a phone, which is why none of it had been
 * — the CHANGELOG says so out loud. This closes that, by being the one piece
 * that lies, so every piece above it can be told the truth.
 *
 * It is not a mock. A mock returns success; this returns what a real number
 * returns, which is mostly success and sometimes a 24-hour window error, an ACK
 * that never arrives, and a socket that drops at 3 a.m. Those are the paths
 * that matter, and a happy-path fake would leave them exactly as untested as
 * they are today.
 *
 * Determinism is a parameter. Seeded, the same scenario replays identically and
 * a test can assert on it; unseeded, it draws fresh each run, which is what you
 * want when the question is "does anything break under an hour of traffic".
 */
export class SimulatorAdapter implements EngineAdapter {
  readonly engine = 'simulator' as const

  /**
   * Deliberately the union of what the two real engines can do, not the
   * intersection: the point is to exercise every branch, including the ones
   * only Baileys reaches.
   */
  readonly capabilities: EngineCapabilities = {
    qrPairing: true,
    codePairing: true,
    groups: true,
    channels: false,
    presence: true,
    reactions: true,
    editMessage: true,
    freeformMessaging: true,
  }

  private readonly sessionId: string
  private readonly onEvent: EngineEventHandler
  private readonly scenario: Scenario
  private readonly random: () => number

  private ready = false
  private qr: string | null = null
  private closed = false
  private sequence = 0

  /** Every pending timer, so `disconnect` leaves nothing running. */
  private readonly timers = new Set<NodeJS.Timeout>()

  constructor(options: {
    sessionId: string
    onEvent: EngineEventHandler
    scenario?: Partial<Scenario>
    /** Given a seed, the run replays identically. Omit it for fresh noise. */
    seed?: number
  }) {
    this.sessionId = options.sessionId
    this.onEvent = options.onEvent
    this.scenario = { ...DEFAULT_SCENARIO, ...options.scenario }
    this.random = options.seed === undefined ? Math.random : mulberry32(options.seed)
  }

  async connect(): Promise<void> {
    this.closed = false
    this.onEvent({ type: 'status', status: 'connecting' })

    if (this.scenario.pairingMs > 0) {
      // Someone has to look at a QR. Emitting one makes the pairing screen,
      // the QR cache and the cross-replica share do real work.
      this.qr = `simulator:${this.sessionId}:${Date.now()}`
      this.onEvent({ type: 'status', status: 'pairing' })
      this.onEvent({ type: 'qr', qr: this.qr })
      await this.sleep(this.scenario.pairingMs)
      if (this.closed) return
    }

    this.qr = null
    this.onEvent({ type: 'paired', phoneNumber: this.scenario.phoneNumber })
    this.onEvent({ type: 'credentials' })
    this.onEvent({ type: 'status', status: 'connected' })
    this.ready = true

    this.scheduleInbound()
    this.scheduleDrop()
  }

  async disconnect(options?: { logout?: boolean }): Promise<void> {
    this.closed = true
    this.ready = false
    this.qr = null
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()

    this.onEvent({
      type: 'closed',
      rawCode: options?.logout ? 401 : null,
      cause: options?.logout ? 'logged out' : 'disconnect requested',
      shouldReconnect: false,
      loggedOut: Boolean(options?.logout),
    })
  }

  async requestPairingCode(_phoneNumber: string): Promise<string> {
    return String(Math.floor(this.random() * 100_000_000)).padStart(8, '0')
  }

  currentQr(): string | null {
    return this.qr
  }

  isReady(): boolean {
    return this.ready
  }

  /**
   * The send itself is instant; what is not instant is the delivery.
   *
   * A real number answers the socket immediately and the recipient's phone
   * acknowledges later, or never. Reproducing that gap is the whole reason the
   * funnel is worth measuring: a fake that jumps straight to `read` would make
   * the p95 latency chart a flat line and hide every reconciliation bug.
   */
  async sendText(chatId: string, text: string): Promise<SendResult> {
    if (!this.ready) throw new Error('simulator session is not connected')

    if (this.random() < this.scenario.sendFailureRate) {
      throw new Error(this.pickSendError())
    }

    this.sequence += 1
    const engineMessageId = `SIM${this.sessionId.slice(0, 8)}${this.sequence.toString(36).toUpperCase()}`
    const sentAt = new Date()

    this.ackAfter(engineMessageId, chatId, 'sent', this.scenario.ackSentMs)

    // A message that is sent and never delivered is the case the dashboard
    // exists to surface, so a share of them stop right here.
    if (this.random() >= this.scenario.deliveryRate) {
      return { engineMessageId, timestamp: sentAt }
    }

    const deliveredIn = this.scenario.ackSentMs + this.latency()
    this.ackAfter(engineMessageId, chatId, 'delivered', deliveredIn)

    if (this.random() < this.scenario.readRate) {
      this.ackAfter(engineMessageId, chatId, 'read', deliveredIn + this.latency() * 3)
    }

    void text
    return { engineMessageId, timestamp: sentAt }
  }

  async sendPresence(): Promise<void> {
    // Nothing to observe from outside; the typing delay it stands for is
    // already spent by the risk engine before this is called.
  }

  // ---------------------------------------------------------------- internals

  private ackAfter(
    engineMessageId: string,
    chatId: string,
    status: MessageStatus,
    delayMs: number,
  ): void {
    this.after(delayMs, () => {
      this.onEvent({
        type: 'message.status',
        engineMessageId,
        chatId,
        status,
        occurredAt: new Date(),
      })
    })
  }

  /**
   * Traffic coming the other way.
   *
   * Without it the risk engine's new-contact signal never moves, the
   * integrations never receive anything, and the conversation tables stay
   * empty — which is to say the business screen would be measuring nothing.
   */
  private scheduleInbound(): void {
    if (this.scenario.inboundPerMinute <= 0) return

    const gap = 60_000 / this.scenario.inboundPerMinute
    this.after(this.jittered(gap), () => {
      if (!this.ready) return

      const fromNew = this.random() < this.scenario.newContactRate
      const suffix = fromNew
        ? Math.floor(this.random() * 1_000_000_000).toString()
        : this.scenario.knownContacts[
            Math.floor(this.random() * this.scenario.knownContacts.length)
          ]
      const chatId = `55${String(suffix).padStart(11, '0').slice(0, 11)}@s.whatsapp.net`

      this.sequence += 1
      this.onEvent({
        type: 'message.received',
        engineMessageId: `SIMIN${this.sequence.toString(36).toUpperCase()}`,
        chatId,
        fromJid: chatId,
        messageType: 'text',
        body: this.scenario.inboundTexts[
          Math.floor(this.random() * this.scenario.inboundTexts.length)
        ] as string,
        fromMe: false,
        occurredAt: new Date(),
      })

      this.scheduleInbound()
    })
  }

  /**
   * The socket drops. It always does.
   *
   * The codes come from the project's own disconnect table rather than being
   * invented, so the reconnection decision under test is the real one — 515
   * restarts at once, 401 is a logout that must not be retried, 428 backs off.
   */
  private scheduleDrop(): void {
    if (this.scenario.meanUptimeMs <= 0) return

    // Exponential, because a socket has no memory of how long it has been up.
    const uptime = -Math.log(1 - this.random()) * this.scenario.meanUptimeMs
    this.after(uptime, () => {
      if (!this.ready) return
      this.ready = false

      const [rawCode, cause, loggedOut] = this.pickDisconnect()
      this.onEvent({
        type: 'closed',
        rawCode,
        cause,
        shouldReconnect: !loggedOut,
        loggedOut,
      })
    })
  }

  private pickDisconnect(): [number, string, boolean] {
    const draw = this.random()
    if (draw < this.scenario.logoutShare) return [401, 'Session taken over elsewhere', true]
    if (draw < this.scenario.logoutShare + 0.15) return [515, 'Restart required', false]
    if (draw < this.scenario.logoutShare + 0.35) return [428, 'Connection closed', false]
    return [408, 'Connection timed out', false]
  }

  private pickSendError(): string {
    const errors = [
      'rate limit reached, try again later',
      'recipient is not on WhatsApp',
      're-engagement message outside the 24 hour window',
    ]
    return errors[Math.floor(this.random() * errors.length)] as string
  }

  /**
   * Log-normal, like the risk engine's own jitter: most deliveries land near
   * the median and a few take much longer, which is what a percentile chart
   * needs in order to say anything.
   */
  private latency(): number {
    const u1 = Math.max(this.random(), 1e-9)
    const u2 = this.random()
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    return Math.round(this.scenario.medianLatencyMs * Math.exp(normal * this.scenario.latencySigma))
  }

  private jittered(base: number): number {
    return Math.round(base * (0.5 + this.random()))
  }

  private after(delayMs: number, fn: () => void): void {
    const timer = setTimeout(
      () => {
        this.timers.delete(timer)
        if (!this.closed) fn()
      },
      Math.max(0, delayMs),
    )
    // A pending ACK must never be the reason the process refuses to exit.
    timer.unref?.()
    this.timers.add(timer)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.after(ms, resolve)
    })
  }
}

/**
 * A small seeded PRNG. Not for anything that needs to be unguessable — it is
 * here so a failing run can be replayed exactly, which `Math.random` cannot do.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
