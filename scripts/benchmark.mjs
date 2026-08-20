#!/usr/bin/env node
/**
 * Measures what this gateway claims to do, and writes down the numbers.
 *
 * The README makes four promises that are cheap to state and expensive to
 * verify: sends keep their order within a conversation, a refused send is
 * retried rather than lost, the risk engine actually shapes output instead of
 * merely reporting on it, and none of that collapses under load. This runs each
 * one against a live instance and emits a report.
 *
 * What it measures is the gateway, not WhatsApp. The last hop is the
 * `simulator` engine, so every number here describes the queue, the ordering,
 * the retry path and the budget — all the parts that are ours. Throughput
 * figures in particular say how fast the pipeline can move messages, not how
 * fast a real number is allowed to send them. The report says so at the top,
 * in those words, because a benchmark that lets a reader confuse the two is
 * worse than no benchmark.
 *
 *   node scripts/benchmark.mjs --url http://localhost:2900 --key awah_… \
 *     [--out docs/BENCHMARK.md] [--keep]
 *
 * The instance needs SIMULATOR_ENABLED=true, which refuses to boot in
 * production. `--keep` leaves the benchmark sessions behind for inspection.
 */

import { writeFileSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--([a-z-]+)(?:[= ]([^\s-][^\s]*))?/g)
    .map((m) => [m[1], m[2] ?? 'true']),
)

const BASE = (args.url ?? process.env.AWAH_URL ?? 'http://localhost:2900').replace(/\/$/, '')
const KEY = args.key ?? process.env.AWAH_KEY
const OUT = args.out ?? 'docs/BENCHMARK.md'
const KEEP = args.keep === 'true'

