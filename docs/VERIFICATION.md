# Verification

_Generated on 2026-08-20 by `scripts/verify.mjs` (**32 of 32** checks) and, for
the section at the end, `scripts/verify-cluster.mjs`._

This is the companion to [the benchmark](BENCHMARK.md). The benchmark measures
how the gateway behaves under load; this asks whether it does what it says at
all — and shows what it saw, because "all checks passed" is a claim, and the
point of this page is to stop making claims.

Every check ran against a live instance over HTTP, with the `simulator` engine
standing in for the last hop. Nothing here is mocked.

### Authentication and authorization

Every route behind a credential, and a credential that reaches only what it was given.

| | Check | Evidence |
|---|---|---|
| ✅ | a request with no credential is refused | `HTTP 401` |
| ✅ | an invented bearer token is refused | `HTTP 401 — "unauthorized"` |
| ✅ | an API key cannot create another API key | `HTTP 403 — "API keys do not run this operation — use a user session."` |
| ✅ | a viewer key cannot create a session | `HTTP 403 — "forbidden"` |
| ✅ | the same key can still read, which is what it is for | `HTTP 200, 5 session(s) visible` |

### Session scope

A key restricted to one session must not see the existence of another.

| | Check | Evidence |
|---|---|---|
| ✅ | the scoped key reaches its own session | `HTTP 200` |
| ✅ | the other session answers as if it did not exist, rather than as forbidden | `HTTP 404 — "not_found"` |
| ✅ | and it cannot send through it either | `HTTP 404` |

### Queue semantics

Idempotency, and an attempt spent only on a real delivery error.

| | Check | Evidence |
|---|---|---|
| ✅ | resending the same clientMessageId does not queue a second message | `first duplicate=false, second duplicate=true` |
| ✅ | and both answers point at the same outbox row | `outboxId 7eb72c65-52ed-4c32-aec6-71f084a0f9b1 === 7eb72c65-52ed-4c32-aec6-71f084a0f9b1` |
| ✅ | the database holds exactly one row for that id | `1 row(s) with clientMessageId=verify-idem-1787267549666` |

### A send with nowhere to go

Unavailability is not failure: the message waits, and keeps its attempts.

| | Check | Evidence |
|---|---|---|
| ✅ | the session reports itself as not running | `status=disconnected` |
| ✅ | the API still accepts the send instead of rejecting it | `HTTP 202, outboxId=f017a696-45cf-4455-9f8f-99841c5534e1` |
| ✅ | the message is still queued, not failed | `status=queued` |
| ✅ | and it has not spent a delivery attempt | `attempts=0, lastError=null` |

### Webhooks

A signature the receiver can verify, a retry ladder, and a dead queue that can be replayed.

| | Check | Evidence |
|---|---|---|
| ✅ | the signing secret is handed over once, on creation | `43 characters` |
| ✅ | and never appears again when the webhook is read back | `keys returned: id, url, events, sessionScope, active, createdAt` |
| ✅ | a delivery arrives at the receiver | `1 request(s)` |
| ✅ | the signature recomputes from the body and the secret | `header sha256=fd7b749dad3853529…  recomputed sha256=fd7b749dad3853529…` |
| ✅ | changing the timestamp invalidates the signature | `recomputing with timestamp+1 produces a different digest` |
| ✅ | changing the body invalidates the signature | `recomputing with an altered body produces a different digest` |

### Webhook retries

A refused delivery is kept and tried again, not dropped.

| | Check | Evidence |
|---|---|---|
| ✅ | a refused delivery is retried rather than dropped | `attempts=2, status=delivered` |
| ✅ | the receiver actually refused, and was actually called again | `9 request(s) reached the receiver` |
| ✅ | and it lands once the receiver recovers | `delivered after 2 attempts` |
| ✅ | the retry waits instead of hammering | `6305 ms between two arrivals of the same payload` |

### Doors that should be shut

An initialized instance stops handing out organizations, and telemetry stops being public.

| | Check | Evidence |
|---|---|---|
| ✅ | a stranger cannot register a second organization on an initialized instance | `HTTP 403 — "This instance is already initialized. Ask an administrator for an invite."` |
| ✅ | and the instance says out loud that it is already set up | `needsSetup=false` |
| ✅ | telemetry refuses an unauthenticated reader | `HTTP 401 — METRICS_TOKEN is set on this instance` |

### The risk override

A deliberate way past the budget, recorded rather than silent.

| | Check | Evidence |
|---|---|---|
| ✅ | the session starts on the warm-up floor | `perMinute=1, warmup factor=0.05` |
| ✅ | the ordinary sends pile up behind the budget | `5 held, reason: "Cap of 1 messages per minute reached"` |
| ✅ | the overridden send goes out anyway | `statuses: sent` |
| ✅ | and the override is written into the risk history, not hidden | `a risk_events row names the override as the reason` |

## What this page does not cover

**Isolation between organizations.** Two tenants cannot see each other's
sessions, keys or integrations — but this script cannot demonstrate it, because
an initialized instance refuses to hand out a second organization, which is
itself one of the checks above. That guarantee is covered by the integration
suite instead, against a real Postgres: `sessions.test.ts` ("does not see a
session from another org"), `keys.test.ts` ("refuses a session from another
organization") and `integrations.test.ts` ("does not list an integration from
another org").

**The dead-letter queue for webhooks.** A delivery gives up after eight
attempts with exponential backoff, which takes long enough that waiting for it
here would make the script useless. The retry ladder is exercised above; the
last rung is covered by the test suite.

**WhatsApp itself.** The last hop is the `simulator` engine. Nothing on this
page says anything about how a real number behaves over weeks.

## Reproducing this

```bash
SIMULATOR_ENABLED=true docker compose up -d
node scripts/verify.mjs --url http://localhost:2900 --key "$AWAH_KEY"
```

The webhook group needs the instance to be able to reach this script. Inside
Docker that is not `localhost` — pass `--webhook-host` with an address the
container can resolve (`host.docker.internal` on Docker Desktop, which is the
default).

## Killing things

The two guarantees that cannot be checked without stopping a process. Driven by
`scripts/verify-cluster.mjs`, which uses `docker kill` — SIGKILL, not a
graceful stop, because a clean shutdown is the easy case.

### Durability across a crash

The row exists in Postgres before any network I/O, so killing the process loses nothing.

| | Check | Evidence |
|---|---|---|
| ✅ | the queue accepted the batch | `60 messages queued` |
| ✅ | the drain is underway, with sends in flight | `29 sent, 12 in flight, 31 still to go` |
| ✅ | the replica comes back on its own | `back in 2.0 s after SIGKILL` |
| ✅ | every queued message is accounted for after the crash | `60 rows for 60 queued` |
| ✅ | nothing is left stuck in flight by the dead process | `0 row(s) still marked sending` |
| ✅ | and everything eventually goes out | `60 sent, 0 dead, of 60` |

### Failover with a connected session

A session is owned by one replica through a lease. When that replica dies, another takes it.

| | Check | Evidence |
|---|---|---|
| ✅ | the session is connected and owned by a node | `owner=awah-1` |
| ✅ | the surviving replica takes the session over | `awah-1 → awah-2 in 16.1 s` |
| ✅ | and the session sends again on the node that inherited it | `status=sent, engineMessageId=SIM978847d11` |
