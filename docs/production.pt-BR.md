# Levar para produção

*[English](production.md)*

O README ensina a subir. Este documento é sobre subir e não se arrepender.

## Antes de abrir a porta

A API cobra as três primeiras sozinha. As demais não têm como cobrar.

**Segredos próprios.** Em `NODE_ENV=production` o processo se recusa a nascer com
os valores de desenvolvimento deste repositório — eles estão no
`docker-compose.yml` e no `.env.example`, e quem os lê forja um cookie de sessão e
decifra o auth state de todas as sessões.

```bash
openssl rand -base64 32
```

```bash
openssl rand -base64 48
```

**`METRICS_TOKEN` definido.** Sem ele, `/metrics` entrega volume de mensagens,
número de sessões e saúde da operação a quem alcançar a porta. A API avisa no
boot quando falta.

**`TRUST_PROXY` conforme a topologia.** O padrão é `false`, e é o certo quando
não há proxy. Com proxy na frente, prefira a lista de CIDRs:

```bash
TRUST_PROXY=10.0.0.0/8,172.16.0.0/12
```

`TRUST_PROXY=true` funciona, mas confia em `X-Forwarded-For` vindo de qualquer
lugar. Se alguém alcançar a porta da aplicação sem passar pelo proxy, escolhe o
próprio IP a cada requisição e nunca bate no rate limit.

**Postgres e Redis fora da internet.** O `docker-compose.yml` publica as duas
portas para facilitar desenvolvimento. Em produção, remova os blocos `ports` dos
dois serviços.

**Os dados vivem em volumes nomeados** (`awah_awah-postgres`, `awah_awah-redis`),
e não em pastas do repositório — quem baixou só o compose não tem repositório
nenhum. É de `awah_awah-postgres` que sai o backup, e é ele que precisa
sobreviver a qualquer `docker compose down`. **Nunca use `down -v`**: a flag
apaga os volumes, e com eles o auth state de todas as sessões.

## A perda que dói

Backup do Postgres não é sobre mensagens — é sobre **`session_auth` e
`session_signal_keys`**. Perder essas duas tabelas significa reparear todos os
números na mão, com um aparelho por vez.

```bash
docker compose exec -T postgres pg_dump -U awah --format=custom awah > awah-$(date +%F).dump
```

Restaure num banco vazio de vez em quando e suba a API apontando para ele. Backup
que nunca foi restaurado é hipótese, não backup.

**`ENCRYPTION_KEY` faz parte do backup.** O dump traz o auth state cifrado; sem a
chave, ele é ruído. Guarde a chave onde o dump não está, e não a rotacione sem
plano — não há reencriptação automática hoje, e trocar a chave torna todas as
sessões ilegíveis.

Redis não precisa de backup. Ele guarda leases, orçamentos e QR — tudo
reconstruível. Perder o Redis custa um failover, não uma sessão.

## TLS e proxy

O AWAH fala HTTP. Quem fala HTTPS é o que está na frente.

```nginx
server {
  listen 443 ssl http2;
  server_name awah.suaempresa.com;

  # O QR e o painel toleram bem; o que não tolera é timeout curto no webhook.
  proxy_read_timeout 65s;

  location / {
    proxy_pass http://127.0.0.1:2900;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Com isso no lugar, defina no ambiente da API:

```bash
PUBLIC_URL=https://awah.suaempresa.com
TRUST_PROXY=127.0.0.1
NODE_ENV=production
```

`PUBLIC_URL` não é cosmético: é dele que sai a URL absoluta que a Meta precisa
cadastrar como webhook, e o endereço que a documentação interativa usa.

## Várias réplicas

Aponte todas para o mesmo Postgres e o mesmo Redis. Não há nó primário, e todas
rodam o mesmo código.

```yaml
services:
  api:
    image: awah-api
    environment:
      NODE_ID: ${HOSTNAME}
      # ... o resto igual em todas
    deploy:
      replicas: 3
