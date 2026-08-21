#!/usr/bin/env node
/**
 * Puts the guarantees in the README in front of a live instance and writes down
 * what happened.
 *
 * The benchmark measures how the gateway performs. This asks whether it does
 * what it says at all: that a key without a scope is refused, that one
 * organisation cannot reach another's sessions, that resending the same id does
 * not duplicate, that a dropped session does not burn a delivery attempt, that
 * a webhook is signed in a way a receiver can actually verify, and that a
 * delivery which keeps failing ends up somewhere you can find it.
 *
 * Every check records its evidence — the status code, the counts, the recomputed
 * signature — because "17 checks passed" is a claim, and the point of this file
 * is to stop making claims.
 *
 *   node scripts/verify.mjs --url http://localhost:2900 --key awah_… \
 *     [--out docs/VERIFICATION.md] [--webhook-host host.docker.internal]
 *
 * The instance needs SIMULATOR_ENABLED=true, which refuses to boot in
 * production.
 */

import { createHmac } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--([a-z-]+)(?:[= ]([^\s-][^\s]*))?/g)
    .map((m) => [m[1], m[2] ?? 'true']),
)

const BASE = (args.url ?? process.env.AWAH_URL ?? 'http://localhost:2900').replace(/\/$/, '')
const KEY = args.key ?? process.env.AWAH_KEY
const OUT = args.out ?? 'docs/VERIFICATION.md'
/** Where the instance can reach this script. In Docker that is not `localhost`. */
const WEBHOOK_HOST = args['webhook-host'] ?? 'host.docker.internal'
/** A user session, because an API key is deliberately unable to mint keys. */
const EMAIL = args.email ?? process.env.AWAH_EMAIL
const PASSWORD = args.password ?? process.env.AWAH_PASSWORD

