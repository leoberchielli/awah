# Primeiros passos

Do zero a uma conversa no Chatwoot. São cinco passos e nenhum `curl`.

> Use um número **dedicado** para o WhatsApp. Nunca o seu pessoal, nunca o número
> crítico da empresa. A engine não oficial viola os termos de uso da plataforma e
> existe risco real de bloqueio.

## 1. Subir

```bash
docker compose up -d
```

Levanta Postgres, Redis, aplica as migrations e sobe a API em
`http://localhost:2900`. Espere uns segundos e abra no navegador.

## 2. Criar a organização

A primeira vez que você abre, o painel mostra a tela de setup: nome da
organização, seu nome, e-mail e senha. Você entra como **owner** e essa tela
nunca mais aparece — daí em diante, novos usuários entram por convite.

## 3. Parear o número

Aba **Sessões** → **Nova sessão** → dê um nome → **Iniciar**.

O QR aparece sozinho no topo da tela, com o passo a passo do lado. No celular:
três pontinhos (Android) ou **Ajustes** (iPhone) → **Aparelhos conectados** →
**Conectar um aparelho** → aponte para o código.

A faixa some sozinha quando o aparelho aceita, e a sessão vira **Conectada**.

## 4. Ligar o Chatwoot

Aba **Integrações** → **Conectar o Chatwoot**.

Você precisa de duas coisas: o endereço da sua instância e um **token de
acesso** (no Chatwoot: seu avatar → Perfil → Token de acesso).

O resto o gateway descobre sozinho — a conta, as caixas existentes, e a criação
da caixa API com o webhook já apontado. **Use um token de administrador**: com
token de agente comum o Chatwoot recusa criar caixa, e aí o passo volta a ser
manual.

Pronto. Mande uma mensagem para o número pareado e ela aparece na caixa de
entrada. Responda por lá e ela sai pelo WhatsApp.

## 5. Ver funcionando

Aba **Operação**. O funil `enviadas → entregues → lidas`, a latência p95, a fila
e o que o motor de risco segurou.

Não espere números interessantes com dez mensagens — o painel foi feito para
volume. Mas o funil já mostra se a entrega está acontecendo.

---

## Variações

### Quero um robô respondendo antes do humano

Ligue também o **Typebot**, na mesma sessão. Publique o fluxo lá, copie o link em
**Share**, e cole no assistente. Não é o endereço do editor — aquele usa o id
interno e não funciona no Chat API.

O arranjo dos dois juntos é o mais útil: o fluxo atende primeiro, e quando o
cliente digita **atendente** ele se cala e o agente assume uma conversa que já
tem todo o histórico.

### Quero integrar com o meu sistema, não com uma ferramenta

Crie uma chave de API e use o SDK:

```bash
npm install @awah/sdk
```

```ts
import { Awah } from '@awah/sdk'

const awah = new Awah({ baseUrl: 'http://localhost:2900', apiKey: process.env.AWAH_KEY! })
await awah.messages.sendText(sessionId, { chatId: '5511987654321', text: 'olá' })
```

Detalhes em [packages/sdk](../packages/sdk/README.md).

### Quero expor isso na internet

Leia [producao.md](producao.md) antes. Resumo do que não pode faltar: gerar seus
próprios segredos (a API se recusa a subir em produção com os deste
repositório), definir `METRICS_TOKEN`, configurar `TRUST_PROXY` conforme a sua
topologia, e não publicar as portas do Postgres e do Redis.

### Não quero usar Docker

```bash
pnpm install && cp .env.example .env
```

Gere os dois segredos que o `.env` pede, suba Postgres e Redis por conta
própria, e depois:

```bash
pnpm db:migrate && pnpm dev
```

## Quando algo não funciona

[solucao-de-problemas.md](solucao-de-problemas.md) cobre os sintomas que
aparecem de verdade: sessão que não pareia, mensagem presa na fila, webhook que
não chega, assinatura que não bate.