```

**`NODE_ID` único por réplica.** Vazio, ele vem do hostname — o que já é único em
Kubernetes e no Swarm, e não é em `docker compose up --scale` sem cuidado. Duas
réplicas com o mesmo `NODE_ID` disputam o mesmo lease e uma acha que já é dona
quando não é.

**O balanceador não precisa de sticky session.** Comandos que exigem socket vivo
viajam até o nó dono por pub/sub; o QR é publicado no Redis e lido por qualquer
réplica.

**Dimensione pelo número de sessões, não pelo tráfego HTTP.** Cada sessão do
Baileys é um WebSocket aberto com estado de criptografia em memória. A conta que
importa é essa.

## Atualizar

```bash
docker compose pull && docker compose up -d
```

O serviço `migrate` roda antes da API e é ele que aplica as migrations — a API
só sobe depois de ele terminar com sucesso. As migrations são aditivas e o código
novo tolera schema velho por uma versão; o contrário não vale, então nunca rode
uma imagem antiga contra um banco já migrado.

**Fixe a versão em produção.** O padrão do compose é `latest`, que é conveniente
para experimentar e ruim para operar — um `docker compose pull` pode trazer uma
versão que você não revisou.

```bash
AWAH_IMAGE=ghcr.io/leoberchielli/awah:1.0.0
```

`GET /health` devolve a versão e o commit que estão rodando, para não haver
dúvida sobre o que está no ar.

Com várias réplicas, atualize uma por vez. Enquanto uma reinicia, o lease das
sessões dela expira em 15 s e outra assume — a janela é a mesma do failover.

Desligamento é ordenado: `SIGTERM` para de aceitar conexão nova, drena o que está
em voo, solta os leases e só então fecha Postgres e Redis. Dê ao orquestrador ao
menos 30 s de `terminationGracePeriod`.

### Confira de onde veio a imagem

```bash
gh attestation verify oci://ghcr.io/leoberchielli/awah:1.0.0 --owner leoberchielli
```

A attestation prova que aquela imagem saiu daquele commit, por aquele workflow.
Quem roda um gateway com as credenciais dos próprios clientes dentro tem motivo
de sobra para conferir isso antes de subir.

## O que monitorar

Alertas que valem a pena, em ordem de urgência:

| Sinal | Onde | Por que importa |
| --- | --- | --- |
| Sessão com `desired_state=running` que não está rodando | painel, aba Operação | A fila continua aceitando e nada sai. Custa dinheiro em silêncio. |
| `awah_outbox_depth` crescendo sem parar | `/metrics` | Ou a sessão caiu, ou o risco está segurando, ou a vazão não dá conta. |
| `awah_outbox_depth{status="dead"}` > 0 | `/metrics` | Mensagem que esgotou as tentativas. Não some sozinha. |
| Score de risco acima de 70 | `GET /v1/sessions/:id/risk` | A sessão está com comportamento que costuma preceder bloqueio. |
| Quedas por hora subindo numa sessão | painel, MTBF | `440` repetido é credencial aberta em dois lugares. |
| Webhooks na fila morta | `GET /v1/webhooks/deliveries?status=dead` | Seu endpoint está rejeitando ou fora do ar. |

O painel responde as três primeiras de relance. O Prometheus é para o que precisa
acordar alguém.

## Retenção e LGPD

`retentionDays` na organização controla por quanto tempo o **corpo** das mensagens
é preservado. Padrão 30 dias.

- `0` nunca persiste conteúdo — só metadados. É a configuração para quem não quer
  a conversa do cliente no seu banco.
- `-1` retém para sempre. Saiba o que está fazendo.

Expirado o prazo, a linha degrada para metadados: os KPIs de volume e latência
continuam funcionando, o texto some. A varredura roda a cada `RETENTION_SWEEP_MS`
(padrão 10 min).

Conteúdo de mensagem de WhatsApp é dado pessoal. Se você opera no Brasil, o prazo
que você configura aqui é parte do que precisa estar no seu registro de
tratamento.

## Escolher a engine em produção

Para carga comercial séria, `cloud_api`. É oficial, não tem risco de bloqueio, e
custa por conversa.

`baileys` é a escolha de quem aceita o risco em troca de custo zero — e, se for o
caso, use número dedicado. Nunca o pessoal, nunca o número crítico da empresa. O
motor de risco reduz a probabilidade de bloqueio; ele não garante nada, e nenhuma
configuração dele torna a engine não oficial compatível com os termos de uso da
plataforma.

A migração de uma para outra é uma linha, porque as duas estão atrás do mesmo
`EngineAdapter`. O que muda está em `GET /v1/engines`.