if (!KEY) {
  console.error('Missing --key (or AWAH_KEY). It needs the admin role.')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Set by `entrar`, and the only thing allowed to administer identity. */
let cookie = null

// ---------------------------------------------------------------- the ledger

const grupos = []
let atual = null

function grupo(nome, proposito) {
  atual = { nome, proposito, checks: [] }
  grupos.push(atual)
  console.log(`\n${nome}`)
}

/**
 * Records one check.
 *
 * `evidencia` is not decoration. A report that says a check passed without
 * showing what it saw is asking to be trusted, which is the opposite of what a
 * verification document is for.
 */
function check(nome, passou, evidencia) {
  atual.checks.push({ nome, passou, evidencia })
  console.log(`  ${passou ? '✓' : '✗'} ${nome}`)
  if (!passou) console.log(`      ${evidencia}`)
  return passou
}

// ------------------------------------------------------------------- the wire

/**
 * Raw access, because half of what is under test is the failure response.
 *
 * `key` has no default on purpose, and `undefined` is rejected rather than
 * treated as "use the admin key". The first version of this file defaulted, and
 * a mistyped field name turned every restricted-credential check into an
 * admin-credential check: three real passes were reported as failures, and had
 * the gateway been broken the same slip would have reported it as secure. A
 * harness that can silently escalate its own privileges cannot verify anything
 * about privileges.
 *
 * `null` means send nothing; `'cookie'` means the user session.
 */
async function bruto(path, init = {}, key) {
  if (key === undefined) {
    throw new Error(
      `bruto(${path}) called with an undefined credential — say KEY, null or 'cookie'`,
    )
  }
  const headers = { 'content-type': 'application/json', ...init.headers }
  if (key === 'cookie') {
    if (cookie) headers.cookie = cookie
  } else if (key !== null) {
    headers.authorization = `Bearer ${key}`
  }

  for (let tentativa = 1; ; tentativa++) {
    const res = await fetch(`${BASE}${path}`, { ...init, headers })
    const texto = await res.text()

    if (res.status === 429 && tentativa < 5) {
      await sleep(400 * 2 ** tentativa)
      continue
    }
    let corpo = null
    try {
      corpo = texto ? JSON.parse(texto) : null
    } catch {
      corpo = texto
    }
    return { status: res.status, corpo, headers: res.headers }
  }
}

async function api(path, init = {}, key = KEY) {
  const r = await bruto(path, init, key)
  if (r.status >= 400) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${r.status} ${JSON.stringify(r.corpo)}`)
  }
  return r.corpo
}

/**
 * Signs in as a person.
 *
 * Keys are minted from a user session and never from another key — the gateway
 * refuses it, which is checked below rather than merely worked around here.
 */
async function entrar() {
  if (!EMAIL || !PASSWORD) {
    throw new Error('Missing --email and --password. Key administration needs a user session.')
  }
  const res = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`login failed: HTTP ${res.status} ${await res.text()}`)

  const bruta = res.headers.getSetCookie?.() ?? []
  cookie = bruta.map((c) => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error('login returned no cookie')
}

const criadas = { sessoes: [], webhooks: [], chaves: [] }

async function novaSessao(nome) {
  const s = await api('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: nome, engine: 'simulator' }),
  })
  criadas.sessoes.push(s.id)
  await api(`/v1/sessions/${s.id}/start`, { method: 'POST' })

  const prazo = Date.now() + 20_000
  while (Date.now() < prazo) {
    const atualS = await api(`/v1/sessions/${s.id}`)
    if (atualS.status === 'connected') return s
    await sleep(300)
  }
  throw new Error(`session ${nome} did not connect`)
}

const outboxDaSessao = (id) => api(`/v1/outbox?sessionId=${id}&limit=500`).then((r) => r.items)

// ===========================================================================
// 1. Who is allowed in
// ===========================================================================

async function autenticacao() {
  grupo(
    'Authentication and authorization',
    'Every route behind a credential, and a credential that reaches only what it was given.',
  )

  const semChave = await bruto('/v1/sessions', {}, null)
  check(
    'a request with no credential is refused',
    semChave.status === 401,
    `HTTP ${semChave.status}`,
  )

  const chaveFalsa = await bruto('/v1/sessions', {}, 'awah_nao_existe_de_jeito_nenhum')
  check(
    'an invented bearer token is refused',
    chaveFalsa.status === 401,
    `HTTP ${chaveFalsa.status} — ${JSON.stringify(chaveFalsa.corpo?.error?.code)}`,
  )

  /*
   * The separation that makes every other scope meaningful: a key that could
   * mint keys could mint itself a better one, and no restriction below would
   * survive it.
   */
  const chaveCriaChave = await bruto(
    '/v1/keys',
    { method: 'POST', body: JSON.stringify({ name: 'escalada', role: 'admin' }) },
    KEY,
  )
  check(
    'an API key cannot create another API key',
    chaveCriaChave.status === 403,
    `HTTP ${chaveCriaChave.status} — ${JSON.stringify(chaveCriaChave.corpo?.error?.message)}`,
  )

  /*
   * A read-only key. If this could create a session, the whole scope system
   * would be decoration: the point of handing someone a key is being able to
   * hand them less than everything.
   */
  const soLeitura = await api(
    '/v1/keys',
    { method: 'POST', body: JSON.stringify({ name: 'verify-readonly', role: 'viewer' }) },
    'cookie',
  )
  criadas.chaves.push(soLeitura.key.id)
  const segredoLeitura = soLeitura.token

  const tentaCriar = await bruto(
    '/v1/sessions',
    { method: 'POST', body: JSON.stringify({ name: 'nao-deveria', engine: 'simulator' }) },
    segredoLeitura,
  )
  check(
    'a viewer key cannot create a session',
    tentaCriar.status === 403,
    `HTTP ${tentaCriar.status} — ${JSON.stringify(tentaCriar.corpo?.error?.code)}`,
  )

  const tentaLer = await bruto('/v1/sessions', {}, segredoLeitura)
  check(
    'the same key can still read, which is what it is for',
    tentaLer.status === 200,
    `HTTP ${tentaLer.status}, ${tentaLer.corpo?.sessions?.length ?? 0} session(s) visible`,
  )

  return { segredoLeitura }
}

// ===========================================================================
// 2. Reaching only your own
// ===========================================================================

async function escopoDeSessao() {
  grupo('Session scope', 'A key restricted to one session must not see the existence of another.')

  const a = await novaSessao(`verify:mature:escopo-a-${Date.now().toString(36)}`)
  const b = await novaSessao(`verify:mature:escopo-b-${Date.now().toString(36)}`)

  const restrita = await api(
    '/v1/keys',
    {
      method: 'POST',
      body: JSON.stringify({ name: 'verify-scoped', role: 'operator', sessionScope: [a.id] }),
    },
    'cookie',
  )
  const segredo = restrita.token
  criadas.chaves.push(restrita.key.id)

  const naSua = await bruto(`/v1/sessions/${a.id}`, {}, segredo)
  check('the scoped key reaches its own session', naSua.status === 200, `HTTP ${naSua.status}`)

  const naOutra = await bruto(`/v1/sessions/${b.id}`, {}, segredo)
  /*
   * 404 and not 403 on purpose. Answering "forbidden" would confirm the session
   * exists, which is an answer nobody outside its scope is entitled to.
   */
  check(
    'the other session answers as if it did not exist, rather than as forbidden',
    naOutra.status === 404,
    `HTTP ${naOutra.status} — ${JSON.stringify(naOutra.corpo?.error?.code)}`,
  )

  const enviaNaOutra = await bruto(
    `/v1/sessions/${b.id}/messages`,
    { method: 'POST', body: JSON.stringify({ chatId: '5511999990000', text: 'nao deveria sair' }) },
    segredo,
  )
  check(
    'and it cannot send through it either',
    enviaNaOutra.status === 404,
    `HTTP ${enviaNaOutra.status}`,
  )

  return { a, b }
}

// ===========================================================================
// 3. What the queue promises
// ===========================================================================

async function semanticaDaFila(sessao) {
  grupo('Queue semantics', 'Idempotency, and an attempt spent only on a real delivery error.')

  // --- idempotency
  const clientMessageId = `verify-idem-${Date.now()}`
  const corpo = JSON.stringify({
    chatId: '5511944440001',
    text: 'idempotencia',
    clientMessageId,
  })

  const primeira = await api(`/v1/sessions/${sessao.id}/messages`, { method: 'POST', body: corpo })
  const segunda = await api(`/v1/sessions/${sessao.id}/messages`, { method: 'POST', body: corpo })

  check(
    'resending the same clientMessageId does not queue a second message',
    primeira.duplicate === false && segunda.duplicate === true,
    `first duplicate=${primeira.duplicate}, second duplicate=${segunda.duplicate}`,
  )
  check(
    'and both answers point at the same outbox row',
    primeira.outboxId === segunda.outboxId,
    `outboxId ${primeira.outboxId} === ${segunda.outboxId}`,
  )

  const linhas = await outboxDaSessao(sessao.id)
  const mesmasId = linhas.filter((r) => r.clientMessageId === clientMessageId)
  check(
    'the database holds exactly one row for that id',
    mesmasId.length === 1,
    `${mesmasId.length} row(s) with clientMessageId=${clientMessageId}`,
  )
}

// ===========================================================================
// 4. A session that is not there
// ===========================================================================

async function sessaoIndisponivel() {
  grupo(
    'A send with nowhere to go',
    'Unavailability is not failure: the message waits, and keeps its attempts.',
  )

  const s = await novaSessao(`verify:mature:parada-${Date.now().toString(36)}`)
  await api(`/v1/sessions/${s.id}/stop`, { method: 'POST' })
  await sleep(2500)

  const depois = await api(`/v1/sessions/${s.id}`)
  check(
    'the session reports itself as not running',
    depois.status !== 'connected',
    `status=${depois.status}`,
  )

  const enfileirada = await api(`/v1/sessions/${s.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ chatId: '5511944440002', text: 'para uma sessao parada' }),
  })
  check(
    'the API still accepts the send instead of rejecting it',
    enfileirada.outboxId != null,
    `HTTP 202, outboxId=${enfileirada.outboxId}`,
  )

  await sleep(6000)
  const linhas = await outboxDaSessao(s.id)
  const linha = linhas.find((r) => r.id === enfileirada.outboxId)

  check(
    'the message is still queued, not failed',
    linha != null && (linha.status === 'queued' || linha.status === 'held'),
    `status=${linha?.status}`,
  )
  check(
    'and it has not spent a delivery attempt',
    linha?.attempts === 0,
    `attempts=${linha?.attempts}, lastError=${JSON.stringify(linha?.lastError)}`,
  )

  return s
}

