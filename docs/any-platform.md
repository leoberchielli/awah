# Plug in any platform

*[Português](any-platform.pt-BR.md)*

Chatwoot and Typebot have a dedicated connector because they are the two most
common cases. For everything else there is the **HTTP connector**: the gateway
posts every incoming message to a URL of yours and sends back whatever the
response carries.

That lets anything that speaks HTTP be the bot — n8n, Make, Activepieces, a
serverless function, the in-house system — without anyone having to write a new
connector in here.

## Webhook or connector? The difference matters

AWAH has both, and picking the wrong one is the most common source of confusion.

| | Webhook (`/v1/webhooks`) | HTTP connector (integration) |
| --- | --- | --- |
| Direction | fire and forget | question and answer |
| Your endpoint's response | is ignored | **becomes a WhatsApp message** |
| Delivery | own queue, retry, DLQ | inside the message path |
| Good for | logging, notifying, kicking off a process | replying to the customer |

Rule of thumb: **if your system needs to reply, use the connector.** If it only
needs to know, use the webhook — it tolerates failure better and does not hold
up the queue.

Nothing stops you from using both on the same session.

## The contract

The gateway posts this, with `content-type: application/json`:

```json
{
  "event": "message.received",
  "data": {
    "sessionId": "9f1c…",
    "messageId": "wamid.ABC",
    "chatId": "5511999999999@s.whatsapp.net",
    "from": "5511999999999@s.whatsapp.net",
    "type": "text",
    "body": "quero saber o preço",
    "timestamp": "2026-08-19T12:00:00.000Z"
  }
}
```

It is the same shape as the `message.received` webhook event — deliberately, so
that whoever already handles one handles the other with no new code.

You reply with **any one** of these shapes:

```json
{"reply": "text"}
{"replies": ["first", "second"]}
{"text": "text"}
["text"]
"text"
```

Or an **empty body / 204**, when there is nothing to send. That is a valid
response: it is there for whoever only wants to log what comes in.

If the reply arrives nested, set `replyPath` with the dotted path — for example
`data.saida` for `{"data":{"saida":{"reply":"..."}}}`.

### What happens to the reply

It goes in through the **same queue as any other send**. It inherits
per-conversation ordering, the risk engine, human jitter and redelivery. That is
the difference between your flow firing straight at Meta and your flow having a
serious queue underneath it.

The idempotency key is derived from the message that triggered the reply, so
processing the same event twice does not send the reply twice.

## Security

Set a `secret` and the gateway signs every request:

```
x-awah-signature: sha256=<hex>
x-awah-timestamp: <seconds>
```

The HMAC covers `timestamp.body` — the same scheme as the webhooks, so the SDK
helper works for both:

```ts
import { verifyWebhookRequest } from '@awah/sdk'

const { valid, payload } = await verifyWebhookRequest(request, process.env.AWAH_SECRET!)
```

**If the URL is public, use the secret.** Without it, anyone who finds the
address can make your flow reply in your number's name.

Use `headers` for the reverse direction — authenticating the gateway to your
system:

```json
{"headers": {"authorization": "Bearer my-system-token"}}
```

## Test before switching it on

The dashboard has a **Test** button that sends a sample event and shows status,
timing, the raw body and — when the response does not become a message — the
reason. It also shows exactly what the gateway sends, so you can build the flow
on the other side on top of the sample.

Through the API:

```bash
curl -X POST http://localhost:2900/v1/integrations/http/test -H "Authorization: Bearer $AWAH_KEY" -H 'content-type: application/json' -d '{"url":"https://n8n.exemplo.com/webhook/atendimento"}'
```

## Recipes

### n8n

1. A **Webhook** node, method `POST`, and under Respond pick **Using Respond to
   Webhook node**. Copy the production URL.
2. Do whatever you want in between. The customer's text is at
   `{{ $json.body.data.body }}` and the phone number at `{{ $json.body.data.chatId }}`.
3. A **Respond to Webhook** node, Respond With **JSON**:

```json
{ "reply": "{{ $json.resposta }}" }
```

Paste the webhook URL into the connector. If you turned the secret on, verify
the signature in a code node before processing.

> Mind the timing. The connector waits 10 s by default (30 s ceiling). An n8n
> flow that calls a slow LLM blows past that — in which case reply with an empty
> body and send the answer afterwards via `POST /v1/sessions/:id/messages`.

### Make (Integromat)

1. **Webhooks → Custom webhook** module, copy the URL.
2. At the end of the scenario, a **Webhook response** with Body:

```json
{"reply": "{{1.texto}}"}
```

3. Status 200.

### Serverless function (Cloudflare Workers, Vercel, Lambda)

```ts
export default {
  async fetch(request: Request) {
    const { data } = await request.json()

    // Your logic here. Empty body when there is nothing to reply.
    if (!data.body?.includes('preço')) return new Response(null, { status: 204 })

    return Response.json({ reply: 'Nossa tabela começa em R$ 99/mês.' })
  },
}
```

### Node with Express

```js
app.post('/awah', express.json(), (req, res) => {
  const { body, chatId } = req.body.data
  res.json({ reply: `Recebi "${body}" de ${chatId}` })
})
```

To verify the signature you need the **raw** body — `express.raw()` or the
`verify` option of `express.json()`. Re-serializing the already-parsed object
produces similar bytes, not identical ones, and the HMAC fails intermittently.

### Python with FastAPI

```python
@app.post("/awah")
async def awah(request: Request):
    evento = await request.json()
    texto = evento["data"]["body"]
    return {"reply": f"Recebi: {texto}"}
```

## When the conversation goes silent

The last error of each integration shows up on the **Integrations** tab, with
the time. For the HTTP connector, the frequent causes:

- **The response is not JSON.** Many frameworks return HTML on error; the
  diagnostic says so.
- **The response is JSON but no field is recognized.** The diagnostic lists the
  fields that came in.
- **It timed out.** Raise `timeoutMs` up to 30 s, or reply empty and send
  afterwards through the send API.
- **The URL is not reachable from the gateway's server.** `localhost` inside a
  container is the container itself; use the network address.

A `4xx` is not retried — retrying returns the same refusal and only delays the
record of the error you need to see. `5xx` and timeouts are retried three times
over ~7 s.

## Known limit

The connector sits **inside** the message path: while it waits, that
conversation does not move. That is why the ceiling is short.

If your platform is slow by nature — a large LLM, a queue of its own, human
approval — the right pattern is a different one: reply `204` immediately and
send the message afterwards via `POST /v1/sessions/:id/messages`, which is
asynchronous by construction. The connector is for a fast reply; the send API is
for the rest.