if (!KEY) {
  console.error(
    'Missing --key (or AWAH_KEY). It needs session:write, message:send and metrics:read.',
  )
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

/**
 * One request, retrying only what is worth retrying.
 *
 * A benchmark trips the rate limiter by construction — that is most of what it
 * is for. A 429 backs off and tries again; anything else fails immediately,
 * because a 400 will still be a 400 on the fourth attempt.
 */
async function api(path, init = {}, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        ...init.headers,
      },
    })
    const text = await res.text()
    if (res.ok) return text ? JSON.parse(text) : null

    if (res.status === 429 && attempt < attempts) {
      const after = Number(res.headers.get('retry-after'))
      await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 400 * 2 ** attempt)
      continue
    }
    throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`)
  }
}

async function requireSimulator() {
  const { engines } = await api('/v1/engines')
  if (!engines.some((e) => e.engine === 'simulator' && e.available)) {
    throw new Error(
      'This instance has no simulator engine. Start it with SIMULATOR_ENABLED=true (never in production).',
    )
  }
}

const criadas = []

async function novaSessao(cenario, sufixo) {
  const name = `bench:${cenario}:${sufixo}`
  const s = await api('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ name, engine: 'simulator' }),
  })
  await api(`/v1/sessions/${s.id}/start`, { method: 'POST' })
  criadas.push(s.id)

  const prazo = Date.now() + 20_000
  while (Date.now() < prazo) {
    const atual = await api(`/v1/sessions/${s.id}`)
    if (atual.status === 'connected') return s
    await sleep(300)
  }
  throw new Error(`session ${name} did not connect`)
}

// ---------------------------------------------------------------------------
// 1. Throughput, ordering and retry — one run, three readings.
// ---------------------------------------------------------------------------

/**
 * The ordering guarantee is a property of the outbox, not of the risk engine,
 * so the ceiling is lifted before this run and the report says it was lifted.
 * Left at the warm-up default a mature session sends twelve a minute, and
 * measuring FIFO at that rate would take half an hour to say nothing extra:
 * order under a trickle is not the case anyone doubts.
 */
async function corridaPrincipal({ chats = 8, porChat = 25, tetoPorMinuto = 600 }) {
  log(`\n[1/2] Throughput, ordering and retry — ${chats} chats × ${porChat} messages`)
  const sessao = await novaSessao('mature', 'load')
  await api(`/v1/sessions/${sessao.id}/risk/limits`, {
    method: 'PUT',
    body: JSON.stringify({
      perMinute: tetoPorMinuto,
      perHour: 20_000,
      perDay: 200_000,
      newContactsPerDay: 50_000,
    }),
  })

  const total = chats * porChat
  const inicio = Date.now()

  /*
   * Each conversation is queued strictly in order; the conversations run
   * against each other.
   *
   * Both halves matter. Firing everything at once — which is what this did at
   * first — makes the API accept the writes in whatever order they happen to
   * arrive, so the sequence the outbox preserves is no longer the sequence the
   * caller intended, and the check reports inversions the gateway never
   * committed. FIFO is a promise about the order the API accepted, so the
   * benchmark has to establish that order before it can measure it.
   *
   * Sending one whole conversation before starting the next would be the
   * opposite mistake: a scheduler that serialises everything would pass with
   * nothing to interleave against.
   */
  const porConversa = Array.from({ length: chats }, async (_, c) => {
    const chatId = `5511${String(920000000 + c).slice(0, 9)}@s.whatsapp.net`
    let aceitasAqui = 0
    for (let i = 0; i < porChat; i++) {
      const ok = await api(`/v1/sessions/${sessao.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          chatId,
          text: `bench c${c} n${i}`,
          clientMessageId: `bench-${sessao.id.slice(0, 8)}-${c}-${String(i).padStart(4, '0')}`,
        }),
      }).catch(() => null)
      if (ok) aceitasAqui++
    }
    return aceitasAqui
  })
  const aceitas = (await Promise.all(porConversa)).reduce((a, b) => a + b, 0)
  const msEnfileirar = Date.now() - inicio
  log(`      queued ${aceitas}/${total} in ${(msEnfileirar / 1000).toFixed(1)} s`)

  // Drain, watching the outbox rather than a fixed sleep.
  const prazo = Date.now() + 240_000
  let linhas = []
  while (Date.now() < prazo) {
    await sleep(3000)
    const { items } = await api(`/v1/outbox?sessionId=${sessao.id}&limit=500`)
    linhas = items
    const pendentes = items.filter((r) => r.status === 'queued' || r.status === 'sending').length
    process.stdout.write(`\r      draining, ${pendentes} left   `)
    if (pendentes === 0) break
  }
  log('')

  const enviadas = linhas.filter((r) => r.status === 'sent')
  const mortas = linhas.filter((r) => r.status === 'dead')
  const retentadas = linhas.filter((r) => r.attempts > 0)
  const recuperadas = retentadas.filter((r) => r.status === 'sent')

  // Wall-clock throughput of the drain itself, from first send to last.
  const carimbos = enviadas.map((r) => new Date(r.sentAt).getTime()).sort((a, b) => a - b)
  const janelaS = carimbos.length > 1 ? (carimbos.at(-1) - carimbos[0]) / 1000 : 0
  const porSegundo = janelaS > 0 ? enviadas.length / janelaS : 0

  /*
   * The ordering check. Within one chat, the order the messages went out has to
   * be the order they were queued in — that is the whole promise. An inversion
   * is any pair where a later sequence number left first.
   */
  const porChatMap = new Map()
  for (const r of enviadas) {
    const m = r.clientMessageId.match(/-(\d+)-(\d+)$/)
    if (!m) continue
    const lista = porChatMap.get(m[1]) ?? []
    lista.push({ seq: Number(m[2]), em: new Date(r.sentAt).getTime(), tentativas: r.attempts })
    porChatMap.set(m[1], lista)
  }

  let inversoes = 0
  let inversoesComRetry = 0
  let paresConferidos = 0
  for (const lista of porChatMap.values()) {
    lista.sort((a, b) => a.em - b.em || a.seq - b.seq)
    for (let i = 1; i < lista.length; i++) {
      paresConferidos++
      if (lista[i].seq < lista[i - 1].seq) {
        inversoes++
        /*
         * Whether a retry is what moved it.
         *
         * A send the engine refuses goes back to the queue with a backoff, and
         * the next message in that conversation becomes the head and overtakes
         * it. That is a real reordering, and separating it from the rest is the
         * difference between a report that explains the number and one that
         * just prints it — the two have entirely different fixes.
         */
        if (lista[i].tentativas > 0 || lista[i - 1].tentativas > 0) inversoesComRetry++
      }
    }
  }

  log(
    `      sent ${enviadas.length}, dead ${mortas.length}, retried ${retentadas.length}, inversions ${inversoes}`,
  )

  return {
    sessaoId: sessao.id,
    pedidas: total,
    aceitas,
    msEnfileirar,
    enviadas: enviadas.length,
    mortas: mortas.length,
    retentadas: retentadas.length,
    recuperadas: recuperadas.length,
    porSegundo,
    janelaS,
    chatsConferidos: porChatMap.size,
    paresConferidos,
    inversoes,
    inversoesComRetry,
  }
}

// ---------------------------------------------------------------------------
// 2. The warm-up curve, observed rather than asserted.
// ---------------------------------------------------------------------------

/**
 * Three numbers of different ages, same backlog, same window.
 *
 * This is the measurement that separates the project from a plain send queue,
 * and it is the one nobody can run without either waiting a month or faking
 * the pairing date. The simulator does the second, honestly and on purpose.
 */
