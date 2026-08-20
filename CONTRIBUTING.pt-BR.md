# Contribuindo

*[English](CONTRIBUTING.md)*

O projeto está em construção ativa rumo ao v1.0. As decisões de arquitetura ainda
estão maleáveis, e é justamente por isso que **issue com relato de caso de uso
real vale mais que PR** nesta fase.

## O que ajuda mais agora

- **Como você usa um gateway de WhatsApp hoje**, e o que quebra. Especialmente
  se você já perdeu um número: quantos disparos, em quanto tempo, com que
  intervalo. Esse é o dado que falta para calibrar o motor de risco.
- **Códigos de desconexão que você viu e o AWAH não traduz.** A tabela em
  `apps/api/src/engines/disconnect.ts` foi montada de observação, não de
  especificação — ela tem buracos.
- **Bug com passo a passo.** Log com `LOG_LEVEL=debug` e, se for pareamento,
  `ENGINE_LOG_LEVEL=debug`.

## Subir o ambiente

```bash
pnpm install
```

```bash
docker compose up -d postgres redis
```

Para rodar a pilha inteira a partir do seu código, e não da imagem publicada:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

```bash
cp .env.example .env
```

Gere os dois segredos e coloque no `.env`:

```bash
openssl rand -base64 32
```

```bash
openssl rand -base64 48
```

```bash
pnpm db:migrate && pnpm dev
```

O painel em desenvolvimento roda separado, com proxy para a API:

```bash
pnpm dev:web
```

## Antes de abrir o PR

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Os testes de integração precisam de Postgres e Redis no ar. Sem eles, os
arquivos de integração se pulam sozinhos e o resto roda — o que é útil localmente
e insuficiente para um PR.

## Padrões do código

**Nomes e comentários em português.** É a língua do projeto. Nomes de campo da
API e de tabela ficam em inglês, porque são contrato público e o público não é
só brasileiro.

**Comentário explica por quê, não o quê.** O código já diz o que faz. O que se
perde com o tempo é o motivo: qual bug isso evita, qual alternativa foi descartada
e por quê. Comentário que parafraseia a linha seguinte é ruído.

```ts
// Ruim: incrementa a tentativa
attempts++

// Bom: sessão em pareamento tem socket aberto mas nenhuma identidade, e o envio
// falha com um erro cru do Baileys. Consumir tentativa aqui gastaria as cinco
// antes de o usuário terminar de escanear o QR.
if (!adapter.isReady()) return release(id)
```

**Migration junto da mudança de schema.** O CI roda `pnpm db:generate` e falha se
o diff não estiver limpo.

**Teste que prova o comportamento, não a implementação.** O melhor teste deste
repositório é o que descreve o bug que ele impede de voltar. Vários deles têm um
comentário dizendo exatamente qual é.

**Nada de dependência nova sem motivo forte.** Leveza é uma das quatro apostas do
projeto. O SDK tem zero dependências e o painel tem quatro — cada uma delas foi
uma decisão, não um `npm install` distraído.

## Escopo

O que **não** entra:

- Automação de spam, disparo em massa sem opt-in, ou qualquer coisa cujo caso de
  uso principal seja mandar mensagem para quem não pediu. O motor de risco existe
  para o contrário disso.
- Bypass de detecção do WhatsApp além do que já existe (jitter, warmup, presença).
  A linha é "parecer humano porque o uso é humano", não "esconder que não é".
- Engine nova sem estar atrás do `EngineAdapter`. O contrato é o que permite
  trocar de engine sem reescrever integração.

## Licença

Contribuições entram sob MIT, a mesma do projeto.
