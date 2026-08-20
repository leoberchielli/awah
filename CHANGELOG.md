# Changelog

*[Português](CHANGELOG.pt-BR.md)*

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project follows [SemVer](https://semver.org/) from v1.0 onward.

## [Unreleased]

Everything below is on `main` and has not been released. Numbering starts at
v1.0, once the whole thing has been exercised against real traffic.

### Added

**Foundation**

- pnpm monorepo with Fastify 5, TypeScript and Drizzle over Postgres and Redis.
- Two-credential authentication: user session via signed cookie (argon2id) and
  API key via bearer (the secret is stored only as a hash).
- RBAC with four roles and per-key session scope. An API key never administers
  identity.
- Multi-stage Docker image with a non-root user, `tini` as PID 1 and a
  healthcheck. CI with real Postgres and Redis.

**Engines**

- `EngineAdapter` contract and a capability matrix published at `GET /v1/engines`.
- Baileys adapter with auth state encrypted in Postgres — this is what makes
  failover possible.
- Cloud API adapter behind the same contract, with encrypted credentials and a
  Meta webhook whose signature is verified over the raw bytes.
- Table of translated disconnect codes, with automatic reconnection only in the
  cases where reconnecting helps.

**Queue**

- Transactional outbox with total ordering by `seq` and FIFO per conversation,
  with different chats running in parallel.
- Idempotency by `clientMessageId`.
- Retry with backoff, a queryable dead-letter queue and replay.
- A session that is down or pairing returns the send to the queue **without**
  consuming an attempt.

**Risk engine**

- Sliding-window budget (minute, hour, day) and a separate daily cap for new
  contacts.
- Warm-up curve: 5% of the cap on day one, 100% by day thirty.
- Score 0–100 from four signals, with each signal's contribution exposed.
- Log-normal jitter and typing presence proportional to the text.
- Never drops: whatever does not pass now is held, with a real ETA.

**Cluster**

- Session ownership by lease in Redis, with no primary node and no election.
- Automatic failover measured at ~20 s with `SIGKILL`.
- Commands routed to the owning node over pub/sub; QR shared across replicas.
- Intent (`desired_state`) kept separate from state (`status`).

**Observability**

- Hourly aggregates and four KPI families.
- `/metrics` in Prometheus format, protected by a token.
- Instrumentation with the OpenTelemetry API, no bundled SDK.

**Dashboard**

- React dashboard served by the API itself, on the same origin — this is what
  allows an `httpOnly` cookie instead of a token in `localStorage`.
- Six screens: operations, business, sessions, integrations, keys and users,
  with the window and filter in the URL.
- API keys are issued, scoped and revoked from the panel. The token appears
  exactly once, and a scope that reaches no session is refused with the reason.
- Members are added, promoted and removed from the panel. The last owner cannot
  be demoted or removed, and the panel says so before the server has to.
- Light, dark and system themes.
- Glass surfaces on the chrome and the cards, over an ambient layer that gives
  the blur something to refract. It stops at the large, few surfaces: list rows,
  pills and table cells stay opaque, because `backdrop-filter` on hundreds of
  elements is what turns "modern" into "sluggish". Contrast was measured on
  every screen in both themes; the worst pair is 4.62 against a 4.5 minimum.

**SDK**

- `@awah/sdk`: dependency-free TypeScript client, built on `fetch` and WebCrypto.
- Automatic idempotency on send, which is what makes the built-in retry safe.
- Webhook signature verification that runs on Node, Deno, Bun, Workers and in
  the browser.

**Integrations**

- Native Chatwoot and Typebot connectors, wired per session. The decision behind
  them: rather than build our own inbox and flow builder, be the transport for
  the people who already solved those two things well — and deliver underneath
  them what neither has, which is a durable queue, per-conversation ordering and
  a risk engine.
- Chatwoot in both directions, with echo prevention by `source_id` and
  idempotency on their message id, which makes their redelivery harmless.
- Typebot with a per-contact flow session, expiry on silence, and an escape to a
  human agent that does not go through the flow.
- Credentials encrypted and never returned on read; the connection is tested
  before saving, because a wrong credential stored silently would only show up
  on the first message from a real customer.
- A failure in an external tool never takes the session down: the dispatcher
  swallows its own exception and records the error on the integration, so the
  dashboard can explain the silence.

**Adoption**

- First-run screen in the dashboard. The only way to create the initial
  organization was to assemble a `curl` from the README — the most expensive
  blocker a self-hosted project can have, because it comes before the person
  sees any value at all.
- Chatwoot now asks for two fields: address and token. The gateway discovers the
  accounts, lists the inboxes and **creates the API inbox with the webhook
  already pointed back at itself**. Hunting for `accountId` and `inboxId` in the
  URL and going back there to paste the webhook were the three steps that made
  the most people give up.
- Typebot accepts the share link in place of a separate address and `publicId`,
  and rejects the editor link while explaining where the right one is — rather
  than accepting it and failing later, on the first message from a real
  customer.

**Any platform**

- Generic HTTP connector: the gateway posts the incoming message to a URL and
  sends back whatever the response carries. It is the escape hatch that keeps
  plugging in a new tool from depending on someone writing a dedicated
  connector — n8n, Make, a serverless function or an in-house system all come in
  through it with no code change.
- Unlike an ordinary webhook, which notifies and forgets: here the response
  **is** the message, and it enters through the same queue as any other send,
  with per-conversation ordering, risk engine and redelivery.
- Accepts the response shapes that show up in practice (`reply`, `replies`,
  `text`, array, string) and, when nothing is recognized, returns a diagnosis of
  why instead of going silent.
- HMAC signature on the same scheme as the webhooks, so anyone already
  validating one validates the other with the same SDK function.
- Test button that sends a sample event and shows status, timing, raw body and
  what would have been sent.

**Language**

- The panel ships in ten languages — English, Portuguese, Spanish, Hindi,
  Indonesian, Arabic, French, German, Russian and Turkish — picked from the
  menu, each written in its own language. Arabic flips the layout to RTL.
- Catalogs are typed as a `Partial` of the English one and load on demand, one
  chunk each: a partial translation compiles and ships, and an eleventh language
  costs nothing to anyone who does not pick it. `pnpm i18n:check` reports
  coverage and fails on a lost placeholder — the mistake that makes a number
  disappear at runtime with nothing else to catch it.
- Numbers, dates and durations come from `Intl`, not from the catalog, so they
  follow the reader's language. This is what a catalog cannot express: Arabic
  needs four plural forms for a count and Russian three, and a single string
  holds one.
- English is the default of the platform, the documentation and the source. The
  API messages, the OpenAPI schemas, every code comment and every identifier are
  in English; the Portuguese documentation sits alongside as a translation.

**Distribution**

- Image published at `ghcr.io/leoberchielli/awah`, multi-architecture
  (amd64 and arm64). CI already built the image to prove the Dockerfile
  compiles and then threw the result away — which forced anyone who wanted to
  try it to clone the repository and build before seeing the first screen.
- `docker-compose.yml` now pulls the image instead of building it, and runs on
  its own: download that file and bring it up, that is the whole path. Building
  from source became the `docker-compose.dev.yml` override.
- Data in named volumes, not in repository folders — someone who downloaded only
  the compose file has no repository at all.
- OCI labels, and `GET /health` returning the image version and commit: the
  first question in any support thread, answered without opening the container.
- Signed provenance attestation on every publish, verifiable with
  `gh attestation verify`.

### Security

- Under `NODE_ENV=production`, the API refuses to start with the development
  secrets published in this repository.
- `TRUST_PROXY` is now configurable and ships as `false`. It used to be
  hardcoded `true`, which let any client choose its own IP via
  `X-Forwarded-For` and escape the rate limit.
- Hand-written CSP, active in every environment. It used to apply only in
  production, which meant finding out what it broke at deploy time.
- The Cloud API `appSecret` is now required. While it was optional, there was an
  anonymous path for injecting fake messages into any customer's account.
- Configurable request body cap, 1 MiB by default.
- Boot warning when `METRICS_TOKEN` is not set.

### Fixed

**The budget did not hold under concurrency.**

The risk engine read its sliding windows, decided, and recorded the send after
delivery. Between those two steps sat the typing indicator, the human jitter of
several seconds and the round trip to the engine — and the scheduler runs fifty
sends at a time. Every worker inside that gap read the same empty window and
every one of them was let through.

The effect was not subtle. A benchmark caught a session capped at one message
per minute sending twenty-six in twenty seconds; a direct measurement put forty
concurrent sends through a cap of five. In other words the headline feature of
this project — pacing a number so it does not get banned — was not doing its
job whenever traffic actually arrived, which is the only time it matters.

The counting and the reservation now happen inside one Redis script, so they
are a single indivisible step no matter how many workers ask at once. A slot
that never becomes a send is given back, so a session having a bad afternoon
does not spend its daily allowance on messages nobody received. `check` stays
read-only for the dashboard: reporting on a budget must not consume it.

Anyone running this before now should assume their numbers were sending faster
than the limits they configured.

**Failover skipped the simulator, so failover went untested.**

The scanner that adopts orphaned sessions selected `engine = 'baileys'`. That
is right for the Cloud API — stateless HTTP holds no socket and there is
nothing to adopt — but it also excluded the simulator, which does hold one. The
practical effect was circular: the only engine that could exercise failover
without a real handset was the one engine failover ignored, so the path stayed
unverified. It now selects the engines that hold a socket, and a live run kills
the owning replica and watches the other take the session over and send through
it.

### Notes

The delivery funnel, the risk engine under load and the retry path have now been
exercised end to end — against a simulated number, not a real one.

A `simulator` engine sits behind the same `EngineAdapter` contract as Baileys and
the Cloud API, so everything upstream of the last hop runs unchanged: the outbox
ordering, the sliding-window budget, the warm-up curve, the human jitter, the ACK
reconciliation and the webhook fan-out. A 300-message run over three sessions
produced 209 sends, 208 deliveries, 310 inbound messages, 1,834 budget holds and
5 engine refusals that the outbox retried and delivered. None of those paths had
ever run before.

What that does *not* cover is the last hop itself. Baileys' own protocol
behaviour — real ACK semantics, real disconnect codes, what WhatsApp actually
does to a number sending at these rates — still has not been through a real
device, and a simulator cannot answer it by construction.

`SIMULATOR_ENABLED` refuses to boot under `NODE_ENV=production`: a fake engine
left on accepts every send and reports it delivered with nothing reaching a
phone, and nothing on the dashboard would look wrong.
