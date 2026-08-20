# Solução de problemas

*[English](troubleshooting.md)*

Os sintomas que aparecem de verdade, e o que cada um costuma ser.

## A sessão não pareia

**O QR não aparece.** `GET /v1/sessions/:id/qr` responde 404 quando não há
pareamento em curso. Confira, nesta ordem:

1. A sessão está `pairing`? `GET /v1/sessions/:id`. Se estiver `created`, o
   `start` não foi chamado ou falhou.
2. `GET /v1/sessions/:id/events` mostra um `pairing_requested`? Se não, a engine
   não chegou a abrir o socket.
3. `ENGINE_LOG_LEVEL=debug` e reinicie. É a primeira coisa a fazer quando uma
   sessão se recusa a parear — o Baileys diz bastante nesse nível.

**O QR aparece mas o aparelho recusa.** O código expira em segundos. Busque
`/qr` **depois** do `start` e renove enquanto o estado for `pairing`; o painel faz
isso a cada dois segundos. Um QR de dez segundos atrás já falhou.

**Pareou e caiu logo em seguida com 515.** Não é falha. O protocolo exige recriar
o socket depois do pareamento e sinaliza com 515; o gerenciador reconecta em 750 ms.
Se ficar em laço de 515, aí sim há problema.

## A sessão cai o tempo todo

`GET /v1/sessions/:id/events` traz o código bruto ao lado da causa traduzida. A
diferença entre eles é toda a informação:

| Código | O que é | O que fazer |
| --- | --- | --- |
| `428` | Socket caiu | Nada. Volta sozinho. |
| `408` | Timeout | Nada. Volta sozinho. |
| `440` | **Credencial aberta em outro lugar** | Ver abaixo. Insistir piora. |
| `401` | O aparelho desconectou o dispositivo | Só novo pareamento resolve. |
| `403` | Conta bloqueada | Número queimado. |
| `515` | Reinício exigido após pareamento | Nada. É esperado. |

**`440` repetido é o sintoma mais confuso do protocolo.** Significa que o mesmo
auth state está aberto em dois lugares, e o WhatsApp derruba os dois
alternadamente. Causas reais, em ordem de frequência:

- Uma cópia do banco rodando em outra máquina com a mesma sessão.
- Duas réplicas com o mesmo `NODE_ID` — as duas acham que têm o lease.
- Alguém restaurou um backup e subiu junto com a instância viva.

O lease no Redis impede isso **dentro** de um cluster. Ele não impede dois
clusters diferentes apontando para o mesmo Postgres.

## As mensagens ficam na fila

`GET /v1/outbox?status=queued` mostra o que está esperando. O motivo está em três
lugares:

**A sessão não está conectada.** Sessão caída ou em pareamento devolve o envio à
fila sem consumir tentativa — de propósito, para que a indisponibilidade não gaste
as cinco tentativas. Consertar a sessão destrava a fila.

**O motor de risco está segurando.** `GET /v1/sessions/:id/risk` mostra o consumo
das janelas e o `throttleFactor`. Se `scheduledAt` da mensagem está no futuro, é
isso — e o horário é real, calculado do envio mais antigo ainda dentro da janela.

Lembre que os limites configurados são o **alvo**, não o valor de hoje. Sessão
pareada hoje roda a 5% deles. Configurar 5000/dia numa sessão nova resulta em 250
efetivas, e isso é proposital.

**A vazão não dá conta.** `OUTBOX_MAX_CONCURRENT` (padrão 50) limita envios
simultâneos por nó, e o jitter humano segura cada um por segundos. Se a fila
cresce sem parar com as sessões saudáveis e o risco liberando, o gargalo é esse —
mas aumentar o número é exatamente o comportamento que derruba chip. Prefira mais
sessões a mais velocidade por sessão.

## As mensagens vão para a fila morta

`GET /v1/outbox?status=dead` lista, e `lastError` diz o motivo. Nada é descartado:
a linha continua lá e `POST /v1/outbox/:id/retry` devolve à fila.

Erro que se repete em todas: costuma ser destinatário inválido ou capacidade que a
engine não tem. Confira `GET /v1/engines` — a Cloud API não faz grupos, e fora da
janela de 24 h só aceita template aprovado.