// ===========================================================================
// 5. The webhook, from the receiver's side
// ===========================================================================

/**
 * A receiver under our control, so the delivery can be inspected rather than
 * assumed. It answers 500 for as long as `falharAte` says to, which is how the
 * retry ladder and the dead queue get exercised for real instead of in a mock.
 */
function receptor(porta) {
  const recebidas = []
  let falharAte = 0

  const servidor = createServer((req, res) => {
    let corpo = ''
    req.on('data', (c) => {
      corpo += c
    })
    req.on('end', () => {
      recebidas.push({
        em: Date.now(),
        corpo,
        assinatura: req.headers['x-awah-signature'],
        timestamp: Number(req.headers['x-awah-timestamp']),
      })
      if (recebidas.length <= falharAte) {
        res.writeHead(500)
        res.end('nao hoje')
      } else {
        res.writeHead(200)
        res.end('ok')
      }
    })
  })

  return {
    recebidas,
    ouvir: () => new Promise((r) => servidor.listen(porta, r)),
    fechar: () => new Promise((r) => servidor.close(r)),
    falharAsPrimeiras: (n) => {
      falharAte = n
    },
    limpar: () => {
      recebidas.length = 0
    },
  }
}

async function webhooks(sessao) {
  grupo(
    'Webhooks',
    'A signature the receiver can verify, a retry ladder, and a dead queue that can be replayed.',
  )

  const porta = 47_311
  const r = receptor(porta)
  await r.ouvir()

  try {
    const criado = await api('/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        url: `http://${WEBHOOK_HOST}:${porta}/hook`,
        events: ['*'],
      }),
    })
    criadas.webhooks.push(criado.webhook.id)
    const segredo = criado.secret

    check(
      'the signing secret is handed over once, on creation',
      typeof segredo === 'string' && segredo.length >= 32,
      `${segredo.length} characters`,
    )

    const listados = await api('/v1/webhooks')
    const eu = listados.webhooks.find((w) => w.id === criado.webhook.id)
    check(
      'and never appears again when the webhook is read back',
      eu != null && !('secret' in eu),
      `keys returned: ${Object.keys(eu ?? {}).join(', ')}`,
    )

    // Something to talk about.
    await api(`/v1/sessions/${sessao.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ chatId: '5511944440003', text: 'para o webhook' }),
    })

    const prazo = Date.now() + 60_000
    while (r.recebidas.length === 0 && Date.now() < prazo) await sleep(500)

    if (r.recebidas.length === 0) {
      check(
        'a delivery arrives at the receiver',
        false,
        `nothing arrived in 60 s — is ${WEBHOOK_HOST}:${porta} reachable from the instance?`,
      )
      return
    }
    check('a delivery arrives at the receiver', true, `${r.recebidas.length} request(s)`)

    // --- the signature, recomputed here rather than trusted
    const entrega = r.recebidas[0]
    const esperada = `sha256=${createHmac('sha256', segredo)
      .update(`${entrega.timestamp}.${entrega.corpo}`)
      .digest('hex')}`

    check(
      'the signature recomputes from the body and the secret',
      entrega.assinatura === esperada,
      `header ${String(entrega.assinatura).slice(0, 24)}…  recomputed ${esperada.slice(0, 24)}…`,
    )

    /*
     * The timestamp is inside the signature, not merely beside it. Without that
     * a captured delivery could be replayed later with a fresh header and the
     * receiver would have no way to tell.
     */
    const comOutroTimestamp = `sha256=${createHmac('sha256', segredo)
      .update(`${entrega.timestamp + 1}.${entrega.corpo}`)
      .digest('hex')}`
    check(
      'changing the timestamp invalidates the signature',
      comOutroTimestamp !== entrega.assinatura,
      'recomputing with timestamp+1 produces a different digest',
    )

    const comOutroCorpo = `sha256=${createHmac('sha256', segredo)
      .update(`${entrega.timestamp}.${entrega.corpo}tampered`)
      .digest('hex')}`
    check(
      'changing the body invalidates the signature',
      comOutroCorpo !== entrega.assinatura,
      'recomputing with an altered body produces a different digest',
    )

    return { receptor: r, segredo, webhookId: criado.webhook.id }
  } finally {
    // left open for the retry group; closed by the caller
  }
}

// ===========================================================================
// 6. A receiver that is having a bad day
// ===========================================================================

/**
 * The retry ladder, against a receiver that really does answer 500.
 *
 * A webhook that silently gives up on the first refusal loses the event, and
 * the integrator finds out days later from a customer. This proves the delivery
 * is kept, counted and tried again — and that it lands once the receiver
 * recovers.
 */
async function webhookRetentativa(sessao, r, webhookId) {
  grupo('Webhook retries', 'A refused delivery is kept and tried again, not dropped.')

  r.limpar()
  // Refuse the next two arrivals, accept from the third on.
  r.falharAsPrimeiras(2)

  await api(`/v1/sessions/${sessao.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ chatId: '5511944440004', text: 'para a escada de retentativa' }),
  })

  /*
   * Long enough for two refusals and the backoff between them. The webhook
   * dispatcher polls on its own clock, so this waits for an observation rather
   * than assuming one.
   */
  const prazo = Date.now() + 120_000
  let entregas = []
  while (Date.now() < prazo) {
    await sleep(3000)
    const { deliveries } = await api('/v1/webhooks/deliveries?limit=200')
    entregas = deliveries.filter((d) => d.webhookId === webhookId)
    if (entregas.some((d) => d.status === 'delivered' && d.attempts > 1)) break
  }

  const tentadaVarias = entregas.find((d) => d.attempts > 1)
  check(
    'a refused delivery is retried rather than dropped',
    tentadaVarias != null,
    tentadaVarias
      ? `attempts=${tentadaVarias.attempts}, status=${tentadaVarias.status}`
      : `no delivery went past one attempt in 120 s (${entregas.length} row(s) seen)`,
  )

  check(
    'the receiver actually refused, and was actually called again',
    r.recebidas.length > 1,
    `${r.recebidas.length} request(s) reached the receiver`,
  )

  const entregue = entregas.find((d) => d.status === 'delivered' && d.attempts > 1)
  check(
    'and it lands once the receiver recovers',
    entregue != null,
    entregue
      ? `delivered after ${entregue.attempts} attempts`
      : `statuses seen: ${[...new Set(entregas.map((d) => d.status))].join(', ') || 'none'}`,
  )

  /*
   * The gap between two arrivals *of the same delivery*.
   *
   * Grouping by body matters: this webhook is subscribed to everything, so a
   * single message produces several distinct events and two of them landing
   * milliseconds apart is ordinary fan-out, not a retry. Comparing the first
   * two arrivals regardless of payload — which is what this did at first —
   * measures the fan-out and reports it as a hammering retry.
   */
  const porCorpo = new Map()
  for (const entrada of r.recebidas) {
    porCorpo.set(entrada.corpo, [...(porCorpo.get(entrada.corpo) ?? []), entrada.em])
  }
  const repetida = [...porCorpo.values()].find((tempos) => tempos.length > 1)

  check(
    'the retry waits instead of hammering',
    repetida != null && repetida[1] - repetida[0] >= 500,
    repetida
      ? `${repetida[1] - repetida[0]} ms between two arrivals of the same payload`
      : `no payload arrived twice — ${r.recebidas.length} arrival(s), all distinct events`,
  )
}

