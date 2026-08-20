# Getting started

*[Português](getting-started.pt-BR.md)*

From zero to a conversation in Chatwoot. Five steps and no `curl`.

> Use a **dedicated** number for WhatsApp. Never your personal one, never the
> company's critical number. The unofficial engine violates the platform's terms
> of use and there is a real risk of being blocked.

## 1. Bring it up

You don't need the source code. Just one file:

```bash
curl -O https://raw.githubusercontent.com/leoberchielli/awah/main/docker-compose.yml
```

```bash
docker compose up -d
```

That brings up Postgres and Redis, pulls the image, applies the migrations and
starts the API on `http://localhost:2900`. Wait a few seconds and open it in the
browser.

## 2. Create the organization

The first time you open it, the dashboard shows the setup screen: organization
name, your name, email and password. You come in as **owner** and that screen
never shows up again — from there on, new users join by invite.

## 3. Pair the number

**Sessions** tab → **New session** → give it a name → **Start**.

The QR shows up on its own at the top of the screen, with the step-by-step next
to it. On the phone: three dots (Android) or **Settings** (iPhone) → **Linked
devices** → **Link a device** → point it at the code.

The banner disappears on its own once the phone accepts, and the session turns
**Connected**.

## 4. Connect Chatwoot

**Integrations** tab → **Connect Chatwoot**.

You need two things: your instance's address and an **access token** (in
Chatwoot: your avatar → Profile → Access token).

The gateway works out the rest on its own — the account, the existing inboxes,
and creating the API inbox with the webhook already pointed at it. **Use an
administrator token**: with an ordinary agent token Chatwoot refuses to create
the inbox, and then the step goes back to being manual.

Done. Send a message to the paired number and it shows up in the inbox. Reply
from there and it goes out over WhatsApp.

## 5. See it working

**Operations** tab. The `sent → delivered → read` funnel, p95 latency, the queue
and what the risk engine held.

Don't expect interesting numbers out of ten messages — the dashboard was built
for volume. But the funnel already shows whether delivery is happening.

---

## Variations

### I want a bot answering before a human does

Turn on **Typebot** too, on the same session. Publish the flow there, copy the
link under **Share**, and paste it into the wizard. It is not the editor's
address — that one uses the internal id and doesn't work with the Chat API.

Running the two together is the most useful arrangement: the flow answers first,
and when the customer types **agent** it goes quiet and a human takes over a
conversation that already has the whole history.

### I want to integrate with my own system, not with a tool

Create an API key and use the SDK:

```bash
npm install @awah/sdk
```

```ts
import { Awah } from '@awah/sdk'

const awah = new Awah({ baseUrl: 'http://localhost:2900', apiKey: process.env.AWAH_KEY! })
await awah.messages.sendText(sessionId, { chatId: '5511987654321', text: 'olá' })
```

Details in [packages/sdk](../packages/sdk/README.md).

### I want to expose this to the internet

Read [production.md](production.md) first. The short list of what can't be
missing: generate your own secrets (the API refuses to start in production with
the ones from this repository), set `METRICS_TOKEN`, configure `TRUST_PROXY` to
match your topology, and don't publish the Postgres and Redis ports.

### I want to pin the version

The default is `latest`. To pin it, point `AWAH_IMAGE` at a tag in your `.env`:

```bash
AWAH_IMAGE=ghcr.io/leoberchielli/awah:1.0.0
```

`GET /health` tells you which version is running.

### I don't want to use Docker

```bash
pnpm install && cp .env.example .env
```

Generate the two secrets the `.env` asks for, bring up Postgres and Redis
yourself, and then:

```bash
pnpm db:migrate && pnpm dev
```

## When something doesn't work

[troubleshooting.md](troubleshooting.md) covers the symptoms that actually show
up: a session that won't pair, a message stuck in the queue, a webhook that
never arrives, a signature that doesn't match.
