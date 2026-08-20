#!/usr/bin/env node
/**
 * Drives real traffic through a running instance and reports what came out.
 *
 * The CHANGELOG has said the same thing for a while: nothing beyond pairing has
 * been exercised end to end against a real number. This is the answer that does
 * not need a phone. It creates sessions on the `simulator` engine, starts them,
 * enqueues messages at a chosen rate through the ordinary `POST /v1/messages`,
 * and then reads the funnel and the risk snapshot back out of the API — the
 * same numbers an operator would be looking at.
 *
 * What it does *not* do is bypass anything. Every message goes through the
 * outbox, the risk engine's budget and warm-up, the jitter, the scheduler and
 * the ACK reconciliation. The only thing standing in for reality is the last
 * hop, which is the one that needs a SIM card.
 *
 * Usage:
 *   node scripts/simulate.mjs --url http://localhost:2900 --key awah_… \
 *     [--sessions 2] [--messages 200] [--rate 20] [--scenario healthy] [--watch 60]
 *
 * The scenario is chosen by naming the session `sim:<scenario>`; see
 * `apps/api/src/engines/simulator/scenario.ts` for what each one makes visible.
 */

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--([a-z]+)(?:[= ]([^\s-][^\s]*))?/g)
    .map((m) => [m[1], m[2] ?? 'true']),
)

const BASE = (args.url ?? process.env.AWAH_URL ?? 'http://localhost:2900').replace(/\/$/, '')
const KEY = args.key ?? process.env.AWAH_KEY
const SESSIONS = Number(args.sessions ?? 1)
const MESSAGES = Number(args.messages ?? 100)
const RATE = Number(args.rate ?? 10)
const SCENARIO = args.scenario ?? 'healthy'
const WATCH_SECONDS = Number(args.watch ?? 45)