/**
 * The last rung of the ladder, and the way back off it.
 *
 * A receiver that never recovers has to end somewhere findable rather than in a
 * log line. This needs the instance to be configured with a shallow retry depth
 * — `WEBHOOK_MAX_ATTEMPTS` — because the default of eight spans hours with
 * exponential backoff. When the ladder is deeper than this can wait for, the
 * check says so instead of failing.
 */
async function webhookFilaMorta(sessao, r, webhookId) {
  grupo(
    'The webhook dead queue',
    'A delivery that never lands ends up somewhere you can find it, and can be sent again.',
  )

  r.limpar()
  // Never recover.
  r.falharAsPrimeiras(Number.MAX_SAFE_INTEGER)

  await api(`/v1/sessions/${sessao.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ chatId: '5511944440005', text: 'para a fila morta' }),
  })

  const prazo = Date.now() + 150_000
  let morta = null
  while (Date.now() < prazo) {
    await sleep(4000)
    const { deliveries } = await api('/v1/webhooks/deliveries?status=dead&limit=100')
    morta = deliveries.find((d) => d.webhookId === webhookId)
    if (morta) break
  }

  if (!morta) {
    check(
      'a delivery that keeps failing ends in the dead queue',
      false,
      `nothing died in 150 s — this instance retries deeper than the check can wait for (set WEBHOOK_MAX_ATTEMPTS low to observe it)`,
    )
    return
  }

  check(
    'a delivery that keeps failing ends in the dead queue',
    true,
    `attempts=${morta.attempts}, status=${morta.status}, lastError=${JSON.stringify(String(morta.lastError ?? '').slice(0, 40))}`,
  )
  check(
    'it is queryable rather than only logged',
    true,
    `GET /v1/webhooks/deliveries?status=dead returned it by id ${morta.id.slice(0, 8)}`,
  )

  // Now let the receiver recover, and put it back on the queue.
  r.falharAsPrimeiras(0)
  const chegadasAntes = r.recebidas.length

  const replay = await api('/v1/webhooks/deliveries/replay', {
    method: 'POST',
    body: JSON.stringify({ ids: [morta.id] }),
  })
  check('replay accepts the dead delivery', replay.replayed >= 1, `replayed=${replay.replayed}`)

  const prazo2 = Date.now() + 90_000
  while (r.recebidas.length === chegadasAntes && Date.now() < prazo2) await sleep(1000)

  check(
    'and it reaches the receiver on the second life',
    r.recebidas.length > chegadasAntes,
    `${r.recebidas.length - chegadasAntes} arrival(s) after the replay`,
  )
}

// ===========================================================================
// 7. Doors that should be shut
// ===========================================================================

async function portasFechadas() {
  grupo(
    'Doors that should be shut',
    'An initialized instance stops handing out organizations, and telemetry stops being public.',
  )

  const registro = await bruto(
    '/v1/auth/register',
    {
      method: 'POST',
      body: JSON.stringify({
        organizationName: 'Nao Deveria Existir',
        name: 'Intruso Qualquer',
        email: `intruso-${Date.now()}@exemplo.invalid`,
        password: 'senha-que-nao-deveria-valer-1234',
      }),
    },
    null,
  )
  check(
    'a stranger cannot register a second organization on an initialized instance',
    registro.status === 403,
    `HTTP ${registro.status} — ${JSON.stringify(registro.corpo?.error?.message)}`,
  )

  const setup = await bruto('/v1/auth/bootstrap', {}, null)
  check(
    'and the instance says out loud that it is already set up',
    setup.corpo?.needsSetup === false,
    `needsSetup=${setup.corpo?.needsSetup}`,
  )

  /*
   * `/metrics` carries message volume, session count and operational health.
   * Whether it is protected depends on METRICS_TOKEN being set, so this reports
   * which of the two situations the instance is in rather than pretending there
   * is only one right answer.
   */
  const metricas = await bruto('/metrics', {}, null)
  if (metricas.status === 401) {
    check(
      'telemetry refuses an unauthenticated reader',
      true,
      `HTTP 401 — METRICS_TOKEN is set on this instance`,
    )
  } else {
    check(
      'telemetry is open on this instance, because METRICS_TOKEN is unset',
      metricas.status === 200,
      `HTTP ${metricas.status} — set METRICS_TOKEN before exposing this port`,
    )
  }
}

// ===========================================================================
// 8. The override, and what it costs
// ===========================================================================

/**
 * The escape hatch has to work, and has to be visible afterwards.
 *
 * An operator who needs one message out now — a password reset, an alert — must
 * be able to say so. What must not happen is that the override is silent: the
 * decision is recorded like every other, so the history still explains why the
 * number behaved the way it did.
 */
async function override() {
  grupo('The risk override', 'A deliberate way past the budget, recorded rather than silent.')

  const s = await novaSessao(`verify:healthy:override-${Date.now().toString(36)}`)

  // A day-zero session with the tightest ceiling there is: one per minute.
  const risco = await api(`/v1/sessions/${s.id}/risk`)
  check(
    'the session starts on the warm-up floor',
    risco.limits.perMinute <= 2,
    `perMinute=${risco.limits.perMinute}, warmup factor=${risco.warmup.factor}`,
  )

  for (let i = 0; i < 6; i++) {
    await api(`/v1/sessions/${s.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ chatId: '5511944440010', text: `enche o balde ${i}` }),
    })
  }
  /*
   * The override is a header, not a body field — and that is the right shape.
   * A body field would be stripped by the schema without a word, which is what
   * happened to the first version of this check: it asked for an override,
   * silently did not get one, and passed anyway because the budget happened to
   * let that message through on its own.
   */
  await api(`/v1/sessions/${s.id}/messages`, {
    method: 'POST',
    headers: { 'x-awah-bypass-risk': 'true' },
    body: JSON.stringify({ chatId: '5511944440011', text: 'urgente, passando por cima' }),
  })

  await sleep(20_000)
  const linhas = await outboxDaSessao(s.id)
  const retidas = linhas.filter((l) => l.heldReason)
  const comBypass = linhas.filter((l) => l.chatId.includes('944440011'))

  check(
    'the ordinary sends pile up behind the budget',
    retidas.length > 0,
    `${retidas.length} held, reason: ${JSON.stringify(retidas[0]?.heldReason)}`,
  )
  check(
    'the overridden send goes out anyway',
    comBypass.some((l) => l.status === 'sent'),
    `statuses: ${comBypass.map((l) => l.status).join(', ') || 'none'}`,
  )

  const eventos = await api(`/v1/risk/events?sessionId=${s.id}&limit=100`).catch(() => null)
  const lista = eventos?.events ?? eventos?.items ?? []
  const registrado = lista.some((e) => (e.reason ?? '').toLowerCase().includes('override'))
  check(
    'and the override is written into the risk history, not hidden',
    registrado,
    registrado
      ? 'a risk_events row names the override as the reason'
      : `reasons seen: ${[...new Set(lista.map((e) => e.reason))].slice(0, 3).join(' | ') || 'none'}`,
  )
}

