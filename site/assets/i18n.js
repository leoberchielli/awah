/*
 * Languages.
 *
 * The HTML is written in Portuguese — it is what the crawler and anyone
 * without JavaScript receive, and it is the domain's language. English lives
 * here and is applied on top; the original Portuguese is stored on the first
 * pass, so switching back is a restore, not a re-translation. A pair that
 * falls out of sync fails visibly, not silently.
 */
;((global) => {
  const EN = {
    skip: 'Skip to content',

    'nav.flow': 'The flow',
    'nav.risk': 'Risk engine',
    'nav.measured': 'Measured',
    'nav.dashboard': 'Dashboard',
    'nav.start': 'Get started',
    'nav.star': 'Star',
    'theme.toggle': 'Toggle theme',
    'copy.label': 'Copy',
    'copy.aria': 'Copy to clipboard',

    'hero.eyebrow': 'Open source · MIT · multi-architecture Docker image',
    'hero.title1': 'Ten thousand messages, none of them lost.',
    'hero.title2': 'And the number still alive.',
    'hero.lede':
      'Most WhatsApp gateways answer <em>“how do I send a message”</em>. AWAH exists for the second question — the one that shows up when volume does: a durable queue in Postgres, a risk engine that protects the number, and clustered sessions with automatic failover.',
    'hero.cta0': 'Open the demo',
    'hero.cta1': 'Up in 2 minutes',
    'hero.cta2': 'View on GitHub',
    'hero.demo':
      'A real instance with a month of traffic in it — sign in with <code>admin@awah.demo</code> / <code>admin</code>, no sign-up. Only the engine is simulated: nothing there reaches a phone.',
    'hero.note':
      'not 200. The message was persisted — not delivered. That difference is the project’s thesis.',

    'trust.tests': 'tests',
    'trust.checks': 'verified checks',
    'trust.langs': 'languages',
    'trust.license': 'license',

    'thesis.q':
      '“How do I send ten thousand without losing any of them, and without losing the number?”',
    'thesis.a':
      'The queue is the product. The API answers the moment the row is durable, <strong>before any network I/O</strong> — so a process that dies loses nothing. That is not a README promise: it is measured by killing a process with <code>SIGKILL</code> mid-drain.',

    'flow.kicker': 'What happens to a message',
    'flow.title': 'Nothing is discarded. What does not pass now waits — and says why.',
    'flow.sub':
      'The part that separates this from a send button. Every stage records its decision, and every decision stays queryable months later.',
    'flow.aria':
      'A message’s path: POST, outbox in Postgres, budget, risk score, human jitter, engine, ACK reconciliation and signed webhook.',
    'flow.n.budget': 'budget',
    'flow.n.budgetS': 'has a slot?',
    'flow.n.engineS': 'human jitter',
    'flow.n.ack': 'ACK + webhook',
    'flow.n.held': 'held',
    'flow.n.heldS': 'with reason and ETA',
    'flow.n.dlq': 'dead letter',
    'flow.n.dlqS': 'queryable, replayable',
    'flow.l.202': '202',
    'flow.l.reserved': 'reserved',
    'flow.l.scored': 'scored',
    'flow.l.sent': 'sent',
    'flow.l.ack': 'ACK',

    'flow.s1t': 'POST /messages → 202',
    'flow.s1':
      'The row is durable in the outbox before any network I/O. <code>clientMessageId</code> is your idempotency key: repeating the POST returns the original send.',
    'flow.s2t': 'Budget',
    'flow.s2':
      'Sliding windows per minute, hour and day, plus a cap on new contacts. With no slot, the message goes back to the queue with the reason and the real time the window opens.',
    'flow.s3t': 'Score 0–100',
    'flow.s3':
      'Four signals, each with its own weight. Above 40 the pace drops; above 90 it goes to 10% of throughput. It never reaches zero — stopping on its own would be indistinguishable from a bug.',
    'flow.s4t': 'Human jitter',
    'flow.s4':
      'A log-normal interval between sends and a typing presence proportional to the text. A uniform interval produces a regular pattern — exactly what is being avoided.',
    'flow.s5t': 'Refused → retry → dead letter',
    'flow.s5':
      'Exponential backoff. A dropped session does not consume an attempt. Once attempts run out, the message sits in <code>GET /v1/outbox?status=dead</code>, ready to replay.',
    'flow.s6t': 'Signed webhook',
    'flow.s6':
      'HMAC over <code>timestamp.body</code> — not just the body. A captured delivery cannot be replayed later: changing the timestamp invalidates the signature.',

    'grt.1t': 'Ordering per conversation',
    'grt.1':
      'Within a chat, messages leave in the order they came in, and there are never two simultaneous sends to the same recipient. Different chats run in parallel.',
    'grt.2t': 'Nothing is lost',
    'grt.2':
      'The row exists in the database before any network I/O. If the process dies midway, the message goes out later.',
    'grt.3t': 'Unavailability is not failure',
    'grt.3':
      'A session that dropped, or is still pairing, returns the send to the queue without consuming an attempt. Only a real delivery error counts.',
    'grt.4t': 'Nothing is discarded',
    'grt.4':
      'Once attempts run out, the message goes to the DLQ and stays queryable — with replay in one POST.',

    'risk.kicker': 'Risk engine',
    'risk.title':
      'Every other guarantee is worth nothing if the number stops existing on a Tuesday.',
    'risk.sub':
      'Unofficial engines get numbers banned. The engine paces sending the way a person would — and the pace is not a constant: it opens as the number ages.',
    'risk.chart.title': 'Warm-up: the ceiling grows with the number’s age',
    'risk.chart.sub': 'Share of the configured cap the engine releases, by day since pairing.',
    'risk.chart.note':
      'Setting 5,000 per day on a session paired today gives you 250 in practice. That is deliberate: a freshly paired number that sends a thousand messages on day one is the most obvious throwaway-account pattern there is.',
    'risk.tbl.day': 'Day',
    'risk.tbl.pct': 'Ceiling released',
    'risk.tbl.rate': 'Sends/min (cap of 12)',
    'table.summary': 'See the data as a table',
    'risk.sig.title': 'The score, and what each signal weighs',
    'risk.sig.sub': 'Four signals, each with its own weight and its own reason in plain language.',
    'risk.sig.note':
      '<code>GET /v1/risk/events</code> keeps every decision with a snapshot of the budget at that instant — it answers why one specific send was late, months later.',
    'risk.sig.th1': 'Signal',
    'risk.sig.th2': 'Weight',
    'risk.sig.th3': 'Why',

    'risk.c1t': 'Refusing is not one of the options',
    'risk.c1':
      'When the budget is spent, the send goes back to the queue carrying the time the window opens — computed from the oldest send still inside it. No message is thrown away.',
    'risk.c2t': 'Sliding window, not a fixed-hour bucket',
    'risk.c2':
      'A bucket would let you send the whole cap at 13:59 and the whole cap again at 14:00. The window slides.',
    'risk.c3t': 'New contacts per day',
    'risk.c3':
      'A separate cap, because talking to a lot of strangers is the strongest spam signal WhatsApp reads.',

    'meas.kicker': 'Measured, not asserted',
    'meas.title':
      'Four claims that are cheap to write and expensive to verify — so a script verifies them.',
    'meas.sub':
      'The numbers below come from <code>node scripts/benchmark.mjs</code>, which lives in the repository and which you can re-run yourself.',
    'meas.t1l': 'Out-of-order sends within a conversation',
    'meas.t1u': 'of 192 pairs',
    'meas.t1n': 'First attempt, under concurrency.',
    'meas.t2l': 'Refused sends recovered',
    'meas.t2v': 'all of them',
    'meas.t2n': 'None reached the dead-letter queue.',
    'meas.t3l': 'Ingest through the API',
    'meas.t4l': 'Warm-up: day 0 · 3 · 30',
    'meas.t4n': 'Sends/min against ceilings of 1 · 2 · 12.',

    'meas.v.title': '45 checks, each with its evidence',
    'meas.v.body':
      'A second script asks whether the guarantees hold at all, and records what it saw rather than only whether it was happy: a viewer key refused, a webhook signature recomputed from the body and the secret, a delivery refused twice and landed on the third attempt, sixty messages surviving a <code>docker kill</code> mid-drain, and a session taken over by the surviving replica after its owner was killed.',
    'meas.v.note':
      'The script drives Docker on purpose: durability and failover cannot be checked without stopping a process — and a graceful stop is the easy case, so it uses <code>SIGKILL</code>.',
    'meas.v.link': 'Read the verification report',
    'meas.b.link': 'Read the full benchmark',

    'honest.tag': 'What has not been measured yet',
    'honest.body':
      '<strong>This has now run against real numbers</strong> — four of them, roughly 3,700 messages through the Baileys engine, with signed webhooks running throughout and the risk engine pacing the sending, and no number blocked. What is still missing is scale and time: four numbers and a few thousand messages say the path works, not that it holds at ten times the volume, nor how WhatsApp treats a number over months.',
    'honest.sig': 'The mechanics are covered by 419 tests. And a test is still a test.',

    'dash.kicker': 'The dashboard',
    'dash.title':
      'Served by the API itself, on the same origin — and that is not a packaging detail.',
    'dash.sub':
      'It is what lets the dashboard credential be an <code>httpOnly</code> cookie instead of a token in <code>localStorage</code>. On separate origins the browser would require <code>SameSite=None</code>, and the cookie would start travelling on third-party requests.',
    'dash.alt':
      'The AWAH dashboard: delivery funnel, throughput, risk engine decisions, and a session’s risk panel — ending with the whole interface switching language.',
    'dash.cap':
      'Recorded against a live instance. The last few seconds are the panel changing language: it ships in ten, and the reasons a session dropped are translated too, not left in English inside a translated screen.',
    'dash.legib.title': 'On visual legibility',
    'dash.legib.body':
      'State is shape <strong>and</strong> colour: every pill carries a dot on top of its hue, because colour blindness is common and a dashboard that speaks only in colour shuts out part of the people operating it. Every number is in a monospaced font with tabular digits — a column that does not dance when the value changes.',
    'dash.li1':
      'The time window and the session filter live in the <strong>URL</strong>: an operator who sees something odd sends the link and a colleague opens exactly the same screen.',
    'dash.li2':
      'The dashboard highlights the divergence that costs money in silence: a session with <code>desired_state=running</code> that is not running.',
    'dash.li3': 'Light theme, dark theme, and “the system one”, which is the default.',
    'pair.alt':
      'Pairing a number: the QR code beside the four steps, and the session showing as Pairing until the phone accepts.',
    'pair.cap':
      'The code refreshes on its own and the panel closes itself the moment the phone accepts. No curl.',

    'arch.kicker': 'How it is put together',
    'arch.title': 'N replicas behind a load balancer. A session belongs to one replica at a time.',
    'arch.sub':
      'Ownership is a lease in Redis. When the owning replica dies, another notices and takes it over — which is also checked by killing one.',
    'arch.c1': 'Your system',
    'arch.c1s': 'or plain HTTP',
    'arch.c2s': '— N replicas',
    'arch.b1': 'REST API + dashboard',
    'arch.b1s': 'same origin, same port',
    'arch.b2': 'risk engine',
    'arch.b2s': 'budget, warm-up, brake',
    'arch.b3': 'scheduler',
    'arch.b3s': 'FIFO per conversation',
    'arch.b4': 'webhook dispatcher',
    'arch.b4s': 'HMAC, retry, DLQ',
    'arch.c3': 'State',
    'arch.b5s': 'outbox, messages, encrypted auth state',
    'arch.b6s': 'leases, budget windows',
    'arch.c4': 'Engines, one contract',
    'arch.b7s': 'unofficial, free',
    'arch.b8s': 'official, billed',
    'arch.b9s': 'for testing',

    'eng.title': 'What changes when you switch engines',
    'eng.sub':
      'Both sit behind the same <code>EngineAdapter</code>: whoever integrates writes the code once and moves from the unofficial to the official one by changing a single line.',
    'eng.r1': 'QR pairing',
    'eng.r1b': 'no — it is a token',
    'eng.r2': 'Groups',
    'eng.r3': 'Typing presence',
    'eng.r3b': 'does not exist in the API',
    'eng.r4': 'Free-form conversation',
    'eng.r4a': 'always',
    'eng.r4b': 'only inside the 24 h window',
    'eng.r5': 'Ban risk',
    'eng.r5a': 'real',
    'eng.r5b': 'none',
    'eng.r6': 'Cost',
    'eng.r6a': 'zero',
    'eng.r6b': 'per conversation, billed by Meta',
    'eng.yes': 'yes',
    'eng.no': 'no',

    'int.kicker': 'Integrations',
    'int.title': 'There is no inbox and no flow builder here. That is a decision, not a gap.',
    'int.sub':
      'Chatwoot already solves human support; Typebot already solves flows. What all of them lack is precisely what the gateway has.',
    'int.h1': 'Wired straight to Meta',
    'int.h2': 'With AWAH underneath',
    'int.r1': 'Ordering per conversation',
    'int.r1a': 'no guarantee',
    'int.r1b': 'FIFO per chat, chats in parallel',
    'int.r2': 'Lost message',
    'int.r2a': 'fire and forget',
    'int.r2b': 'durable queue, retry, DLQ with replay',
    'int.r3': 'Send pace',
    'int.r3a': 'whatever the tool decides',
    'int.r3b': 'budget, warm-up and adaptive brake',
    'int.r4': 'Duplicate redelivery',
    'int.r4a': 'sends it again',
    'int.r4b': 'idempotency by key',
    'int.r5': 'Delivery state',
    'int.r5a': '“I sent it”',
    'int.r5b': 'sent → delivered → read funnel',
    'int.c1':
      'Two fields: the address and a token. The gateway discovers the rest — the account, the inboxes — and <strong>creates the API inbox with the webhook already pointed at itself</strong>. The three steps that made most people give up do not exist anymore.',
    'int.c2': 'It asks only for the flow’s share link. The address and the id come out of it.',
    'int.c3t': 'Any other platform',
    'int.c3':
      'The HTTP connector posts every received message to your URL and sends back whatever the response carries. With that, n8n, Make, a serverless function or the in-house system become the bot.',
    'int.note':
      'The connection is tested before it is saved: a wrong credential stored in silence would only surface on a real customer’s first message.',

    'warn.title': 'Read this before using it',
    'warn.body':
      'Unofficial engines (Baileys, whatsapp-web.js, whatsmeow) work by reverse-engineering the protocol and <strong>violate WhatsApp’s terms of service</strong>. There is a real and permanent risk of the account being banned.',
    'warn.l1':
      'Use a dedicated number. Never your personal one, never the company’s critical number.',
    'warn.l2': 'The risk engine lowers the odds of a ban. It <strong>guarantees nothing</strong>.',
    'warn.l3':
      'For serious commercial load, use the <code>cloud_api</code> engine — Meta’s official one, no ban risk, billed per conversation.',
    'warn.foot':
      'This project is not affiliated with, associated with, or endorsed by WhatsApp or Meta.',

    'start.kicker': 'Get started',
    'start.title': 'Without cloning anything, with no configuration file to write.',
    'start.sub':
      'The image comes ready from the registry — multi-architecture, amd64 and arm64: it runs the same on a cheap VPS, on an Apple Silicon Mac or on a Raspberry Pi.',
    'start.s1': 'Download the compose file and bring it up',
    'start.s1p':
      'That brings up Postgres and Redis, applies the migrations and starts the API on <code>http://localhost:2900</code>.',
    'start.s2': 'Open it in the browser',
    'start.s2p':
      'The first time it shows the setup screen, where you create the organization and your user. It closes itself after that, and new users come in by invitation.',
    'start.s3': 'Pair, connect, follow along',
    'start.s3p':
      'Three steps, all in the dashboard: pair the number in the <strong>Sessions</strong> tab, connect the tool in <strong>Integrations</strong> and follow it in <strong>Operations</strong>. The interactive reference for every route lives at <code>/docs</code>, with the instance up.',

    'sdk.title': 'TypeScript SDK, no dependencies',
    'sdk.body':
      'Built on <code>fetch</code> and WebCrypto — it runs on Node, Deno, Bun, Cloudflare Workers and in the browser. It retries <code>408</code>, <code>429</code>, <code>5xx</code> and network failures on its own, and does not retry the other <code>4xx</code>, because sending again produces the same rejection.',
    'sdk.body2':
      '<strong>It generates the <code>clientMessageId</code> when you do not pass one</strong>, and that is what makes the automatic retry safe: without an idempotency key, repeating a POST after a network timeout would send the same message twice to the end customer.',

    'cta.title': 'What is missing is real use — and that is where you come in.',
    'cta.body':
      'Twelve waves are closed: queue, risk, cluster, telemetry, dashboard, official engine, SDK, connectors and a published image. What is missing for v1.0 is not code. If you run this against a real number, the report is the most valuable contribution there is right now.',
    'cta.b1': 'Star it on GitHub',
    'cta.b2': 'How to contribute',

    'foot.tag': 'WhatsApp gateway with a durable queue, a risk engine and clustered sessions.',
    'foot.docs': 'Documentation',
    'foot.d0': 'Live demo',
    'foot.d1': 'Getting started',
    'foot.d2': 'Integrations',
    'foot.d3': 'Any platform',
    'foot.d4': 'Production',
    'foot.d5': 'Troubleshooting',
    'foot.project': 'Project',
    'foot.p1': 'Changelog',
    'foot.p2': 'Security',
    'foot.p3': 'Contribute',
    'foot.p4': 'MIT license',
    'foot.legal':
      'Not affiliated with, associated with, or endorsed by WhatsApp or Meta. WhatsApp is a trademark of Meta Platforms, Inc.',
  }

  /* Strings born in JS (axes, series, tooltips) need both sides spelled out. */
  const CHART = {
    pt: {
      'c.warmup.x': 'Dias desde o pareamento',
      'c.warmup.y': '% do limite configurado',
      'c.warmup.series': 'Teto liberado',
      'c.warmup.ref': 'limite configurado',
      'c.warmup.day': 'Dia',
      'c.warmup.pct': 'Teto liberado',
      'c.warmup.rate': 'Envios/min',
      'c.sig.x': 'Peso no score (soma 100)',
      'c.sig.weight': 'Peso',
      'c.sig.1': 'Conversa unilateral',
      'c.sig.2': 'Novos contatos',
      'c.sig.3': 'Falha de entrega',
      'c.sig.4': 'Velocidade',
      'c.sig.1w': 'Gente fala nos dois sentidos; um bot só fala',
      'c.sig.2w': 'Falar com muito desconhecido é o que gera denúncia',
      'c.sig.3w': 'Aponta lista comprada ou velha',
      'c.sig.4w': 'Reage antes de o teto ser atingido',
      'c.copy.done': 'Copiado',
    },
    en: {
      'c.warmup.x': 'Days since pairing',
      'c.warmup.y': '% of the configured cap',
      'c.warmup.series': 'Ceiling released',
      'c.warmup.ref': 'configured cap',
      'c.warmup.day': 'Day',
      'c.warmup.pct': 'Ceiling released',
      'c.warmup.rate': 'Sends/min',
      'c.sig.x': 'Weight in the score (sums to 100)',
      'c.sig.weight': 'Weight',
      'c.sig.1': 'One-sided conversation',
      'c.sig.2': 'New contacts',
      'c.sig.3': 'Delivery failure',
      'c.sig.4': 'Speed',
      'c.sig.1w': 'People talk in both directions; a bot only talks',
      'c.sig.2w': 'Talking to a lot of strangers is what gets you reported',
      'c.sig.3w': 'Points to a bought or stale list',
      'c.sig.4w': 'Reacts before the cap is hit',
      'c.copy.done': 'Copied',
    },
  }

  const BILINGUAL = [
    'getting-started',
    'integrations',
    'any-platform',
    'production',
    'troubleshooting',
    'CONTRIBUTING',
    'SECURITY',
    'CHANGELOG',
    'README',
  ]

  let current = document.documentElement.getAttribute('data-lang') === 'en' ? 'en' : 'pt'
  let cached = false

  function cachePT() {
    if (cached) return
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.setAttribute('data-pt', el.innerHTML)
    })
    document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      el.getAttribute('data-i18n-attr')
        .split(',')
        .forEach((pair) => {
          const attr = pair.split(':')[0].trim()
          el.setAttribute(`data-pt-${attr}`, el.getAttribute(attr) || '')
        })
    })
    cached = true
  }

  function apply(lang) {
    cachePT()
    const en = lang === 'en'
    current = en ? 'en' : 'pt'

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n')
      const val = en ? EN[key] : el.getAttribute('data-pt')
      if (val != null) el.innerHTML = val
    })

    document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
      el.getAttribute('data-i18n-attr')
        .split(',')
        .forEach((pair) => {
          const bits = pair.split(':')
          const attr = bits[0].trim()
          const key = bits[1].trim()
          const val = en ? EN[key] : el.getAttribute(`data-pt-${attr}`)
          if (val != null) el.setAttribute(attr, val)
        })
    })

    /*
     * The repository documentation is bilingual through the filename suffix —
     * but only part of it. VERIFICATION.md and BENCHMARK.md are generated by a
     * script and exist in English only, so swapping the suffix there gives a 404.
     */
    document.querySelectorAll('a[href*=".md"]').forEach((a) => {
      const href = a.getAttribute('href')
      const base = href.split('/').pop().replace('.pt-BR.md', '').replace('.md', '')
      if (BILINGUAL.indexOf(base) === -1) return
      a.setAttribute(
        'href',
        en
          ? href.replace('.pt-BR.md', '.md')
          : href.replace(/\.pt-BR\.md$/, '.md').replace(/\.md$/, '.pt-BR.md'),
      )
    })

    document.documentElement.setAttribute('lang', en ? 'en' : 'pt-BR')
    document.documentElement.setAttribute('data-lang', current)
    document.querySelectorAll('[data-lang-set]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-lang-set') === current))
    })

    try {
      localStorage.setItem('awah-lang', current)
    } catch (_e) {}
    document.dispatchEvent(new CustomEvent('awah:lang', { detail: { lang: current } }))
  }

  global.AWAH_I18N = {
    apply: apply,
    lang: () => current,
    t: (key) => CHART[current]?.[key] || CHART.pt[key] || key,
  }
})(window)
