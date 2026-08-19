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

### 1. Crie uma caixa do tipo API

No Chatwoot: **Configurações → Caixas de entrada → Adicionar** e escolha **API**.

Precisa ser do tipo API. As outras — WhatsApp, site, e-mail — têm transporte
próprio e ignorariam o gateway. A rota recusa qualquer outro tipo, com o nome do
tipo que encontrou.

Anote o **ID da caixa** (aparece na URL) e o **ID da conta** (o número logo
depois de `/app/accounts/`).

### 2. Pegue um token de acesso

**Perfil → Configurações → Token de acesso**. Ou crie um *agent bot*, se
preferir que as ações não apareçam no nome de uma pessoa.

### 3. Ligue no painel

Aba **Integrações**, cartão do Chatwoot, escolha a sessão e preencha. O botão
diz **Testar e ligar** porque ele testa mesmo: credencial errada é recusada
antes de gravar, com a mensagem que o Chatwoot devolveu.

Ou por API:

```bash
curl -X PUT http://localhost:2900/v1/sessions/$ID/integrations/chatwoot -H "Authorization: Bearer $AWAH_KEY" -H 'content-type: application/json' -d '{"baseUrl":"https://app.chatwoot.com","accountId":1,"inboxId":7,"apiAccessToken":"SEU_TOKEN"}'
```

### 4. Cadastre a URL de volta

A resposta traz uma `webhookUrl`. Cole no Chatwoot, no campo **Webhook URL** da
caixa API.

**Trate essa URL como senha.** O webhook de caixa API do Chatwoot não assina o
corpo e não aceita cabeçalho próprio — o único lugar onde cabe um segredo é a
própria URL, e é por isso que o gateway gera um token longo em vez de deixar
você escolher. A rota confere também `account.id` do payload, porque dois pontos
de conferência valem mais que um.

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

Precisa do endereço e do **ID do fluxo** (o `publicId`, o mesmo que aparece na
URL de compartilhamento). Token só é necessário se o fluxo não for público.

```bash
curl -X PUT http://localhost:2900/v1/sessions/$ID/integrations/typebot -H "Authorization: Bearer $AWAH_KEY" -H 'content-type: application/json' -d '{"baseUrl":"https://typebot.io","typebotId":"meu-fluxo"}'
```

Não há URL para cadastrar do outro lado: quem chama o Typebot é o gateway.

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