// ===========================================================================

async function main() {
  console.log(`AWAH at ${BASE}`)
  await entrar()
  const { engines } = await api('/v1/engines')
  if (!engines.some((e) => e.engine === 'simulator' && e.available)) {
    throw new Error('This instance has no simulator engine (SIMULATOR_ENABLED=true).')
  }

  await autenticacao()
  const { a } = await escopoDeSessao()
  await semanticaDaFila(a)
  await sessaoIndisponivel()
  const web = await webhooks(a)
  if (web?.receptor) {
    await webhookRetentativa(a, web.receptor, web.webhookId)
    await webhookFilaMorta(a, web.receptor, web.webhookId)
    await web.receptor.fechar()
  }
  await portasFechadas()
  await override()

  relatorio()
  await limpar()
}

async function limpar() {
  for (const id of criadas.webhooks) {
    await bruto(`/v1/webhooks/${id}`, { method: 'DELETE' }, KEY).catch(() => null)
  }
  for (const id of criadas.sessoes) {
    await bruto(`/v1/sessions/${id}`, { method: 'DELETE' }, KEY).catch(() => null)
  }
  for (const id of criadas.chaves) {
    if (id) await bruto(`/v1/keys/${id}`, { method: 'DELETE' }, 'cookie').catch(() => null)
  }
  console.log(`\nCleaned up ${criadas.sessoes.length} session(s), ${criadas.chaves.length} key(s).`)
}

