# Política de segurança

*[English](SECURITY.md)*

## Reportar uma vulnerabilidade

**Não abra issue pública.** Use o
[relato privado de vulnerabilidade do GitHub](https://github.com/leoberchielli/awah/security/advisories/new)
— ele notifica o mantenedor direto e mantém a conversa fechada até haver
correção.

Inclua o que der: versão, passos para reproduzir, impacto que você enxerga.
Prova de conceito ajuda muito, mas relato sem PoC também é bem-vindo.

Resposta em até 72 horas. O projeto é mantido por uma pessoa em tempo parcial —
se a correção for demorar, você fica sabendo por que.

Crédito no changelog e no advisory, salvo se você preferir anonimato.

## Versões suportadas

O projeto ainda não teve release estável. Até o v1.0, só a `main` recebe
correção de segurança.

## O modelo de ameaça

O que o AWAH assume e o que ele não protege — ler isto evita relatar como falha
o que é decisão consciente.

### O que é protegido

- **Credenciais de sessão em repouso.** O auth state do Baileys e o token da
  Cloud API vivem cifrados em AES-256-GCM no Postgres. Acesso de leitura ao banco
  não revela nem um nem outro.
- **Segredos de chave de API.** Guardados só como SHA-256. O banco não permite
  reconstruir a chave.
- **Senhas.** argon2id com os parâmetros recomendados pela OWASP.
- **Isolamento entre organizações.** Todo acesso a dados passa por repositórios
  com escopo de tenant, que se recusam a consultar sem `orgId`.
- **Escopo de chave.** Uma chave com `sessionScope` responde **404**, não 403, a
  sessões fora do escopo — 403 confirmaria que a sessão existe.
- **Separação entre credenciais.** Chave de API nunca administra identidade: não
  cria outras chaves, não promove membros, não altera a organização. Quando uma
  chave vazar, o estrago deve ser "mandaram mensagem no meu nome", não tomada de
  conta.
- **Replay de webhook.** A assinatura cobre `timestamp.corpo`. Entrega capturada
  não pode ser reenviada depois da janela, e mudar o timestamp invalida a
  assinatura.
- **Falsificação de evento da Meta.** O callback é o único endpoint público, e o
  `appSecret` é obrigatório justamente por isso. A conferência é HMAC sobre os
  bytes crus.

### O que não é protegido

- **Acesso de escrita ao Postgres ou ao Redis.** Quem escreve no banco controla o
  gateway. Não há defesa contra isso, e não deveria haver — trate os dois como
  parte da superfície de confiança.
- **A chave de cifragem.** `ENCRYPTION_KEY` fica em variável de ambiente. Quem lê
  o ambiente do processo decifra as sessões. Se isso não for aceitável no seu
  cenário, o lugar de resolver é um KMS, e o projeto ainda não integra nenhum.
- **Bloqueio pelo WhatsApp.** O motor de risco reduz a probabilidade. Ele não
  garante nada, e nenhuma configuração dele torna a engine não oficial segura sob
  os termos de uso da plataforma.
- **Conteúdo das mensagens em trânsito para o seu webhook.** É HTTPS até o seu
  endpoint; a partir dali é com você.
- **Negação de serviço distribuída.** Há rate limit por chave e por IP, e teto de
  corpo. Isso segura abuso comum, não um ataque coordenado — para isso, ponha um
  proxy ou CDN na frente.

## Antes de expor uma instância

Lista mínima. As três primeiras o processo cobra sozinho; as outras não.

1. **Gere os seus segredos.** Em `NODE_ENV=production` a API se recusa a subir
   com os valores de desenvolvimento deste repositório — eles estão no
   `docker-compose.yml` e no `.env.example`, e quem os lê forja um cookie de
   sessão e decifra as sessões.

   ```bash
   openssl rand -base64 32   # ENCRYPTION_KEY
   openssl rand -base64 48   # COOKIE_SECRET
   ```

2. **Defina `METRICS_TOKEN`.** Sem ele, `/metrics` entrega volume de mensagens,
   número de sessões e saúde da operação a quem alcançar a porta. A API avisa no
   boot quando ele falta.

3. **Configure `TRUST_PROXY` conforme a sua topologia.** O padrão é `false`.
   Ligar sem proxy na frente deixa qualquer cliente escolher o próprio IP por
   `X-Forwarded-For` e escapar do rate limit. Atrás de proxy, prefira a lista de
   CIDRs à confiança irrestrita.

4. **Use `NODE_ENV=production`.** É o que liga a flag `secure` do cookie de
   sessão. Fora de produção o cookie viaja sem ela.

5. **Termine o TLS antes da API.** O AWAH fala HTTP; quem fala HTTPS é o proxy
   ou o balanceador na frente dele.

6. **Não exponha Postgres nem Redis.** No `docker-compose.yml` deste repositório
   as duas portas ficam publicadas para facilitar desenvolvimento. Em produção,
   tire.

7. **Feche o registro.** `POST /v1/auth/register` já fecha sozinho quando existe
   uma organização, mas confira que ela existe antes de abrir a porta.

## Divulgação

Correções de segurança saem em release própria, com advisory publicado. Se a
falha permitir exploração remota sem autenticação, o advisory vem antes dos
detalhes técnicos.
