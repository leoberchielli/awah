# Contributing

*[Português](CONTRIBUTING.pt-BR.md)*

The project is under active construction toward v1.0. Architecture decisions are
still malleable, and that is exactly why **an issue reporting a real use case is
worth more than a PR** at this stage.

## What helps most right now

- **How you use a WhatsApp gateway today**, and what breaks. Especially if you
  have already lost a number: how many sends, over how long, at what interval.
  That is the data missing to calibrate the risk engine.
- **Disconnect codes you have seen that AWAH does not translate.** The table in
  `apps/api/src/engines/disconnect.ts` was built from observation, not from a
  spec — it has holes.
- **A bug with steps to reproduce.** Logs with `LOG_LEVEL=debug` and, if it is
  pairing, `ENGINE_LOG_LEVEL=debug`.

## Getting the environment up

```bash
pnpm install
```

```bash
docker compose up -d postgres redis
```

To run the whole stack from your code instead of the published image:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

```bash
cp .env.example .env
```

Generate the two secrets and put them in `.env`:

```bash
openssl rand -base64 32
```

```bash
openssl rand -base64 48
```

```bash
pnpm db:migrate && pnpm dev
```

In development the dashboard runs separately, proxying to the API:

```bash
pnpm dev:web
```

## Before opening the PR

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

The integration tests need Postgres and Redis up. Without them, the integration
files skip themselves and the rest runs — which is useful locally and not enough
for a PR.

## Code standards

**Names and comments in English.** It is the project's code language, for
identifiers and comments alike. API field names and table names were always
English, because they are a public contract and that contract is read far beyond
Brazil — now the rest of the code matches. Interface strings are a separate
matter: [docs/translating.md](docs/translating.md) covers translating them.

**A comment explains why, not what.** The code already says what it does. What
gets lost over time is the reason: which bug this avoids, which alternative was
rejected and why. A comment that paraphrases the next line is noise.

```ts
// Bad: increments the attempt
attempts++

// Good: a session in pairing has an open socket but no identity, and the send
// fails with a raw Baileys error. Burning an attempt here would spend all five
// before the user finishes scanning the QR code.
if (!adapter.isReady()) return release(id)
```

**Migration together with the schema change.** CI runs `pnpm db:generate` and
fails if the diff is not clean.

**A test that proves the behavior, not the implementation.** The best test in
this repository is the one that describes the bug it keeps from coming back.
Several of them carry a comment saying exactly which bug that is.

**No new dependency without a strong reason.** Staying light is one of the
project's four bets. The SDK has zero dependencies and the dashboard has four —
each one was a decision, not a distracted `npm install`.

## Scope

What does **not** get in:

- Spam automation, bulk sending without opt-in, or anything whose main use case
  is messaging people who did not ask. The risk engine exists for the opposite
  of that.
- Bypassing WhatsApp detection beyond what is already there (jitter, warm-up,
  presence). The line is "look human because the usage is human", not "hide that
  it is not".
- A new engine that is not behind `EngineAdapter`. The contract is what lets you
  swap engines without rewriting the integration.

## License

Contributions are licensed under MIT, the same as the project.