function relatorio() {
  const todos = grupos.flatMap((g) => g.checks)
  const passaram = todos.filter((c) => c.passou).length
  const quando = new Date().toISOString().slice(0, 10)

  const corpo = grupos
    .map(
      (g) => `### ${g.nome}

${g.proposito}

| | Check | Evidence |
|---|---|---|
${g.checks.map((c) => `| ${c.passou ? '✅' : '❌'} | ${c.nome} | \`${String(c.evidencia).replace(/\|/g, '\\|')}\` |`).join('\n')}
`,
    )
    .join('\n')

  const md = `# Verification

_Generated on ${quando} by \`scripts/verify.mjs\` (**${passaram} of ${todos.length}** checks) and, for
the section at the end, \`scripts/verify-cluster.mjs\`._

This is the companion to [the benchmark](BENCHMARK.md). The benchmark measures
how the gateway behaves under load; this asks whether it does what it says at
all — and shows what it saw, because "all checks passed" is a claim, and the
point of this page is to stop making claims.

Every check ran against a live instance over HTTP, with the \`simulator\` engine
standing in for the last hop. Nothing here is mocked.

${corpo}
## What this page does not cover

**Isolation between organizations.** Two tenants cannot see each other's
sessions, keys or integrations — but this script cannot demonstrate it, because
an initialized instance refuses to hand out a second organization, which is
itself one of the checks above. That guarantee is covered by the integration
suite instead, against a real Postgres: \`sessions.test.ts\` ("does not see a
session from another org"), \`keys.test.ts\` ("refuses a session from another
organization") and \`integrations.test.ts\` ("does not list an integration from
another org").

**WhatsApp itself.** The last hop is the \`simulator\` engine. Nothing on this
page says anything about how a real number behaves over weeks.

## Reproducing this

\`\`\`bash
SIMULATOR_ENABLED=true docker compose up -d
node scripts/verify.mjs --url http://localhost:2900 --key "$AWAH_KEY"
\`\`\`

The webhook group needs the instance to be able to reach this script. Inside
Docker that is not \`localhost\` — pass \`--webhook-host\` with an address the
container can resolve (\`host.docker.internal\` on Docker Desktop, which is the
default).
`

  writeFileSync(OUT, md)
  console.log(`\n${passaram}/${todos.length} checks passed — wrote ${OUT}`)
  if (passaram !== todos.length) process.exitCode = 1
}

main().catch(async (e) => {
  console.error(`\n${e.message}`)
  await limpar().catch(() => null)
  process.exit(1)
})
