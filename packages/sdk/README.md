# @awah/sdk

Cliente TypeScript do [AWAH](https://github.com/leandroberchielli/awah). Sem
dependências, sobre `fetch` e WebCrypto — roda em Node, Deno, Bun, Cloudflare
Workers e no navegador.

```bash
npm install @awah/sdk
```

## Uso

```ts
import { Awah } from '@awah/sdk'

const awah = new Awah({
  baseUrl: 'https://awah.suaempresa.com',
  apiKey: process.env.AWAH_KEY!,
})

const sessao = await awah.sessions.create({ name: 'atendimento' })
await awah.sessions.start(sessao.id)

const { image } = await awah.sessions.qr(sessao.id)
// `image` é um data: URI, pronto para uma tag <img>.
```

> A chave de API envia mensagem em nome de **todas** as sessões da organização.
> É credencial de servidor: não a coloque em código que roda no navegador.

## Enviar

```ts
const envio = await awah.messages.sendText(sessao.id, {
  chatId: '5511987654321',
  text: 'olá',
  clientMessageId: 'pedido-4821',
})

console.log(envio.status) // 'queued'
```

O retorno é **202**, não 200: a mensagem foi persistida, não entregue. O estado
real vive em `awah.outbox.get(envio.id)` e nos webhooks.

### Idempotência

`clientMessageId` é a chave de idempotência. Reenviar o mesmo valor devolve o
envio original com `duplicate: true` e não gera segunda mensagem. **Se você
omitir, o SDK gera um** — e é exatamente isso que torna seguro o retry
automático que ele faz: sem chave, repetir um POST depois de um timeout de rede
mandaria a mesma mensagem duas vezes para o cliente final.

Use um valor seu — o id do pedido, do ticket, do disparo — quando quiser que o
retry sobreviva também a um reinício do seu processo.

## Retentativa

O cliente repete sozinho `408`, `429`, `5xx` e falha de rede, com backoff
exponencial e jitter, respeitando `Retry-After`. Não repete os demais `4xx`:
o servidor rejeitou o conteúdo, e mandar de novo produz a mesma rejeição.

```ts
new Awah({ baseUrl, apiKey, maxRetries: 5, timeoutMs: 60_000 })
```

## Erros

```ts
import { AwahError } from '@awah/sdk'

try {
  await awah.sessions.start(id)
} catch (erro) {
  if (erro instanceof AwahError && erro.code === 'conflict') {
    // a sessão já estava em execução
  }
}
```

Faça branch em `erro.code`, nunca na mensagem: códigos são contrato público,
mensagens mudam de versão para versão. `erro.isAuth`, `erro.isRateLimited` e
`erro.isRetryable` cobrem os casos comuns.

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

Em Node puro, ou quando você já tem o corpo em mãos:

```ts
import { verifyWebhook } from '@awah/sdk'

const valido = await verifyWebhook({
  payload: corpoCru,
  secret,
  signature: headers['x-awah-signature'],
  timestamp: headers['x-awah-timestamp'],
})
```

**Passe o corpo cru, não o objeto reserializado.** `JSON.stringify` do objeto já
parseado produz bytes parecidos, não idênticos — ordem de chaves e espaçamento
podem diferir — e a verificação falharia de forma intermitente e inexplicável.

A assinatura cobre `timestamp.corpo`, não só o corpo. É o que impede replay: uma
entrega capturada não pode ser reenviada depois, e mudar o timestamp para escapar
da janela de 5 minutos invalida a assinatura.

## Superfície

| Recurso | Métodos |
| --- | --- |
| `awah.sessions` | `list` `get` `create` `delete` `start` `stop` `logout` `qr` `pairingCode` `events` `setCredentials` |
| `awah.messages` | `sendText` `list` |
| `awah.outbox` | `get` `list` `retry` |
| `awah.webhooks` | `create` `list` `delete` `deliveries` `replay` |
| `awah.risk` | `snapshot` `setLimits` `events` |
| `awah.kpi` | `sessions` `delivery` `risk` `business` |
| `awah` | `engines` `me` `health` |

## Licença

MIT.
