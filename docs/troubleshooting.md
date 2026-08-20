# Troubleshooting

*[Português](troubleshooting.pt-BR.md)*

The symptoms that actually show up, and what each one usually turns out to be.

## The session won't pair

**No QR appears.** `GET /v1/sessions/:id/qr` returns 404 when there is no pairing
in progress. Check, in this order:

1. Is the session `pairing`? `GET /v1/sessions/:id`. If it is `created`, `start`
   was never called, or it failed.
2. Does `GET /v1/sessions/:id/events` show a `pairing_requested`? If not, the
   engine never got as far as opening the socket.
3. `ENGINE_LOG_LEVEL=debug` and restart. This is the first thing to do when a
   session refuses to pair — Baileys says plenty at that level.

**The QR appears but the phone rejects it.** The code expires in seconds. Fetch
`/qr` **after** `start` and refresh it while the state is `pairing`; the dashboard
does that every two seconds. A QR from ten seconds ago has already failed.

**Paired, then dropped right away with 515.** Not a failure. The protocol requires
recreating the socket after pairing and signals that with 515; the manager
reconnects in 750 ms. If it loops on 515, then you do have a problem.

## The session drops constantly

`GET /v1/sessions/:id/events` gives you the raw code next to the translated cause.
The difference between the two is where all the information is:

| Code | What it is | What to do |
| --- | --- | --- |
| `428` | Socket dropped | Nothing. It comes back on its own. |
| `408` | Timeout | Nothing. It comes back on its own. |
| `440` | **Credentials open somewhere else** | See below. Insisting makes it worse. |
| `401` | The phone unlinked the device | Only a new pairing fixes it. |
| `403` | Account blocked | Number is burned. |
| `515` | Restart required after pairing | Nothing. It is expected. |

**A repeating `440` is the most confusing symptom in the protocol.** It means the
same auth state is open in two places, and WhatsApp knocks both down in turn. The
real causes, in order of frequency:

- A copy of the database running on another machine with the same session.
- Two replicas with the same `NODE_ID` — both think they hold the lease.
- Someone restored a backup and brought it up alongside the live instance.

The Redis lease prevents this **inside** a cluster. It does not prevent two
different clusters pointing at the same Postgres.

## Messages stay in the queue

`GET /v1/outbox?status=queued` shows what is waiting. The reason is in one of three
places:

**The session is not connected.** A session that is down or pairing returns the
send to the queue without consuming an attempt — deliberately, so that
unavailability does not burn the five attempts. Fixing the session unblocks the
queue.

**The risk engine is holding it.** `GET /v1/sessions/:id/risk` shows window
consumption and the `throttleFactor`. If the message's `scheduledAt` is in the
future, that is it — and the time is real, computed from the oldest send still
inside the window.

Remember that the configured limits are the **target**, not today's value. A
session paired today runs at 5% of them. Setting 5000/day on a new session gets you
250 effective, and that is on purpose.

**Throughput can't keep up.** `OUTBOX_MAX_CONCURRENT` (default 50) caps concurrent
sends per node, and the human jitter holds each one for seconds. If the queue grows
without stopping while the sessions are healthy and risk is letting things through,
that is the bottleneck — but raising the number is exactly the behavior that burns
a number. Prefer more sessions over more speed per session.

## Messages go to the dead queue

`GET /v1/outbox?status=dead` lists them, and `lastError` gives the reason. Nothing
is discarded: the row stays there and `POST /v1/outbox/:id/retry` puts it back in
the queue.

An error that repeats across all of them is usually an invalid recipient or a
capability the engine does not have. Check `GET /v1/engines` — the Cloud API does
not do groups, and outside the 24 h window it only accepts an approved template.

## The webhook doesn't arrive

**Check that it went out.** `GET /v1/webhooks/deliveries?status=dead` and
`?status=failed`. If there is nothing there, the event was never generated — the
problem is further upstream.

**Any 4xx other than 408 or 429 goes straight to the dead queue.** Retrying does
not fix a rejected payload. If your endpoint answers 400 because the signature does
not match, see the next item.

**The signature doesn't match.** The cause is almost always the same: you are
verifying against the reserialized JSON, not against the raw bytes.
`JSON.stringify` of the already-parsed object produces similar bytes, not identical
ones — key order, escapes and spacing can all differ. In Express, that means
`express.raw()` or `verify` in `express.json()`.

The signature covers `timestamp.corpo`, not just the body:

```js
const esperado = 'sha256=' + createHmac('sha256', segredo).update(`${timestamp}.${corpoCru}`).digest('hex')
```

Or use the SDK, which already does this: `verifyWebhookRequest(request, secret)`.

**Your server's clock is wrong.** The window is 5 minutes. If your host's time has
drifted more than that, every legitimate delivery is rejected as a replay.

## The dashboard doesn't open

**Blank page, API responding.** The dashboard build was not found. The boot log
says which case it is: `dashboard sendo servido pela API` with the root, or
`dashboard não empacotado`. In the second case, run `pnpm --filter @awah/web build`
or point `DASHBOARD_DIR` at it.

**A client route returning a 404 JSON.** You asked for `application/json` in
`Accept`, or the path starts with one of the reserved prefixes (`/v1/`,
`/webhooks/`, `/metrics`, `/docs`, `/health`, `/ready`). That is on purpose: a
mistyped `GET /v1/sessoes` has to return a JSON error, not `<!doctype html>`.

**Login doesn't stick.** Outside `NODE_ENV=production` the cookie goes out without
the `secure` flag; some browsers refuse a cookie without `secure` on an HTTPS
origin. If you are behind TLS, use `NODE_ENV=production`.

## Failover doesn't happen

**The session stays down after the node dies.** Check `desired_state`. Failover
only revives what is `running` — a session you stopped stays stopped, and that is
the correct behavior.

**It takes more than 20 seconds.** The math is `LEASE_TTL_MS` (15 s) plus
`FAILOVER_SCAN_MS` (10 s) in the worst case. Lowering both speeds up recovery and
raises the risk of a slow replica losing the lease on a session it is still
holding.

**No replica takes over.** All of them have to reach the same Redis. If each one
has its own Redis, each one thinks it owns everything — and then you have the `440`
problem.

## The process won't start

**"These secrets are the development ones".** Exactly what it says: under
`NODE_ENV=production` the API refuses to start with the values published in this
repository. Generate your own with the commands the message itself shows.

**"Invalid environment configuration".** The message lists field by field what is
wrong. The common mistakes: an `ENCRYPTION_KEY` that is not 32 bytes in base64
(generate it with `openssl rand -base64 32`, do not make one up), and a
`PUBLIC_URL` with no scheme — `awah.exemplo.com` is not a URL,
`https://awah.exemplo.com` is.

**Pending migration.** The API does not apply migrations by itself on boot. Run
`pnpm db:migrate` first.

## Still not fixed

`LOG_LEVEL=debug` for the application and `ENGINE_LOG_LEVEL=debug` for the engine,
in that order — reversing it drowns the application log in Baileys noise.

If it turns out to be a bug, open an issue with the log excerpt, the version and
the steps to reproduce. If it is a security issue, do not open an issue: see
[SECURITY.md](../SECURITY.md).
