# Chatwoot and Typebot

*[Português](integrations.pt-BR.md)*

AWAH has no inbox and no flow builder, and that is a decision, not a gap.
Chatwoot already handles human support very well; Typebot already handles flows
very well. What both lack is what the gateway has:

| | Wired straight to Meta | With AWAH underneath |
| --- | --- | --- |
| Per-conversation ordering | no guarantee | FIFO per chat, chats in parallel |
| Lost message | fire and forget | durable queue, retry, DLQ with replay |
| Send pacing | whatever the tool decides | budget, warm-up and adaptive throttle |
| Duplicate redelivery | sends it again | idempotency by key |
| Delivery state | "sent it" | sent → delivered → read funnel |

That is why it is worth putting the gateway in the middle instead of wiring the
tools straight to Meta.

## Chatwoot

It talks both ways: the customer's message becomes a conversation in the inbox,
and the agent's reply goes back out through the gateway's queue.

### From the dashboard, in two fields

The **Integrations** tab → **Connect Chatwoot**. You supply only your instance
address and an **access token** (in Chatwoot: avatar → Profile → Access token).

The gateway does the rest:

1. Asks the token which accounts it can reach and lists them for you to pick —
   the `accountId` is buried in the Chatwoot URL, and hunting it down there is
   the first thing that stalls adoption.
2. Lists that account's inboxes, marking which ones will work. An inbox that is
   not of type API shows up disabled with the reason, instead of vanishing:
   someone looking for the inbox they already use needs to understand why it
   does not work.
3. Creates the API inbox **with the webhook already pointed** at the gateway, or
   fixes the webhook on whichever existing inbox you choose.

**Use an administrator token.** Creating and editing an inbox requires it; with
a plain agent token Chatwoot returns 403, and the wizard says exactly that
instead of failing silently.

### Via the API

```bash
curl -X POST http://localhost:2900/v1/integrations/chatwoot/discover -H "Authorization: Bearer $AWAH_KEY" -H 'content-type: application/json' -d '{"baseUrl":"https://app.chatwoot.com","apiAccessToken":"SEU_TOKEN"}'
```

Returns the accounts. Repeat with `accountId` to get the inboxes too. Then:

```bash
curl -X PUT http://localhost:2900/v1/sessions/$ID/integrations/chatwoot -H "Authorization: Bearer $AWAH_KEY" -H 'content-type: application/json' -d '{"baseUrl":"https://app.chatwoot.com","accountId":1,"apiAccessToken":"SEU_TOKEN","createInbox":"WhatsApp (AWAH)"}'
```

`createInbox` creates the inbox; `inboxId` reuses an existing one and fixes its
webhook. Pass `inboxId` with `apontarWebhook: false` and the gateway does not
touch the inbox — the response carries the URL for you to paste by hand.

### The secret lives in the URL

When the gateway points the webhook itself, there is nothing to do on the other
side. If you configure it by hand, **treat the URL as a password**: Chatwoot's
API inbox webhook does not sign the body and does not accept a header of its
own, so the URL is the only secret between the two. That is why the gateway
generates a long token instead of letting you choose one, and why the route also
checks the payload's `account.id`.

### What does not get forwarded

Three discards, each for a concrete symptom:

- **Internal note** (`private: true`) is the team talking about the customer,
  not to them.
- **A message with `source_id`** originated on WhatsApp and was created by us in
  Chatwoot. Sending it back would be the classic echo loop.
- **Redelivery of the same event** becomes a duplicate the queue recognizes: the
  idempotency key is `chatwoot:<message id>`, so Chatwoot can redeliver all it
  wants and the customer still receives it once.

## Typebot

Answers whatever arrives. The customer's message goes into the flow, and
whatever the flow produces goes out through the gateway's queue — inheriting
ordering, pacing and redelivery.

### Connecting

Paste the flow's **share link** — the address and `publicId` both come from it.
In Typebot: publish, then copy it under **Share**.

```bash
curl -X PUT http://localhost:2900/v1/sessions/$ID/integrations/typebot -H "Authorization: Bearer $AWAH_KEY" -H 'content-type: application/json' -d '{"shareUrl":"https://typebot.io/meu-fluxo"}'
```

A token is only needed if the flow is not public. There is no URL to register on
the other side: the gateway is the one calling Typebot.

The likeliest mistake is pasting the **editor** address — it carries the
internal id, which the Chat API does not accept. The gateway rejects that link
and tells you where the right one is, instead of accepting it and failing later,
on a real customer's first message.

### Flow session

One per contact. The first message starts the flow; the ones after it continue
from where it stopped. Without this, the customer would be stuck on the first
question forever.

The session expires on silence — `sessionTtlMinutes`, default 6 hours. Someone
who writes back three weeks later would land in the middle of a form that no
longer makes sense.

When the flow reaches its end, Typebot stops asking for input and the session
closes right away: the next message starts a new flow.

### Escape to a human

`humanHandoffKeyword`, default **atendente**. Anyone who types it ends the flow
session and gets `humanHandoffReply` — and the message does **not** go into the
flow, because someone who asked to talk to a person should not get one more
automated reply.

Leave it empty to turn the escape off, but only do that if there is another path
to a person.

## The two together

This is the most useful arrangement, and the reason both integrations live on
the same session: Typebot answers first and Chatwoot receives the whole
conversation. When the customer types the escape word, the flow goes quiet and
the agent takes over a conversation that already has the full history.

## When something does not arrive

The **Integrations** tab shows the last error for each connection, with the
time. It is the first thing to look at when conversations stop showing up in the
tool.

The gateway never lets an external tool's failure take the session down: at the
limit, a Chatwoot that is down would take the WhatsApp connection with it
because of a third-party service. It tries three times over ~7 s, records the
error and moves on.

**The honest consequence:** if the tool stays down for longer than those
seconds, the message stays in AWAH and does not appear there. It is still in
`GET /v1/sessions/:id/messages` and in the webhooks — nothing is lost on the
gateway's side — but there is still no automatic resync into Chatwoot. That is
the next thing to build here.

A `4xx` error is not retried: an invalid token or a nonexistent inbox would
return the same refusal three times and would only delay the record of the error
you need to see.

## Security

Credentials are encrypted with AES-256-GCM, in the same table as the sessions'
auth state, and **never** come back on read — `GET /v1/integrations` returns
state and last error, nothing more. The Chatwoot token writes into the
customer's support account and reads every conversation in it: it is a
credential, not a setting.