## O webhook não chega

**Confira se ele saiu.** `GET /v1/webhooks/deliveries?status=dead` e
`?status=failed`. Se não há nada, o evento não foi gerado — o problema está antes.

**4xx que não seja 408 ou 429 vai direto para a fila morta.** Repetir não conserta
payload rejeitado. Se o seu endpoint responde 400 porque a assinatura não bate,
veja o item seguinte.

**A assinatura não bate.** A causa é quase sempre a mesma: você está verificando
sobre o JSON reserializado, não sobre os bytes crus. `JSON.stringify` do objeto já
parseado produz bytes parecidos, não idênticos — ordem de chaves, escapes e
espaçamento podem diferir. Em Express, isso significa `express.raw()` ou
`verify` no `express.json()`.

A assinatura cobre `timestamp.corpo`, não só o corpo:

```js
const esperado = 'sha256=' + createHmac('sha256', segredo).update(`${timestamp}.${corpoCru}`).digest('hex')
```

Ou use o SDK, que já faz isso: `verifyWebhookRequest(request, secret)`.

**O relógio do seu servidor está errado.** A janela é de 5 minutos. Se o horário
do seu host derivou mais que isso, toda entrega legítima é rejeitada como replay.

## O painel não abre

**Página em branco, API respondendo.** O build do dashboard não foi encontrado. O
log do boot diz qual caso é: `dashboard sendo servido pela API` com a raiz, ou
`dashboard não empacotado`. No segundo caso, rode `pnpm --filter @awah/web build`
ou aponte `DASHBOARD_DIR`.

**Rota de cliente devolvendo JSON de 404.** Você pediu `application/json` no
`Accept`, ou o caminho começa com um dos prefixos reservados (`/v1/`,
`/webhooks/`, `/metrics`, `/docs`, `/health`, `/ready`). Isso é proposital: um
`GET /v1/sessoes` digitado errado precisa devolver erro JSON, não `<!doctype html>`.

**Login não persiste.** Fora de `NODE_ENV=production` o cookie vai sem a flag
`secure`; alguns navegadores recusam cookie sem `secure` em origem HTTPS. Se você
está atrás de TLS, use `NODE_ENV=production`.

## O failover não acontece

**A sessão continua parada depois de o nó morrer.** Confira `desired_state`. O
failover só ressuscita o que está `running` — uma sessão que você parou fica
parada, e isso é o comportamento correto.

**Demora mais que 20 segundos.** A conta é `LEASE_TTL_MS` (15 s) mais
`FAILOVER_SCAN_MS` (10 s) no pior caso. Baixar os dois acelera a recuperação e
aumenta o risco de uma réplica lenta perder o lease de uma sessão que ela ainda
está segurando.

**Nenhuma réplica assume.** Todas precisam alcançar o mesmo Redis. Se cada uma
está num Redis próprio, cada uma acha que é dona de tudo — e aí você tem o
problema do `440`.

## O processo não sobe

**"Estes segredos são os de desenvolvimento".** Exatamente o que diz: em
`NODE_ENV=production` a API se recusa a subir com os valores publicados neste
repositório. Gere os seus com os comandos que a própria mensagem mostra.

**"Configuração de ambiente inválida".** A mensagem lista campo por campo o que
está errado. Os enganos comuns: `ENCRYPTION_KEY` que não tem 32 bytes em base64
(gere com `openssl rand -base64 32`, não invente), e `PUBLIC_URL` sem esquema —
`awah.exemplo.com` não é URL, `https://awah.exemplo.com` é.

**Migration pendente.** A API não aplica migration sozinha no boot. Rode
`pnpm db:migrate` antes.

## Ainda não resolveu

`LOG_LEVEL=debug` para a aplicação e `ENGINE_LOG_LEVEL=debug` para a engine, nesta
ordem — inverter afoga o log da aplicação no ruído do Baileys.

Se der em bug, abra uma issue com o trecho de log, a versão e o passo a passo. Se
for de segurança, não abra issue: veja [SECURITY.md](../SECURITY.pt-BR.md).
