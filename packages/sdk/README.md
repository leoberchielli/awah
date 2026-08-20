# @awah/sdk

*[Português](README.pt-BR.md)*

TypeScript client for [AWAH](https://github.com/leoberchielli/awah). No
dependencies, built on `fetch` and WebCrypto — runs on Node, Deno, Bun,
Cloudflare Workers and in the browser.

```bash
npm install @awah/sdk
```

## Usage

```ts
import { Awah } from '@awah/sdk'

const awah = new Awah({
  baseUrl: 'https://awah.suaempresa.com',
  apiKey: process.env.AWAH_KEY!,
})

const sessao = await awah.sessions.create({ name: 'atendimento' })
await awah.sessions.start(sessao.id)

const { image } = await awah.sessions.qr(sessao.id)
// `image` is a data: URI, ready for an <img> tag.
```

> The API key sends messages on behalf of **every** session in the organization.
> It is a server credential: do not put it in code that runs in the browser.

## Sending

```ts
const envio = await awah.messages.sendText(sessao.id, {
  chatId: '5511987654321',
  text: 'olá',
  clientMessageId: 'pedido-4821',
})

console.log(envio.status) // 'queued'
```

The response is **202**, not 200: the message was persisted, not delivered. The
real state lives in `awah.outbox.get(envio.id)` and in the webhooks.

### Idempotency

`clientMessageId` is the idempotency key. Resending the same value returns the
original send with `duplicate: true` and does not produce a second message. **If
you omit it, the SDK generates one** — and that is exactly what makes its
automatic retry safe: without a key, repeating a POST after a network timeout
would send the same message twice to the end customer.

Use a value of your own — the order id, the ticket id, the campaign id — when
you want the retry to survive a restart of your process too.

## Retries

The client retries `408`, `429`, `5xx` and network failures on its own, with
exponential backoff and jitter, honoring `Retry-After`. It does not retry the
other `4xx`: the server rejected the content, and sending it again produces the
same rejection.

```ts
new Awah({ baseUrl, apiKey, maxRetries: 5, timeoutMs: 60_000 })
```

## Errors

```ts
import { AwahError } from '@awah/sdk'

try {
  await awah.sessions.start(id)
} catch (erro) {
  if (erro instanceof AwahError && erro.code === 'conflict') {
    // the session was already running
  }
}
```

Branch on `erro.code`, never on the message: codes are public contract, messages
change from version to version. `erro.isAuth`, `erro.isRateLimited` and
`erro.isRetryable` cover the common cases.

## Webhooks

```ts
import { verifyWebhookRequest } from '@awah/sdk'

export async function POST(request: Request) {
  const { valid, payload } = await verifyWebhookRequest(request, process.env.AWAH_WEBHOOK_SECRET!)
  if (!valid) return new Response('assinatura inválida', { status: 401 })

  const evento = JSON.parse(payload)
  // ...
  return new Response(null, { status: 204 })
}
```

In plain Node, or when you already have the body in hand:

```ts
import { verifyWebhook } from '@awah/sdk'

const valido = await verifyWebhook({
  payload: corpoCru,
  secret,
  signature: headers['x-awah-signature'],
  timestamp: headers['x-awah-timestamp'],
})
```

**Pass the raw body, not the reserialized object.** `JSON.stringify` of the
already-parsed object produces similar bytes, not identical ones — key order and
spacing can differ — and verification would fail intermittently and
inexplicably.

The signature covers `timestamp.body`, not just the body. That is what stops
replay: a captured delivery cannot be resent later, and changing the timestamp
to escape the 5-minute window invalidates the signature.

## Surface

| Resource | Methods |
| --- | --- |
| `awah.sessions` | `list` `get` `create` `delete` `start` `stop` `logout` `qr` `pairingCode` `events` `setCredentials` |
| `awah.messages` | `sendText` `list` |
| `awah.outbox` | `get` `list` `retry` |
| `awah.webhooks` | `create` `list` `delete` `deliveries` `replay` |
| `awah.risk` | `snapshot` `setLimits` `events` |
| `awah.kpi` | `sessions` `delivery` `risk` `business` |
| `awah` | `engines` `me` `health` |

## License

MIT.
