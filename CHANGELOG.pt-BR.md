# Changelog

*[English](CHANGELOG.md)*

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
O projeto segue [SemVer](https://semver.org/lang/pt-BR/) a partir do v1.0.

## [Não lançado]

Tudo abaixo está na `main` e ainda não teve release. A numeração começa no v1.0,
quando o conjunto estiver exercitado contra tráfego real em escala.

### Adicionado

**Fundação**

- Monorepo pnpm com Fastify 5, TypeScript e Drizzle sobre Postgres e Redis.
- Autenticação em duas credenciais: sessão de usuário por cookie assinado
  (argon2id) e chave de API por bearer (segredo guardado só como hash).
- RBAC com quatro papéis e escopo de sessão por chave. Chave de API nunca
  administra identidade.
- Imagem Docker multiestágio com usuário não-root, `tini` como PID 1 e
  healthcheck. CI com Postgres e Redis reais.

**Engines**

- Contrato `EngineAdapter` e matriz de capacidades publicada em `GET /v1/engines`.
- Adapter Baileys com auth state cifrado no Postgres — é o que torna o failover
  possível.
- Adapter Cloud API atrás do mesmo contrato, com credenciais cifradas e webhook
  da Meta com verificação de assinatura sobre os bytes crus.
- Tabela de códigos de desconexão traduzidos, com reconexão automática só nos
  casos em que reconectar ajuda.

**Fila**

- Outbox transacional com ordem total por `seq` e FIFO por conversa, com chats
  diferentes em paralelo.
- Idempotência por `clientMessageId`.
- Retry com backoff, fila morta consultável e replay.
- Sessão caída ou em pareamento devolve o envio à fila **sem** consumir
  tentativa.

**Motor de risco**

- Orçamento por janela deslizante (minuto, hora, dia) e teto separado de contatos
  novos por dia.
- Curva de warmup: 5% do teto no primeiro dia, 100% em trinta.
- Score 0–100 com quatro sinais e a contribuição de cada um exposta.
- Jitter log-normal e presença de digitação proporcional ao texto.
- Nunca descarta: o que não passa agora espera, com ETA real.

**Cluster**

- Posse de sessão por lease no Redis, sem nó primário nem eleição.
- Failover automático medido em ~20 s com `SIGKILL`.
- Comandos roteados ao nó dono por pub/sub; QR compartilhado entre réplicas.
- Intenção (`desired_state`) separada de estado (`status`).

**Observabilidade**

- Agregados horários e quatro famílias de KPI.
- `/metrics` em formato Prometheus, protegido por token.
- Instrumentação com a API do OpenTelemetry, sem SDK embutido.

**Demonstração pública**

- `DEMO_MODE`: uma instância que publica as próprias credenciais de admin, gera
  um mês de histórico e se reconstrói sozinha de tempos em tempos. No ar em
  [awah-demo.99ia.com.br](https://awah-demo.99ia.com.br) e reproduzível em
  qualquer lugar com o `docker-compose.demo.yml`.
- É a única coisa que libera o `SIMULATOR_ENABLED` em produção, e ela paga esse
  direito eliminando o motivo da trava: a instância diz que é demo na tela de
  login, em `/v1/auth/bootstrap`, em `/v1/auth/me` e numa faixa em todo o
  painel. O que torna uma engine falsa perigosa é o silêncio.
- Três números no seed — maduro, aquecendo e degradado — mais mensagens na
  dead-letter e mensagens seguradas pelo motor de risco. Demo com tudo verde não
  ensina nada sobre um gateway que existe para o dia em que para de estar verde.
- A conta publicada não pode ser removida nem rebaixada, e a organização não
  pode ser apagada; todo o resto que o visitante fizer é real e dura até o
  próximo reset. Nenhuma engine além do simulador abre sessão, porque a
  instância roda com segredos publicados e a `ENCRYPTION_KEY` é o que protege o
  auth state de um número pareado.
- O cenário do simulador agora pode vir de `sessions.config.simulator`, e não só
  da convenção de nome `sim:<cenário>:…` — assim um número da demo se chama
  `Billing` e mesmo assim é o degradado.

**Painel**

- Dashboard React servido pela própria API, na mesma origem — é o que permite
  cookie `httpOnly` em vez de token no `localStorage`.
- Seis telas: operação, negócio, sessões, integrações, chaves e usuários, com
  janela e filtro na URL.
- Chaves de API são emitidas, escopadas e revogadas pelo painel. O token
  aparece uma vez só, e escopo que não alcança sessão nenhuma é recusado com o
  motivo.
- Membros são adicionados, promovidos e removidos pelo painel. O último dono
  não pode ser rebaixado nem removido, e o painel avisa antes de o servidor
  precisar recusar.
- Tema claro, escuro e do sistema.
- Vidro no cromo e nos cartões, sobre uma camada ambiente que dá ao desfoque o
  que refratar. O efeito para nas superfícies grandes e poucas: linha de lista,
  pílula e célula de tabela continuam opacas, porque `backdrop-filter` em
  centenas de elementos é o que transforma "moderno" em "travado". O contraste
  foi medido nas telas nos dois temas; o pior par dá 4,62 contra um mínimo de
  4,5.

**SDK**

- `@awah/sdk`: cliente TypeScript sem dependências, sobre `fetch` e WebCrypto.
- Idempotência automática no envio, que é o que torna o retry embutido seguro.
- Verificação de assinatura de webhook que roda em Node, Deno, Bun, Workers e no
  navegador.

**Integrações**

- Conectores nativos de Chatwoot e Typebot, ligados por sessão. A decisão por
  trás deles: em vez de construir caixa de entrada e construtor de fluxo
  próprios, ser o transporte de quem já resolveu bem essas duas coisas — e
  entregar embaixo delas o que nenhuma tem, que é fila durável, ordem por
  conversa e motor de risco.
- Chatwoot nos dois sentidos, com prevenção de eco por `source_id` e
  idempotência pelo id da mensagem de lá, o que torna a reentrega deles
  inofensiva.
- Typebot com sessão de fluxo por contato, expiração por silêncio e escape para
  atendimento humano que não passa pelo fluxo.
- Credenciais cifradas e nunca devolvidas em leitura; conexão testada antes de
  gravar, porque credencial errada guardada em silêncio só apareceria na
  primeira mensagem de um cliente real.
- Falha de ferramenta externa nunca derruba a sessão: o dispatcher engole a
  própria exceção e registra o erro na integração, para o painel explicar o
  silêncio.

**Adoção**

- Tela de primeira execução no painel. A única forma de criar a organização
  inicial era montar um `curl` a partir do README — a trava mais cara que um
  projeto self-hosted pode ter, porque acontece antes de a pessoa ver qualquer
  valor.
- O Chatwoot passa a pedir dois campos: endereço e token. O gateway descobre as
  contas, lista as caixas e **cria a caixa API já com o webhook apontado para
  ele**. Caçar `accountId` e `inboxId` na URL e voltar lá para colar o webhook
  eram os três passos que mais faziam gente desistir.
- O Typebot aceita o link de compartilhamento no lugar de endereço e `publicId`
  separados, e recusa o link do editor explicando onde está o certo — em vez de
  aceitar e falhar depois, na primeira mensagem de um cliente real.

**Qualquer plataforma**

- Conector HTTP genérico: o gateway posta a mensagem recebida numa URL e envia
  de volta o que a resposta trouxer. É o escape que faz plugar uma ferramenta
  nova não depender de alguém escrever um conector dedicado — n8n, Make, uma
  função serverless ou o sistema da casa entram por ele sem mudança de código.
- Diferente de um webhook comum, que avisa e esquece: aqui a resposta **é** a
  mensagem, e entra pela mesma fila de qualquer envio, com ordem por conversa,
  motor de risco e reentrega.
- Aceita as formas de resposta que aparecem na prática (`reply`, `replies`,
  `text`, array, string) e, quando nada é reconhecido, devolve o diagnóstico do
  motivo em vez de ficar em silêncio.
- Assinatura HMAC no mesmo esquema dos webhooks, então quem já valida um valida o
  outro com a mesma função do SDK.
- Botão de teste que manda um evento de exemplo e mostra status, tempo, corpo
  cru e o que seria enviado.

**Idioma**

- O painel vem em dez idiomas — inglês, português, espanhol, hindi, indonésio,
  árabe, francês, alemão, russo e turco — escolhidos no menu, cada um escrito
  no próprio idioma. O árabe vira o layout para RTL.
- Os catálogos são tipados como `Partial` do inglês e carregam sob demanda, um
  chunk cada: tradução parcial compila e vai ao ar, e um décimo primeiro idioma
  não custa nada a quem não o escolhe. `pnpm i18n:check` mostra a cobertura e
  falha em placeholder perdido — o erro que faz um número sumir em tempo de
  execução sem nada mais para pegá-lo.
- Número, data e duração vêm do `Intl`, não do catálogo, e por isso seguem o
  idioma de quem lê. É o que o catálogo não consegue expressar: o árabe precisa
  de quatro formas de plural para uma contagem e o russo de três, e uma string
  só guarda uma.
- O inglês é o padrão da plataforma, da documentação e do código. As mensagens
  da API, os schemas do OpenAPI, todo comentário e todo identificador estão em
  inglês; a documentação em português fica ao lado, como tradução.

**Distribuição**

- Imagem publicada em `ghcr.io/leoberchielli/awah`, multi-arquitetura
  (amd64 e arm64). O CI já construía a imagem para provar que o Dockerfile
  compila e jogava o resultado fora — o que obrigava quem quisesse experimentar a
  clonar o repositório e compilar antes de ver a primeira tela.
- O `docker-compose.yml` passa a puxar a imagem em vez de construir, e roda
  sozinho: baixar esse arquivo e subir é o caminho completo. Construir a partir do
  código virou o override `docker-compose.dev.yml`.
- Dados em volumes nomeados, não em pastas do repositório — quem baixou só o
  compose não tem repositório nenhum.
- Rótulos OCI, e `GET /health` devolvendo versão e commit da imagem: a primeira
  pergunta de qualquer suporte, respondida sem abrir o contêiner.
- Attestation de proveniência assinada em cada publicação, verificável com
  `gh attestation verify`.

### Segurança

- Em `NODE_ENV=production`, a API se recusa a subir com os segredos de
  desenvolvimento publicados neste repositório.
- `TRUST_PROXY` passa a ser configurável e vem `false`. Antes era `true` fixo, o
  que deixava qualquer cliente escolher o próprio IP por `X-Forwarded-For` e
  escapar do rate limit.
- CSP escrita à mão e ativa em todos os ambientes. Antes só valia em produção, o
  que significava descobrir a quebra no deploy.
- `appSecret` da Cloud API passa a ser obrigatório. Sendo opcional, existia um
  caminho anônimo para injetar mensagens falsas na conta de qualquer cliente.
- Teto de corpo de requisição configurável, 1 MiB por padrão.
- Aviso no boot quando `METRICS_TOKEN` não está definido.

### Corrigido

**O orçamento não segurava sob concorrência.**

O motor de risco lia as janelas deslizantes, decidia, e registrava o envio
depois da entrega. Entre os dois passos ficavam a presença de digitação, o
jitter humano de vários segundos e a ida e volta até o engine — e o agendador
roda cinquenta envios ao mesmo tempo. Todo trabalhador dentro dessa fresta lia
a mesma janela vazia, e todos passavam.

O efeito não era sutil. Um benchmark flagrou uma sessão com teto de uma
mensagem por minuto enviando vinte e seis em vinte segundos; uma medição direta
passou quarenta envios simultâneos por um teto de cinco. Ou seja: o recurso que
mais define este projeto — dosar o ritmo de um número para ele não ser banido —
não funcionava justamente quando havia tráfego, que é a única hora em que
importa.

A contagem e a reserva agora acontecem dentro de um único script no Redis,
então são um passo indivisível por mais trabalhadores que perguntem ao mesmo
tempo. Um slot que não vira envio é devolvido, para que uma sessão com uma
tarde ruim não gaste a cota do dia com mensagens que ninguém recebeu. O `check`
segue somente de leitura para o painel: relatar um orçamento não pode consumi-lo.

Quem já rodava isto deve assumir que seus números vinham enviando mais rápido
do que os limites configurados.

**O failover pulava o simulador, então o failover ficou sem teste.**

A varredura que adota sessões órfãs selecionava `engine = 'baileys'`. Está
certo para a Cloud API — HTTP sem estado não segura socket nenhum e não há o
que adotar —, mas isso também excluía o simulador, que segura. O efeito era
circular: o único engine capaz de exercitar failover sem um aparelho de
verdade era justamente o que o failover ignorava, então o caminho seguiu sem
verificação. Agora ela seleciona os engines que seguram socket, e uma execução
ao vivo mata a réplica dona e vê a outra assumir a sessão e enviar por ela.

### Notas

O último salto deixou de depender do simulador: o gateway rodou contra quatro
números reais, cerca de 3.700 mensagens pela engine Baileys, com webhooks
assinados o tempo todo e o motor de risco regulando o ritmo. Nenhum dos quatro
foi bloqueado.

O que segue em aberto é escala e duração. Quatro números e alguns milhares de
mensagens não dizem como o WhatsApp trata um número com dez vezes esse volume,
ou ao longo de meses.