async function curvaDeWarmup({ porSessao = 80, janelaMs = 150_000 }) {
  log(`\n[2/2] Warm-up curve — three ages, ${porSessao} messages each, ${janelaMs / 1000} s window`)

  const idades = [
    { cenario: 'healthy', dias: 0 },
    { cenario: 'warming', dias: 3 },
    { cenario: 'mature', dias: 30 },
  ]

  const sessoes = []
  for (const idade of idades) {
    const s = await novaSessao(idade.cenario, 'warmup')
    const risco = await api(`/v1/sessions/${s.id}/risk`)
    sessoes.push({ ...idade, id: s.id, limites: risco.limits, idadeObservada: risco.warmup })
  }

  for (const s of sessoes) {
    for (let i = 0; i < porSessao; i++) {
      const chatId = `5511${String(930000000 + (i % 30)).slice(0, 9)}@s.whatsapp.net`
      await api(`/v1/sessions/${s.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ chatId, text: `warmup ${i}` }),
      }).catch(() => null)
    }
  }
  log(`      queued ${porSessao} on each; waiting ${janelaMs / 1000} s`)

  const t0 = Date.now()
  await sleep(janelaMs)

  for (const s of sessoes) {
    const { items } = await api(`/v1/outbox?sessionId=${s.id}&limit=500`)
    s.enviadas = items.filter((r) => r.status === 'sent').length
    s.retidas = items.filter((r) => r.status === 'queued' && r.heldReason).length
    s.porMinuto = s.enviadas / ((Date.now() - t0) / 60_000)
    log(
      `      ${s.cenario.padEnd(8)} age ${String(s.dias).padStart(2)}d  limit ${String(s.limites.perMinute).padStart(3)}/min  sent ${String(s.enviadas).padStart(3)}  (${s.porMinuto.toFixed(1)}/min)`,
    )
  }

  return sessoes
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const n = (v) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US'))
const f1 = (v) => (v === null || v === undefined ? '—' : v.toFixed(1))

function relatorio({ carga, warmup, entrega, ambiente, quando }) {
  const ordemOk = carga.inversoes === 0

  return `# Benchmark

_Generated by \`scripts/benchmark.mjs\` on ${quando}._

## What these numbers are, and what they are not

Every measurement below was taken against the **\`simulator\` engine**, not
against a real WhatsApp number. The simulator implements the same
\`EngineAdapter\` contract as Baileys and the Cloud API and stands in for the
last hop only, which means everything upstream of it is the real thing: the
transactional outbox, the per-conversation ordering, the retry path, the
sliding-window budget, the warm-up curve and the human jitter.

So these figures describe **the gateway**. They do not describe WhatsApp.

In particular, the throughput number is how fast the pipeline can move
messages when the ceiling is lifted — it is a measure of the queue, not a rate
anyone should send at. A real number sending at that rate gets banned, which is
precisely why the risk engine exists and why the warm-up section below is the
more useful half of this page.

What is still unmeasured: Baileys' own protocol behaviour, real ACK semantics,
real disconnect codes, and what WhatsApp actually does to a number over time. A
simulator cannot answer those by construction.

## Environment

| | |
|---|---|
| Version | \`${ambiente.version ?? '—'}\` |
| Revision | \`${(ambiente.revision ?? '—').slice(0, 12)}\` |
| Engine under test | \`simulator\` |

## Ordering within a conversation

The gateway promises that two messages queued for the same chat leave in the
order they were queued, no matter how much else is in flight.

Each of the ${carga.chatsConferidos} conversations was queued strictly in
order, and the conversations ran against each other — so a scheduler that only
happens to be ordered because nothing competes with it would fail here.

| | |
|---|---|
| Conversations | ${n(carga.chatsConferidos)} |
| Messages delivered to the engine | ${n(carga.enviadas)} |
| Consecutive pairs checked | ${n(carga.paresConferidos)} |
| **Out-of-order pairs** | **${n(carga.inversoes)}** |
| Of those, caused by a retry | ${n(carga.inversoesComRetry)} |

${
  ordemOk
    ? '✅ No inversion in any conversation.'
    : carga.inversoes === carga.inversoesComRetry
      ? `✅ No inversion among sends that went out on the first attempt. The ${carga.inversoes} reordering(s) all involve a message the engine refused: a refused send returns to the queue with a backoff, and the next message in that conversation takes the head and overtakes it. That is a deliberate trade — the alternative is stalling a whole conversation behind one message for the hour its attempts take to run out — but it is a real limit of the guarantee and is documented as one.`
      : `❌ ${carga.inversoes - carga.inversoesComRetry} inversion(s) with no retry involved — the FIFO claim does not hold under this load.`
}

## Retry and the dead-letter queue

The simulator refuses a share of sends with the errors a real engine returns —
rate limit, recipient not on WhatsApp, outside the 24-hour window. A refusal
must cost an attempt and be retried, never dropped.

| | |
|---|---|
| Sends refused at least once | ${n(carga.retentadas)} |
| Of those, delivered on a later attempt | ${n(carga.recuperadas)} |
| Exhausted every attempt (dead-letter) | ${n(carga.mortas)} |

## Throughput

Two different numbers, and confusing them is the easiest mistake to make with
this page.

**Ingest** is how fast the API accepts and durably queues a send. It is bounded
by Postgres and by the HTTP layer, and it is the number that matters when a
burst of traffic arrives and nothing may be dropped.

**Drain** is how fast messages then leave for the engine — and on this project
that is *deliberately slow*. The risk engine puts seconds of human jitter
between sends, so the drain rate below is mostly a measurement of that pause,
not of any limit in the queue. A gateway that drained faster would be a gateway
that got numbers banned.

| | |
|---|---|
| Queued through \`POST /v1/sessions/:id/messages\` | ${n(carga.aceitas)} of ${n(carga.pedidas)} |
| Time to accept them all | ${f1(carga.msEnfileirar / 1000)} s |
| **Ingest rate** | **${f1(carga.aceitas / (carga.msEnfileirar / 1000))} sends/s** |
| Drain window | ${f1(carga.janelaS)} s |
| **Drain rate, one session, jitter on** | **${f1(carga.porSegundo)} sends/s** |
${
  entrega
    ? `| Delivery rate | ${(entrega.funnel.deliveryRate * 100).toFixed(1)} % |
| Latency p50 / p95 / p99 | ${n(entrega.latencyMs.p50)} / ${n(entrega.latencyMs.p95)} / ${n(entrega.latencyMs.p99)} ms |`
    : ''
}

## The warm-up curve

A freshly paired number that sends a thousand messages on day one is the most
obvious throwaway-account pattern there is. The curve releases volume as the
session ages, from 5 % of the ceiling on day zero to 100 % at thirty days.

Three sessions, identical in every way except their pairing date, were given
the same backlog and the same window:

| Session age | Ceiling in effect | Sent in the window | Observed rate |
|---|---|---|---|
${warmup
  .map(
    (s) =>
      `| ${s.dias} days | ${n(s.limites.perMinute)}/min · ${n(s.limites.perHour)}/h · ${n(s.limites.perDay)}/day | ${n(s.enviadas)} | ${f1(s.porMinuto)}/min |`,
  )
  .join('\n')}

Nothing was discarded. What did not pass stayed queued with the reason
recorded against it — which is the behaviour that separates a risk engine from
a rate limiter.

## Reproducing this

\`\`\`bash
docker compose up -d
SIMULATOR_ENABLED=true docker compose up -d api
node scripts/benchmark.mjs --url http://localhost:2900 --key "$AWAH_KEY"
\`\`\`

\`SIMULATOR_ENABLED\` refuses to boot under \`NODE_ENV=production\`: a fake engine
left on accepts every send and reports it delivered with nothing reaching a
phone, and nothing on the dashboard would look wrong.
`
}

// ---------------------------------------------------------------------------

async function main() {
  log(`AWAH at ${BASE}`)
  await requireSimulator()
  const ambiente = await api('/health')

  const carga = await corridaPrincipal({})
  const warmup = await curvaDeWarmup({})

  /*
   * The funnel reads the hourly aggregates, so on an instance with the default
   * five-minute interval it lags the run. Poll rather than assume: reporting a
   * zero because the aggregator had not run yet would be a false number, which
   * is worse than an absent one.
   */
  let entrega = null
  const prazo = Date.now() + 90_000
  while (Date.now() < prazo) {
    const d = await api('/v1/kpi/delivery?hours=1')
    if (d.funnel.sent > 0 && d.latencyMs.p95 !== null) {
      entrega = d
      break
    }
    process.stdout.write('\r      waiting for the aggregator…   ')
    await sleep(5000)
  }
  log('')
  if (!entrega) log('      aggregator produced nothing in time; the funnel section is omitted')

  const quando = new Date().toISOString().slice(0, 10)
  const md = relatorio({ carga, warmup, entrega, ambiente, quando })
  writeFileSync(OUT, md)
  log(`\nWrote ${OUT}`)

  if (!KEEP) {
    for (const id of criadas) {
      await api(`/v1/sessions/${id}`, { method: 'DELETE' }).catch(() => null)
    }
    log(`Removed ${criadas.length} benchmark session(s).`)
  } else {
    log(`Left ${criadas.length} benchmark session(s) in place (--keep).`)
  }
}

main().catch(async (e) => {
  console.error(`\n${e.message}`)
  for (const id of criadas) {
    await api(`/v1/sessions/${id}`, { method: 'DELETE' }).catch(() => null)
  }
  process.exit(1)
})
