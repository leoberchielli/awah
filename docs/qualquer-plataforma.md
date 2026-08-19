# Plugar qualquer plataforma

Chatwoot e Typebot têm conector dedicado porque são os dois casos mais comuns.
Para todo o resto existe o **conector HTTP**: o gateway posta cada mensagem
recebida numa URL sua e envia de volta o que a resposta trouxer.

Isso torna qualquer coisa que fale HTTP capaz de ser o robô — n8n, Make,
Activepieces, uma função serverless, o sistema da casa — sem que ninguém precise
escrever um conector novo aqui dentro.

## Webhook ou conector? A diferença importa

O AWAH tem os dois, e escolher errado é a causa mais comum de confusão.

| | Webhook (`/v1/webhooks`) | Conector HTTP (integração) |
| --- | --- | --- |
| Sentido | avisa e esquece | pergunta e resposta |
| A resposta do seu endpoint | é ignorada | **vira mensagem no WhatsApp** |
| Entrega | fila própria, retry, DLQ | dentro do caminho da mensagem |
| Bom para | registrar, notificar, disparar processo | responder o cliente |

Regra prática: **se o seu sistema precisa responder, use o conector.** Se ele só
precisa saber, use o webhook — ele é mais tolerante a falha e não segura a fila.

Nada impede usar os dois na mesma sessão.

## O contrato

O gateway posta isto, com `content-type: application/json`:

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

É a mesma forma do evento `message.received` dos webhooks — de propósito, para
quem já trata um tratar o outro sem código novo.

Você responde com **qualquer uma** destas formas:

```json
{"reply": "texto"}
{"replies": ["primeira", "segunda"]}
{"text": "texto"}
["texto"]
"texto"
```

Ou **corpo vazio / 204**, quando não há nada a enviar. Isso é resposta válida:
serve para quem só quer registrar o que chega.

Se a resposta vier aninhada, configure `replyPath` com o caminho por ponto — por
exemplo `data.saida` para `{"data":{"saida":{"reply":"..."}}}`.

### O que acontece com a resposta

Ela entra pela **mesma fila de qualquer envio**. Herda ordem por conversa, motor
de risco, jitter humano e reentrega. É a diferença entre o seu fluxo disparar
direto na Meta e o seu fluxo ter uma fila séria embaixo.

A chave de idempotência é derivada da mensagem que provocou a resposta, então
processar o mesmo evento duas vezes não manda a resposta em dobro.

## Segurança

Configure um `secret` e o gateway assina cada requisição:

```
x-awah-signature: sha256=<hex>
x-awah-timestamp: <segundos>
```

O HMAC cobre `timestamp.corpo` — o mesmo esquema dos webhooks, então o helper do
SDK vale para os dois:

```ts
import { verifyWebhookRequest } from '@awah/sdk'

const { valid, payload } = await verifyWebhookRequest(request, process.env.AWAH_SECRET!)
```

**Se a URL for pública, use o segredo.** Sem ele, qualquer um que descubra o
endereço faz o seu fluxo responder em nome do seu número.

Use `headers` para o caminho inverso — autenticar o gateway no seu sistema:

```json
{"headers": {"authorization": "Bearer o-token-do-meu-sistema"}}
```

## Teste antes de ligar

O painel tem um botão **Testar** que manda um evento de exemplo e mostra status,
tempo, o corpo cru e — quando a resposta não vira mensagem — o motivo. Ele também
mostra exatamente o que o gateway envia, para você montar o fluxo do outro lado
em cima da amostra.

Pela API:

```bash
curl -X POST http://localhost:2900/v1/integrations/http/test -H "Authorization: Bearer $AWAH_KEY" -H 'content-type: application/json' -d '{"url":"https://n8n.exemplo.com/webhook/atendimento"}'
```

## Receitas

### n8n

1. Nó **Webhook**, método `POST`, e em Respond escolha **Using Respond to Webhook
   node**. Copie a URL de produção.
2. Faça o que quiser no meio. O texto do cliente está em
   `{{ $json.body.data.body }}` e o telefone em `{{ $json.body.data.chatId }}`.
3. Nó **Respond to Webhook**, Respond With **JSON**:

```json
{ "reply": "{{ $json.resposta }}" }
```

Cole a URL do webhook no conector. Se ligou o segredo, valide a assinatura num
nó de código antes de processar.

> Atenção ao tempo. O conector espera 10 s por padrão (teto de 30 s). Fluxo do
> n8n que chama um LLM lento estoura isso — nesse caso, responda com corpo vazio
> e mande a resposta depois por `POST /v1/sessions/:id/messages`.

### Make (Integromat)

1. Módulo **Webhooks → Custom webhook**, copie a URL.
2. No fim do cenário, **Webhook response** com Body:

```json
{"reply": "{{1.texto}}"}
```

3. Status 200.

### Função serverless (Cloudflare Workers, Vercel, Lambda)

```ts
export default {
  async fetch(request: Request) {
    const { data } = await request.json()

    // Sua lógica aqui. Corpo vazio se não houver nada a responder.
    if (!data.body?.includes('preço')) return new Response(null, { status: 204 })

    return Response.json({ reply: 'Nossa tabela começa em R$ 99/mês.' })
  },
}
```

### Node com Express

```js
app.post('/awah', express.json(), (req, res) => {
  const { body, chatId } = req.body.data
  res.json({ reply: `Recebi "${body}" de ${chatId}` })
})
```

Para validar a assinatura, precisa do corpo **cru** — `express.raw()` ou a opção
`verify` do `express.json()`. Reserializar o objeto já parseado produz bytes
parecidos, não idênticos, e o HMAC falha de forma intermitente.

### Python com FastAPI

```python
@app.post("/awah")
async def awah(request: Request):
    evento = await request.json()
    texto = evento["data"]["body"]
    return {"reply": f"Recebi: {texto}"}
```

## Quando a conversa fica muda

O último erro de cada integração aparece na aba **Integrações**, com a hora.
Para o conector HTTP, os motivos frequentes:

- **A resposta não é JSON.** Muitos frameworks devolvem HTML em erro; o
  diagnóstico diz isso.
- **A resposta é JSON mas nenhum campo é reconhecido.** O diagnóstico lista os
  campos que vieram.
- **Estourou o tempo.** Aumente `timeoutMs` até 30 s, ou responda vazio e mande
  depois pela API de envio.
- **A URL não é alcançável a partir do servidor do gateway.** `localhost` dentro
  de um contêiner é o próprio contêiner; use o endereço da rede.

Erro `4xx` não é repetido — repetir devolve a mesma recusa e só atrasa o registro
do erro que você precisa ver. `5xx` e timeout são repetidos três vezes em ~7 s.

## Limite conhecido

O conector fica **dentro** do caminho da mensagem: enquanto ele espera, aquela
conversa não anda. Por isso o teto é curto.

Se a sua plataforma é lenta por natureza — LLM grande, fila própria, aprovação
humana —, o padrão certo é outro: responda `204` na hora e mande a mensagem
depois por `POST /v1/sessions/:id/messages`, que é assíncrono por construção. O
conector serve para resposta rápida; a API de envio serve para o resto.
