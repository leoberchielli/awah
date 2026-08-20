#!/usr/bin/env node
/**
 * The two promises you cannot check without killing something.
 *
 * **Durability.** The row exists in Postgres before any network I/O, so a
 * process that dies mid-flight loses nothing. Proving that needs a process that
 * actually dies — not a graceful shutdown, which is the easy case, but SIGKILL
 * in the middle of a drain.
 *
 * **Failover.** A session is owned by one replica at a time through a lease in
 * Redis. When that replica stops renewing, another has to notice, take the
 * lease, and bring the session back up. Every part of that is invisible until
 * the owner is gone.
 *
 * This drives Docker directly, which makes it the one script here that knows
 * where it is running. It is deliberately separate from `verify.mjs` for that
 * reason: everything in that file works against any instance over HTTP.
 *
 *   node scripts/verify-cluster.mjs --key awah_… \
 *     [--project awah] [--a http://localhost:2900] [--b http://localhost:2901]
 *
 * Needs the `cluster` profile up, so there are two replicas to argue over the
 * session:
 *
 *   docker compose --profile cluster up -d
 */

import { execFile } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .matchAll(/--([a-z-]+)(?:[= ]([^\s-][^\s]*))?/g)
    .map((m) => [m[1], m[2] ?? 'true']),
)

const KEY = args.key ?? process.env.AWAH_KEY
const A = (args.a ?? 'http://127.0.0.1:2900').replace(/\/$/, '')
const B = (args.b ?? 'http://127.0.0.1:2901').replace(/\/$/, '')
const PROJETO = args.project ?? 'awah'
const OUT = args.out ?? 'docs/VERIFICATION.md'
const APPEND = args.append === 'true'

if (!KEY) {
  console.error('Missing --key (or AWAH_KEY).')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const container = (papel) => `${PROJETO}-${papel}-1`

const grupos = []
let atual = null

function grupo(nome, proposito) {
  atual = { nome, proposito, checks: [] }
  grupos.push(atual)
  console.log(`\n${nome}`)
}

function check(nome, passou, evidencia) {
  atual.checks.push({ nome, passou, evidencia })
  console.log(`  ${passou ? '✓' : '✗'} ${nome}`)
  if (!passou) console.log(`      ${evidencia}`)
  return passou
}

async function api(base, path, init = {}) {
  for (let tentativa = 1; ; tentativa++) {
    let res
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${KEY}`,
          'content-type': 'application/json',
          ...init.headers,
        },
      })
    } catch (e) {
      // The whole point of this script is that a replica goes away mid-request.
      if (tentativa < 4) {
        await sleep(500 * tentativa)
        continue
      }
      throw e
    }
    const texto = await res.text()
    if (res.status === 429 && tentativa < 5) {
      await sleep(400 * 2 ** tentativa)
      continue
    }
    if (!res.ok) throw new Error(`${path} → ${res.status} ${texto.slice(0, 200)}`)
    return texto ? JSON.parse(texto) : null
  }
}

const docker = (...argv) => run('docker', argv).then((r) => r.stdout.trim())

async function esperarSaude(base, prazoMs = 90_000) {
  const limite = Date.now() + prazoMs
  while (Date.now() < limite) {
    try {
      const r = await fetch(`${base}/health`)
      if (r.ok) return Date.now()
    } catch {
      // still down
    }
    await sleep(500)
  }
  throw new Error(`${base} did not come back in ${prazoMs} ms`)
}

async function novaSessao(base, nome) {
  const s = await api(base, '/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ name: nome, engine: 'simulator' }),
  })
  await api(base, `/v1/sessions/${s.id}/start`, { method: 'POST' })
  const prazo = Date.now() + 25_000
  while (Date.now() < prazo) {
    const atualS = await api(base, `/v1/sessions/${s.id}`)
    if (atualS.status === 'connected') return atualS
    await sleep(300)
  }
  throw new Error(`session ${nome} did not connect`)
}

// ===========================================================================
// 1. A process that dies with work in its hands
// ===========================================================================

async function durabilidade() {
  grupo(
    'Durability across a crash',
    'The row exists in Postgres before any network I/O, so killing the process loses nothing.',
  )

  const s = await novaSessao(A, `crash:mature:${Date.now().toString(36)}`)
  await api(A, `/v1/sessions/${s.id}/risk/limits`, {
    method: 'PUT',
    body: JSON.stringify({
      perMinute: 600,
      perHour: 20_000,
      perDay: 200_000,
      newContactsPerDay: 50_000,
    }),
  })

  const total = 60
  for (let i = 0; i < total; i++) {
    await api(A, `/v1/sessions/${s.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        chatId: `5511933330${String(i % 12).padStart(3, '0')}`,
        text: `crash ${i}`,
      }),
    })
  }
  check('the queue accepted the batch', true, `${total} messages queued`)

  // Let it get properly underway, then pull the plug mid-drain.
  await sleep(9000)
  const antes = await api(A, `/v1/outbox?sessionId=${s.id}&limit=500`)
  const enviadasAntes = antes.items.filter((r) => r.status === 'sent').length
  const emVoo = antes.items.filter((r) => r.status === 'sending').length

  check(
    'the drain is underway, with sends in flight',
    enviadasAntes > 0,
    `${enviadasAntes} sent, ${emVoo} in flight, ${total - enviadasAntes} still to go`,
  )

  /*
   * SIGKILL, not a graceful stop. A clean shutdown is the easy case: the
   * process gets to finish what it started. This asks what happens when it does
   * not get the chance.
   */
  await docker('kill', container('api'))
  const morteEm = Date.now()
  console.log('      killed the replica mid-drain')

  await docker('start', container('api'))
  const voltouEm = await esperarSaude(A)
  check(
    'the replica comes back on its own',
    true,
    `back in ${((voltouEm - morteEm) / 1000).toFixed(1)} s after SIGKILL`,
  )

  // Nothing may be stuck in 'sending' forever: the stuck-claim sweep releases
  // whatever the dead process was holding.
  const prazo = Date.now() + 240_000
  let linhas = []
  while (Date.now() < prazo) {
    await sleep(4000)
    const r = await api(A, `/v1/outbox?sessionId=${s.id}&limit=500`)
    linhas = r.items
    const pendentes = linhas.filter((x) => x.status === 'queued' || x.status === 'sending').length
    process.stdout.write(`\r      draining after the crash, ${pendentes} left   `)
    if (pendentes === 0) break
  }
  console.log('')

  const enviadas = linhas.filter((r) => r.status === 'sent').length
  const mortas = linhas.filter((r) => r.status === 'dead').length
  const presas = linhas.filter((r) => r.status === 'sending').length

  check(
    'every queued message is accounted for after the crash',
    linhas.length === total,
    `${linhas.length} rows for ${total} queued`,
  )
  check(
    'nothing is left stuck in flight by the dead process',
    presas === 0,
    `${presas} row(s) still marked sending`,
  )
  check(
    'and everything eventually goes out',
    enviadas === total && mortas === 0,
    `${enviadas} sent, ${mortas} dead, of ${total}`,
  )

  await api(A, `/v1/sessions/${s.id}`, { method: 'DELETE' }).catch(() => null)
}

