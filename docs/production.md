# Taking it to production

*[Português](production.pt-BR.md)*

The README teaches you how to bring it up. This document is about bringing it up
and not regretting it.

## Before you open the port

The API enforces the first three on its own. The rest it has no way to enforce.

**Your own secrets.** Under `NODE_ENV=production` the process refuses to boot with
this repository's development values — they are in `docker-compose.yml` and in
`.env.example`, and whoever reads them forges a session cookie and decrypts the
auth state of every session.

```bash
openssl rand -base64 32
```

```bash
openssl rand -base64 48
```

**`METRICS_TOKEN` set.** Without it, `/metrics` hands message volume, session
count and the health of the operation to anyone who reaches the port. The API
warns at boot when it is missing.

**`TRUST_PROXY` matching your topology.** The default is `false`, and that is the
right value when there is no proxy. With a proxy in front, prefer the CIDR list:

```bash
TRUST_PROXY=10.0.0.0/8,172.16.0.0/12
```

`TRUST_PROXY=true` works, but it trusts `X-Forwarded-For` coming from anywhere.
If someone reaches the application port without going through the proxy, they
pick their own IP on every request and never hit the rate limit.

**Postgres and Redis off the internet.** `docker-compose.yml` publishes both
ports to make development easier. In production, remove the `ports` blocks from
both services.

**The data lives in named volumes** (`awah_awah-postgres`, `awah_awah-redis`),
not in folders of the repository — whoever downloaded only the compose file has
no repository at all. The backup comes out of `awah_awah-postgres`, and that is
what has to survive any `docker compose down`. **Never use `down -v`**: the flag
deletes the volumes, and with them the auth state of every session.

## The loss that hurts

A Postgres backup is not about messages — it is about **`session_auth` and
`session_signal_keys`**. Losing those two tables means re-pairing every number by
hand, one handset at a time.

```bash
docker compose exec -T postgres pg_dump -U awah --format=custom awah > awah-$(date +%F).dump
```

Restore into an empty database now and then and bring the API up pointing at it.
A backup that has never been restored is a hypothesis, not a backup.

**`ENCRYPTION_KEY` is part of the backup.** The dump carries the auth state
encrypted; without the key, it is noise. Keep the key where the dump is not, and
do not rotate it without a plan — there is no automatic re-encryption today, and
changing the key makes every session unreadable.

Redis needs no backup. It holds leases, budgets and QR codes — all rebuildable.
Losing Redis costs a failover, not a session.

## TLS and proxy

AWAH speaks HTTP. HTTPS is spoken by whatever sits in front of it.

```nginx
server {
  listen 443 ssl http2;
  server_name awah.suaempresa.com;

  # The QR and the dashboard tolerate it fine; what does not is a short webhook timeout.
  proxy_read_timeout 65s;

  location / {
    proxy_pass http://127.0.0.1:2900;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

With that in place, set in the API's environment:

```bash
PUBLIC_URL=https://awah.suaempresa.com
TRUST_PROXY=127.0.0.1
NODE_ENV=production
```

`PUBLIC_URL` is not cosmetic: it is where the absolute URL comes from — the one
Meta needs registered as the webhook, and the address the interactive
documentation uses.

## Multiple replicas

Point them all at the same Postgres and the same Redis. There is no primary node,
and they all run the same code.

```yaml
services:
  api:
    image: awah-api
    environment:
      NODE_ID: ${HOSTNAME}
      # ... the rest identical on all of them
    deploy:
      replicas: 3
```

**A unique `NODE_ID` per replica.** Left empty, it comes from the hostname —
which is already unique on Kubernetes and on Swarm, and is not on a careless
`docker compose up --scale`. Two replicas with the same `NODE_ID` contend for the
same lease, and one of them thinks it is the owner when it is not.

**The load balancer does not need sticky sessions.** Commands that require a live
socket travel to the owning node over pub/sub; the QR is published to Redis and
read by any replica.

**Size by session count, not by HTTP traffic.** Each Baileys session is an open
WebSocket with crypto state in memory. That is the number that matters.

## Updating

```bash
docker compose pull && docker compose up -d
```

The `migrate` service runs before the API and it is what applies the migrations —
the API only comes up after it finishes successfully. Migrations are additive and
new code tolerates an old schema for one version; the reverse does not hold, so
never run an old image against an already-migrated database.

**Pin the version in production.** The compose default is `latest`, which is
convenient for experimenting and bad for operating — a `docker compose pull` can
bring in a version you never reviewed.

```bash
AWAH_IMAGE=ghcr.io/leoberchielli/awah:1.0.0
```

`GET /health` returns the version and the commit that are running, so there is no
doubt about what is live.

With multiple replicas, update one at a time. While one restarts, the lease on
its sessions expires in 15 s and another takes over — the window is the same one
as a failover.

Shutdown is orderly: `SIGTERM` stops accepting new connections, drains what is in
flight, releases the leases, and only then closes Postgres and Redis. Give the
orchestrator at least 30 s of `terminationGracePeriod`.

### Check where the image came from

```bash
gh attestation verify oci://ghcr.io/leoberchielli/awah:1.0.0 --owner leoberchielli
```

The attestation proves that image came out of that commit, through that workflow.
Anyone running a gateway with their own customers' credentials inside it has
reason enough to check this before deploying.

## What to monitor

Alerts worth having, in order of urgency:

| Signal | Where | Why it matters |
| --- | --- | --- |
| Session with `desired_state=running` that is not running | dashboard, Operations tab | The queue keeps accepting and nothing goes out. It costs money in silence. |
| `awah_outbox_depth` growing without stopping | `/metrics` | Either the session dropped, or risk is holding messages, or throughput cannot keep up. |
| `awah_outbox_depth{status="dead"}` > 0 | `/metrics` | A message that exhausted its retries. It does not disappear on its own. |
| Risk score above 70 | `GET /v1/sessions/:id/risk` | The session is behaving the way sessions usually behave right before a ban. |
| Drops per hour rising on a session | dashboard, MTBF | A repeated `440` is a credential open in two places. |
| Webhooks in the dead queue | `GET /v1/webhooks/deliveries?status=dead` | Your endpoint is rejecting them or is down. |

The dashboard answers the first three at a glance. Prometheus is for what needs
to wake someone up.

## Retention and LGPD

`retentionDays` on the organization controls how long the **body** of the messages
is kept. Default 30 days.

- `0` never persists content — metadata only. This is the setting for anyone who
  does not want the customer's conversation in their database.
- `-1` keeps it forever. Know what you are doing.

Once the period expires, the row degrades to metadata: the volume and latency
KPIs keep working, the text disappears. The sweep runs every
`RETENTION_SWEEP_MS` (default 10 min).

WhatsApp message content is personal data. If you operate in Brazil, the period
you configure here is part of what has to be in your record of processing
activities.

## Choosing the engine in production

For serious commercial load, `cloud_api`. It is official, it carries no risk of a
ban, and it costs per conversation.

`baileys` is the choice for whoever accepts the risk in exchange for zero cost —
and, if that is the case, use a dedicated number. Never your personal one, never
the company's critical number. The risk engine lowers the probability of a ban;
it guarantees nothing, and no configuration of it makes the unofficial engine
compatible with the platform's terms of use.

Migrating from one to the other is one line, because both sit behind the same
`EngineAdapter`. What changes is in `GET /v1/engines`.