if (!KEY) {
  console.error('Missing --key (or AWAH_KEY). It needs session:write and message:write.')
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One request, retrying only what is worth retrying.
 *
 * A load driver trips the rate limiter by construction — that is most of what
 * it is for. The first run of this script died anyway: the enqueue loop was
 * spending the per-IP budget, and the *reporting* call inherited the 429 and
 * took the whole run down several minutes of traffic later. So a 429 backs off
 * and tries again rather than aborting, and anything else fails immediately,
 * because a 400 will still be a 400 on the fourth attempt.
 */
async function api(path, init = {}, attempts = 4) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    })
    const text = await response.text()
    if (response.ok) return text ? JSON.parse(text) : null

    // The limiter's own answer beats a guess; without it, back off exponentially.
    if (response.status === 429 && attempt < attempts) {
      const after = Number(response.headers.get('retry-after'))
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt)
      continue
    }
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${text.slice(0, 300)}`)
  }
}

/**
 * Fails early and says how to fix it.
 *
 * Without this the first symptom of a wrong flag is a 400 in the middle of a
 * loop, several screens up from the message that explains it.
 */
async function assertSimulatorAvailable() {
  const { engines } = await api('/v1/engines')
  if (!engines.some((e) => e.engine === 'simulator' && e.available)) {
    throw new Error(
      'This instance has no simulator engine. Start it with SIMULATOR_ENABLED=true (never in production).',
    )
  }
}

async function createAndStart(index) {
  const name = `sim:${SCENARIO}:${Date.now().toString(36)}${index}`
  const session = await api('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ name, engine: 'simulator' }),
  })
  await api(`/v1/sessions/${session.id}/start`, { method: 'POST' })
  return session
}

/**
 * Waits for the session to be connected before sending.
 *
 * Enqueueing into a session that is still pairing is legitimate — the outbox
 * holds it — but it would mean the run measures the wait rather than the
 * gateway.
 */
async function waitConnected(sessionId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const session = await api(`/v1/sessions/${sessionId}`)
    if (session.status === 'connected') return
    await sleep(400)
  }
  throw new Error(`session ${sessionId} did not connect in ${timeoutMs} ms`)
}

async function enqueue(sessions) {
  const gapMs = 1000 / RATE
  let accepted = 0
  let refused = 0
  const started = Date.now()

  for (let i = 0; i < MESSAGES; i++) {
    const session = sessions[i % sessions.length]
    // A spread of recipients, so the per-chat FIFO claim has several queues to
    // interleave instead of one.
    const chatId = `5511${String(900000000 + (i % 40)).slice(0, 9)}@s.whatsapp.net`
    try {
      await api(
        `/v1/sessions/${session.id}/messages`,
        {
          method: 'POST',
          body: JSON.stringify({ chatId, text: `load ${i + 1} of ${MESSAGES}` }),
        },
        // No retry here on purpose. Being refused at the requested rate is a
        // finding about the instance; retrying would quietly turn the measured
        // rate into whatever the limiter allows and report it as the rate asked
        // for.
        1,
      )
      accepted++
    } catch (error) {
      refused++
      if (refused <= 3) console.error(`  refused: ${error.message.slice(0, 160)}`)
    }
    const drift = started + (i + 1) * gapMs - Date.now()
    if (drift > 0) await sleep(drift)
  }

  return { accepted, refused, elapsedMs: Date.now() - started }
}

const pct = (value) => `${(value * 100).toFixed(1)}%`
const ms = (value) => (value === null ? '—' : `${Math.round(value)} ms`)

async function report(sessions) {
  const delivery = await api('/v1/kpi/delivery?hours=1')
  console.log('\nDelivery funnel (last hour)')
  console.log(`  queued     ${delivery.queue.queued}`)
  console.log(`  sending    ${delivery.queue.sending}`)
  console.log(`  dead       ${delivery.queue.dead}`)
  console.log(
    `  funnel     sent ${delivery.funnel.sent} → delivered ${delivery.funnel.delivered} → read ${delivery.funnel.read}   failed ${delivery.funnel.failed}`,
  )
  console.log(
    `  rates      delivery ${pct(delivery.funnel.deliveryRate)}   read ${pct(delivery.funnel.readRate)}`,
  )
  console.log(
    `  latency    p50 ${ms(delivery.latencyMs.p50)}   p95 ${ms(delivery.latencyMs.p95)}   p99 ${ms(delivery.latencyMs.p99)}`,
  )
  console.log(
    `  webhooks   delivered ${delivery.webhooks.delivered}   dead ${delivery.webhooks.dead}`,
  )

  for (const session of sessions) {
    const risk = await api(`/v1/sessions/${session.id}/risk`)
    console.log(`\nRisk — ${session.name}`)
    console.log(`  score      ${risk.score.value}/100`)
    console.log(
      `  usage      ${risk.usage.minute}/min  ${risk.usage.hour}/h  ${risk.usage.day}/day  ${risk.usage.newContactsToday} new contacts`,
    )
    console.log(
      `  limits     ${risk.limits.perMinute}/min  ${risk.limits.perHour}/h  ${risk.limits.perDay}/day`,
    )
    for (const factor of risk.score.factors ?? []) {
      console.log(`  ${factor.name.padEnd(20)} ${factor.points}/${factor.max}  ${factor.detail}`)
    }
  }
}

async function main() {
  console.log(`AWAH at ${BASE}`)
  await assertSimulatorAvailable()

  console.log(`Creating ${SESSIONS} session(s) on the "${SCENARIO}" scenario…`)
  const sessions = []
  for (let i = 0; i < SESSIONS; i++) sessions.push(await createAndStart(i))
  for (const session of sessions) await waitConnected(session.id)
  console.log(`  ${sessions.map((s) => s.name).join(', ')}`)

  console.log(`\nEnqueueing ${MESSAGES} message(s) at ${RATE}/s…`)
  const { accepted, refused, elapsedMs } = await enqueue(sessions)
  console.log(`  accepted ${accepted}, refused ${refused}, in ${(elapsedMs / 1000).toFixed(1)} s`)

  /*
   * The queue drains on its own clock: the risk engine spaces sends out on
   * purpose, and reading the funnel the moment the last POST returns would
   * measure the enqueue rate rather than the delivery.
   */
  console.log(`\nLetting the queue drain for ${WATCH_SECONDS} s…`)
  for (let elapsed = 0; elapsed < WATCH_SECONDS; elapsed += 5) {
    await sleep(5_000)
    const delivery = await api('/v1/kpi/delivery?hours=1')
    process.stdout.write(
      `\r  queued ${String(delivery.queue.queued).padStart(4)}  sending ${String(delivery.queue.sending).padStart(3)}  sent ${String(delivery.funnel.sent).padStart(4)}  delivered ${String(delivery.funnel.delivered).padStart(4)}   `,
    )
  }
  console.log()

  await report(sessions)

  console.log('\nThe sessions are still running. To stop and remove them:')
  for (const session of sessions) {
    console.log(
      `  curl -X DELETE ${BASE}/v1/sessions/${session.id} -H "authorization: Bearer $AWAH_KEY"`,
    )
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`)
  process.exit(1)
})
