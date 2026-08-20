/**
 * What kind of number the simulator is standing in for.
 *
 * The defaults describe an ordinary, healthy support line: almost everything
 * gets delivered, most of it gets read, the socket lives about four hours, and
 * roughly a fifth of incoming messages are from someone new. They are not
 * generous — a simulator that never fails proves only that the happy path
 * works, and the happy path was never the worry.
 */
export interface Scenario {
  /** The number the pairing reports. Null pairs without one, like a QR abandoned halfway. */
  phoneNumber: string | null
  /** Time on the pairing screen. Zero connects straight away, for load runs. */
  pairingMs: number

  /** Share of sends the engine rejects outright — these consume an attempt. */
  sendFailureRate: number
  /** Share of accepted sends that ever reach the recipient's phone. */
  deliveryRate: number
  /** Share of delivered messages that get opened. */
  readRate: number

  /** Median time from `sent` to `delivered`. */
  medianLatencyMs: number
  /** Spread of that median. Higher makes a longer tail, and a worse p95. */
  latencySigma: number
  /** Time from send to the protocol `sent` receipt. */
  ackSentMs: number

  /** Incoming messages per minute. Zero makes a send-only number. */
  inboundPerMinute: number
  /** Share of incoming messages from a number never seen before. */
  newContactRate: number
  /** The regulars, so conversation history accumulates instead of scattering. */
  knownContacts: string[]
  inboundTexts: string[]

  /** Mean time between drops. Zero keeps the socket up forever. */
  meanUptimeMs: number
  /** Share of drops that are a real logout, which must not be retried. */
  logoutShare: number

  /**
   * How long the number has already been paired, in days.
   *
   * This is not cosmetic: the warm-up curve reads the pairing date, so at zero
   * the caps sit at 5% and a few hundred queued messages take hours to leave.
   * That is right for a number paired a minute ago and wrong for anyone trying
   * to watch the pipeline work, and before this field the only way past it was
   * an UPDATE against `sessions.paired_at` by hand.
   */
  ageDays: number
}

export const DEFAULT_SCENARIO: Scenario = {
  phoneNumber: '5511999990000',
  pairingMs: 0,

  sendFailureRate: 0.02,
  deliveryRate: 0.97,
  readRate: 0.72,

  medianLatencyMs: 1_400,
  latencySigma: 0.7,
  ackSentMs: 120,

  inboundPerMinute: 6,
  newContactRate: 0.2,
  knownContacts: ['11987650001', '11987650002', '11987650003', '11987650004'],
  inboundTexts: [
    'hi, is anyone there?',
    'i want to know the price',
    'my order has not arrived',
    'thanks!',
    'can you send the invoice?',
  ],

  meanUptimeMs: 4 * 60 * 60 * 1000,
  logoutShare: 0.05,

  // A number paired just now, because that is what pairing a number gives you.
  ageDays: 0,
}

/**
 * Named scenarios, so a run can be asked for by name instead of by fifteen
 * numbers. Each one exists to make a specific thing visible.
 */
export const SCENARIOS: Record<string, Partial<Scenario>> = {
  /** The default: a working number, with the failures a working number has. */
  healthy: {},

  /**
   * Nothing gets delivered and the socket keeps dropping. This is what an
   * operator sees the morning after a number is flagged, and it is the state
   * the dashboard has to make obvious within seconds.
   */
  degraded: {
    sendFailureRate: 0.35,
    deliveryRate: 0.4,
    readRate: 0.1,
    medianLatencyMs: 9_000,
    latencySigma: 1.1,
    meanUptimeMs: 90_000,
    logoutShare: 0.2,
  },

  /**
   * A number that never answers back. Sends leave, receipts do not arrive —
   * the case where the funnel shows `sent` piling up with nothing behind it,
   * and the one most easily mistaken for "everything is fine".
   */
  silent: {
    sendFailureRate: 0,
    deliveryRate: 0,
    readRate: 0,
    inboundPerMinute: 0,
  },

  /** Nothing fails and nothing drops. For measuring throughput, not behaviour. */
  perfect: {
    sendFailureRate: 0,
    deliveryRate: 1,
    readRate: 1,
    medianLatencyMs: 200,
    latencySigma: 0.2,
    meanUptimeMs: 0,
    inboundPerMinute: 0,
  },

  /**
   * A number that has been running for a month, so warm-up is fully released
   * and the caps are at 100%. Everything else matches `healthy`.
   *
   * Age is part of the scenario rather than a separate flag because the
   * question a scenario answers is "what kind of number is this", and how long
   * it has been alive is squarely part of that answer — it decides the caps
   * before any of the delivery rates get a chance to matter.
   */
  mature: {
    ageDays: 30,
  },

  /** Mid-ramp: past the first days, not yet at full volume. */
  warming: {
    ageDays: 3,
  },

  /**
   * Heavy inbound from strangers. This is what drives the risk engine's
   * new-contact signal up, and with it the score, the throttle and the hold —
   * the path that is impossible to reach from a send-only test.
   */
  strangers: {
    inboundPerMinute: 60,
    newContactRate: 0.9,
  },
}

/**
 * The scenario a session name asks for.
 *
 * The name carries it — `sim:<scenario>:<anything>` — so a run is set up by
 * naming the session instead of by a configuration surface that would exist
 * only for testing. A name matching no scenario gets the healthy one.
 */
export function scenarioForSessionName(name: string): Partial<Scenario> {
  return SCENARIOS[name.split(':')[1] ?? 'healthy'] ?? SCENARIOS.healthy ?? {}
}
