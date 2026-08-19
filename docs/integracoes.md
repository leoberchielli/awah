# Chatwoot e Typebot

O AWAH não tem caixa de entrada nem construtor de fluxo, e isso é uma decisão,
não uma lacuna. O Chatwoot já resolve atendimento humano muito bem; o Typebot já
resolve fluxo muito bem. O que falta aos dois é o que o gateway tem:

| | Ligado direto na Meta | Com o AWAH embaixo |
| --- | --- | --- |
| Ordem por conversa | sem garantia | FIFO por chat, chats em paralelo |
| Mensagem perdida | dispara e esquece | fila durável, retry, DLQ com replay |
| Ritmo de envio | o que a ferramenta mandar | orçamento, warmup e freio adaptativo |
| Reentrega duplicada | manda de novo | idempotência por chave |
| Estado de entrega | "enviei" | funil sent → delivered → read |

Por isso vale pôr o gateway no meio em vez de ligar as ferramentas na Meta
diretamente.

## Chatwoot

Fala nos dois sentidos: a mensagem do cliente vira conversa na caixa de entrada,
e a resposta do agente volta pela fila do gateway.

### Pelo painel, em dois campos

Aba **Integrações** → **Conectar o Chatwoot**. Você informa só o endereço da sua
instância e um **token de acesso** (no Chatwoot: avatar → Perfil → Token de
acesso).

O gateway faz o resto:

1. Pergunta ao token quais contas ele alcança, e lista para você escolher — o
   `accountId` fica escondido na URL do Chatwoot, e caçá-lo lá é a primeira coisa
   que trava a adoção.
2. Lista as caixas dessa conta, marcando quais servem. Caixa que não é do tipo
   API aparece desabilitada com o motivo, em vez de sumir: quem procura a caixa
   que já usa precisa entender por que ela não serve.
3. Cria a caixa API **já com o webhook apontado** para o gateway, ou corrige o
   webhook da caixa existente que você escolher.

**Use um token de administrador.** Criar e editar caixa exige isso; com token de
agente comum o Chatwoot devolve 403, e o assistente diz exatamente isso em vez de
falhar em silêncio.

### Pela API

```bash
curl -X POST http://localhost:2900/v1/integrations/chatwoot/discover -H "Authorization: Bearer $AWAH_KEY" -H 'content-type: application/json' -d '{"baseUrl":"https://app.chatwoot.com","apiAccessToken":"SEU_TOKEN"}'
```

Devolve as contas. Repita com `accountId` para receber também as caixas. Depois:

```bash
curl -X PUT http://localhost:2900/v1/sessions/$ID/integrations/chatwoot -H "Authorization: Bearer $AWAH_KEY" -H 'content-type: application/json' -d '{"baseUrl":"https://app.chatwoot.com","accountId":1,"apiAccessToken":"SEU_TOKEN","createInbox":"WhatsApp (AWAH)"}'
```

`createInbox` cria a caixa; `inboxId` reaproveita uma existente e corrige o
webhook dela. Passando `inboxId` com `apontarWebhook: false`, o gateway não toca
na caixa e a resposta traz a URL para você colar na mão.

### O segredo mora na URL

Quando o gateway aponta o webhook sozinho, não há nada a fazer do outro lado. Se
você configurar manualmente, **trate a URL como senha**: o webhook de caixa API
do Chatwoot não assina o corpo e não aceita cabeçalho próprio, então a URL é o
único segredo entre os dois. Por isso o gateway gera um token longo em vez de
deixar você escolher, e por isso a rota confere também o `account.id` do payload.

### O que não é reenviado

Três descartes, cada um por um sintoma concreto:

- **Nota interna** (`private: true`) é conversa da equipe sobre o cliente, não
  com ele.
- **Mensagem com `source_id`** nasceu no WhatsApp e foi criada por nós no
  Chatwoot. Devolvê-la seria o laço de eco clássico.
- **Reentrega do mesmo evento** vira duplicata reconhecida pela fila: a chave de
  idempotência é `chatwoot:<id da mensagem>`, então o Chatwoot pode reentregar à
  vontade que o cliente recebe uma vez só.

## Typebot

Responde ao que chega. A mensagem do cliente entra no fluxo, e o que o fluxo
produzir sai pela fila do gateway — herdando ordem, ritmo e reentrega.

### Ligar

Cole o **link de compartilhamento** do fluxo — endereço e `publicId` saem dele.
No Typebot: publique e copie em **Share**.

```bash
curl -X PUT http://localhost:2900/v1/sessions/$ID/integrations/typebot -H "Authorization: Bearer $AWAH_KEY" -H 'content-type: application/json' -d '{"shareUrl":"https://typebot.io/meu-fluxo"}'
```

Token só é necessário se o fluxo não for público. Não há URL para cadastrar do
outro lado: quem chama o Typebot é o gateway.

O engano mais provável é colar o endereço do **editor** — ele traz o id interno,
que o Chat API não aceita. O gateway recusa esse link dizendo onde está o certo,
em vez de aceitar e falhar depois, na primeira mensagem de um cliente real.

### Sessão de fluxo

Uma por contato. A primeira mensagem inicia o fluxo; as seguintes continuam de
onde parou. Sem isso, o cliente ficaria preso na primeira pergunta para sempre.

A sessão expira por silêncio — `sessionTtlMinutes`, padrão 6 horas. Alguém que
volte a escrever três semanas depois cairia no meio de um formulário que já não
faz sentido.

Quando o fluxo chega ao fim, o Typebot para de pedir resposta e a sessão encerra
na hora: a próxima mensagem começa um fluxo novo.

### Escape para o humano

`humanHandoffKeyword`, padrão **atendente**. Quem digitar isso encerra a sessão
de fluxo e recebe `humanHandoffReply` — e a mensagem **não** vai para o fluxo,
porque quem pediu para falar com gente não deve receber mais uma resposta
automática.

Deixe vazio para desligar o escape, mas só faça isso se houver outro caminho até
uma pessoa.

## Os dois juntos

É o arranjo mais útil, e o motivo de as duas integrações conviverem na mesma
sessão: o Typebot atende primeiro e o Chatwoot recebe a conversa inteira. Quando
o cliente digita a palavra de escape, o fluxo se cala e o agente assume uma
conversa que já tem todo o histórico.

## Quando alguma coisa não chega

A aba **Integrações** mostra o último erro de cada ligação, com a hora. É a
primeira coisa a olhar quando a conversa para de aparecer na ferramenta.

O gateway nunca deixa uma falha de ferramenta externa derrubar a sessão: no
limite, um Chatwoot fora do ar derrubaria a conexão do WhatsApp por causa de um
serviço de terceiro. Ele tenta três vezes em ~7 s, registra o erro e segue.

**A consequência honesta:** se a ferramenta ficar fora do ar por mais que esses
segundos, a mensagem fica no AWAH e não aparece lá. Ela continua em
`GET /v1/sessions/:id/messages` e nos webhooks — nada se perde do lado do
gateway —, mas ainda não há ressincronização automática para dentro do Chatwoot.
É a próxima coisa a construir aqui.

Erro `4xx` não é repetido: token inválido ou caixa inexistente devolvem a mesma
recusa três vezes e só atrasariam o registro do erro que você precisa ver.

## Segurança

As credenciais são cifradas em AES-256-GCM, na mesma tabela do auth state das
sessões, e **nunca** aparecem em leitura — `GET /v1/integrations` devolve estado
e último erro, nada mais. O token do Chatwoot escreve na conta de atendimento do
cliente e lê todas as conversas dela: é credencial, não configuração.
