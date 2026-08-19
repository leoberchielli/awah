# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
O projeto segue [SemVer](https://semver.org/lang/pt-BR/) a partir do v1.0.

## [Não lançado]

Tudo abaixo está na `main` e ainda não teve release. A numeração começa no v1.0,
quando o conjunto estiver exercitado contra tráfego real.

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

**Painel**

- Dashboard React servido pela própria API, na mesma origem — é o que permite
  cookie `httpOnly` em vez de token no `localStorage`.
- Três telas: operação, negócio e sessões, com janela e filtro na URL.
- Tema claro, escuro e do sistema.

**SDK**

- `@awah/sdk`: cliente TypeScript sem dependências, sobre `fetch` e WebCrypto.
- Idempotência automática no envio, que é o que torna o retry embutido seguro.
- Verificação de assinatura de webhook que roda em Node, Deno, Bun, Workers e no
  navegador.

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

### Notas

Nada além do pareamento foi exercitado contra um número real de ponta a ponta. O
QR é gerado e o socket conecta; o funil de entrega, os limites do motor de risco
sob carga e o failover com sessão conectada ainda não passaram por um aparelho de
verdade.