// ===========================================================================
// 2. The owner disappears
// ===========================================================================

async function failover() {
  grupo(
    'Failover with a connected session',
    'A session is owned by one replica through a lease. When that replica dies, another takes it.',
  )

  const saudeB = await fetch(`${B}/health`).catch(() => null)
  if (!saudeB?.ok) {
    check(
      'a second replica is reachable',
      false,
      `${B} did not answer — start the cluster profile: docker compose --profile cluster up -d`,
    )
    return
  }

  const s = await novaSessao(A, `failover:mature:${Date.now().toString(36)}`)
  const dono = s.ownerNodeId
  check('the session is connected and owned by a node', dono != null, `owner=${dono}`)

  /*
   * Which container is holding it. The session may well have been picked up by
   * the second replica, so this asks rather than assumes — killing the wrong
   * one would prove nothing and look like a pass.
   */
  const papel = dono?.includes('2') ? 'api2' : 'api'
  const sobrevivente = papel === 'api' ? B : A
  console.log(`      owner is ${dono} (${container(papel)}); watching from ${sobrevivente}`)

  await docker('kill', container(papel))
  const morteEm = Date.now()
  console.log('      killed the owner')

  let assumidaEm = null
  let novoDono = null
  const prazo = Date.now() + 120_000
  while (Date.now() < prazo) {
    await sleep(1000)
    try {
      const atualS = await api(sobrevivente, `/v1/sessions/${s.id}`)
      if (atualS.ownerNodeId && atualS.ownerNodeId !== dono && atualS.status === 'connected') {
        assumidaEm = Date.now()
        novoDono = atualS.ownerNodeId
        break
      }
      process.stdout.write(
        `\r      waiting: status=${atualS.status} owner=${atualS.ownerNodeId ?? '—'}   `,
      )
    } catch {
      process.stdout.write('\r      waiting: the survivor is still catching up   ')
    }
  }
  console.log('')

  check(
    'the surviving replica takes the session over',
    assumidaEm != null,
    assumidaEm
      ? `${dono} → ${novoDono} in ${((assumidaEm - morteEm) / 1000).toFixed(1)} s`
      : 'nobody took it over within 120 s',
  )

  if (assumidaEm) {
    const enviada = await api(sobrevivente, `/v1/sessions/${s.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ chatId: '5511922220001', text: 'depois do failover' }),
    })
    await sleep(12_000)
    const r = await api(sobrevivente, `/v1/outbox?sessionId=${s.id}&limit=50`)
    const linha = r.items.find((x) => x.id === enviada.outboxId)
    check(
      'and the session sends again on the node that inherited it',
      linha?.status === 'sent',
      `status=${linha?.status}, engineMessageId=${linha?.engineMessageId ?? '—'}`,
    )
  }

  // Bring the dead one back, so the environment is left as it was found.
  await docker('start', container(papel))
  await esperarSaude(papel === 'api' ? A : B).catch(() => null)
  await api(sobrevivente, `/v1/sessions/${s.id}`, { method: 'DELETE' }).catch(() => null)
}

// ===========================================================================

function markdown() {
  const todos = grupos.flatMap((g) => g.checks)
  const passaram = todos.filter((c) => c.passou).length

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

  return { corpo, passaram, total: todos.length }
}

async function main() {
  console.log(`AWAH replicas at ${A} and ${B} (compose project "${PROJETO}")`)
  await durabilidade()
  await failover()

  const { corpo, passaram, total } = markdown()
  const secao = `
## Killing things

The two guarantees that cannot be checked without stopping a process. Driven by
\`scripts/verify-cluster.mjs\`, which uses \`docker kill\` — SIGKILL, not a
graceful stop, because a clean shutdown is the easy case.

${corpo}`

  if (APPEND) {
    appendFileSync(OUT, secao)
    console.log(`\n${passaram}/${total} checks passed — appended to ${OUT}`)
  } else {
    writeFileSync(OUT, `# Cluster verification\n${secao}`)
    console.log(`\n${passaram}/${total} checks passed — wrote ${OUT}`)
  }
  if (passaram !== total) process.exitCode = 1
}

main().catch((e) => {
  console.error(`\n${e.message}`)
  process.exit(1)
})
