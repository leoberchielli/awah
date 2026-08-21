# The public demo

*[Português](demo.pt-BR.md)*

**[awah-demo.99ia.com.br](https://awah-demo.99ia.com.br)** — sign in with
`admin@awah.demo` / `admin`. The credentials are printed on the login screen;
there is nothing to request and nothing to install.

The same instance runs on your own machine in one command:

```bash
curl -O https://raw.githubusercontent.com/leoberchielli/awah/main/docker-compose.demo.yml
docker compose -f docker-compose.demo.yml up -d
```

Then open `http://localhost:2900`.

## What is real

Everything except the last hop. A message sent from the panel or through the API
is written to the outbox, answered `202` the moment the row is durable, checked
against the risk engine's budget and warm-up, scored, held back by the human
jitter, dispatched, reconciled through the ACK trail and published as a signed
webhook. The dashboards read the same aggregates they read in production, over
data the same code wrote.

The published API key works too, so the demo answers `curl`:

```bash
curl https://awah-demo.99ia.com.br/v1/kpi/delivery?hours=24 \
  -H "authorization: Bearer awah_de3ade3ade3ade3a_public-demo-key-not-a-secret"
```

## What is not

The engine. The demo's sessions run on the **simulator**, which is not a
WhatsApp client: it accepts sends, invents plausible latency, delivers most of
them, drops the socket now and then and answers with inbound messages — but
nothing reaches a phone. That is exactly the failure mode the production guard
exists to prevent, which is why the demo announces itself on the login screen, in
`/v1/auth/me` and in a banner across the top of every screen. A simulated engine
that does not say so is how an operation ends up believing it delivered messages
that never left.

For the same reason the demo **refuses to pair a real number**: it runs with
secrets published in this repository, and `ENCRYPTION_KEY` is what protects a
session's auth state at rest. Creating a session on `baileys` or `cloud_api`
comes back 403 with that explanation.

## The three numbers

The seed writes a month of history, because a dashboard with no rows answers
none of the questions it exists for.

| Session | Age | State | What it is there to show |
|---|---|---|---|
| Support | 47 days | healthy, mature | Warm-up fully released, caps at 100% |
| Sales | 3 days | healthy, warming | The ramp: what a new number is allowed to send |
| Billing | 12 days | degraded | Deliveries failing, drops, sends held by the engine |

The demo would teach nothing if everything were green. A gateway whose reason to
exist is the day a number stops working needs one number that is not working.

The queue is seeded with messages in the dead-letter queue and messages **held**
by the risk engine, for the same reason: "nothing is lost, it waits and says
why" is a claim, and a queue that is always empty is where the claim cannot be
checked.

## What resets, and when

Every three hours the organization is deleted and rebuilt — sessions, keys,
webhooks, integrations, messages, everything. Whoever is signed in is signed out,
because the account is recreated along with the rest.

This is what makes the rest of the demo safe: every visitor arrives as **owner**
and can do anything an owner can do, including deleting what the previous
visitor built. Two things are outside their reach, and only two:

- **The published account** cannot be removed, demoted or renamed. It is the
  credential on the login screen, and the next visitor needs it to work.
- **The organization** cannot be deleted, since it is the demo itself.

Everything else — creating sessions, sending, retrying a dead letter, minting an
API key, wiring an integration, changing the risk limits — works, and goes back
to the baseline on the next reset.

Set `DEMO_RESET_MINUTES=0` to switch the reset off on your own copy.

## Running a demo of your own

Any instance becomes one with two variables:

```bash
DEMO_MODE=true
SIMULATOR_ENABLED=true
```

`DEMO_MODE` is the only thing that lifts the production ban on the simulator, and
starting it without `SIMULATOR_ENABLED` fails at boot: a demo with no engine is a
login screen over an empty database. `DEMO_EMAIL`, `DEMO_PASSWORD` and
`DEMO_RESET_MINUTES` change the rest.

The seed is idempotent — restarting the process does not write the month of
history again — and it never touches an organization that is not the demo's, so
`DEMO_MODE` on an instance that already has data adds a demo org beside it
rather than replacing anything.
