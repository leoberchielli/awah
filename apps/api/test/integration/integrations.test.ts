import { randomUUID } from 'node:crypto'
import { and, eq, schema } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/app'
import { loadEnv } from '../../src/env'
import { ChatwootClient } from '../../src/integrations/chatwoot/client'
import { chatwootConfigSchema, saveIntegration } from '../../src/integrations/config'
import { IntegrationDispatcher } from '../../src/integrations/dispatcher'
import { findLink } from '../../src/integrations/links'
import { type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

const CHAT_ID = '5511988887777@s.whatsapp.net'
const TOKEN = 'w'.repeat(32)

describe.skipIf(!hasInfra)('integrações com ferramentas externas', () => {
  let app: FastifyInstance
  let org: SeededOrg
  let sessionId: string
  let integrationId: string
  let encryptionKey: Buffer

  /** Registra tudo que o conector tentou falar com o Chatwoot. */
  let chamadas: Array<{ url: string; method: string; body: unknown }>

  function fetchDoChatwoot(): typeof fetch {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const endereco = String(url)
      chamadas.push({
        url: endereco,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })

      if (endereco.includes('/contacts/search')) {
        return new Response(
          JSON.stringify({
            payload: [{ id: 42, contact_inboxes: [{ source_id: 'src-42', inbox: { id: 7 } }] }],
          }),
          { status: 200 },
        )
      }

      if (endereco.endsWith('/conversations')) {
        return new Response(JSON.stringify({ id: 555 }), { status: 200 })
      }

      return new Response(JSON.stringify({ id: 999 }), { status: 200 })
    }) as unknown as typeof fetch
  }

  function dispatcher(fetchImpl = fetchDoChatwoot()): IntegrationDispatcher {
    return new IntegrationDispatcher({
      db: app.db,
      encryptionKey,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      maxAttempts: 5,
      chatwootFactory: (config) => new ChatwootClient(config, { fetch: fetchImpl }),
    })
  }

  async function receber(body: string, engineMessageId = `wamid.${randomUUID()}`) {
    await dispatcher().aoReceber({
      orgId: org.orgId,
      sessionId,
      chatId: CHAT_ID,
      engineMessageId,
      body,
      fromJid: CHAT_ID,
      occurredAt: new Date(),
    })
    return engineMessageId
  }

  async function fila() {
    return app.db
      .select({
        chatId: schema.outboxMessages.chatId,
        clientMessageId: schema.outboxMessages.clientMessageId,
        payload: schema.outboxMessages.payload,
      })
      .from(schema.outboxMessages)
      .where(eq(schema.outboxMessages.sessionId, sessionId))
  }

  beforeAll(async () => {
    app = await buildApp(loadEnv())
    await app.ready()
    encryptionKey = Buffer.from(app.env.ENCRYPTION_KEY, 'base64')
    org = await seedOrg(app.db)

    const [linha] = await app.db
      .insert(schema.sessions)
      .values({ orgId: org.orgId, name: `integra-${randomUUID().slice(0, 8)}`, engine: 'baileys' })
      .returning({ id: schema.sessions.id })
    if (!linha) throw new Error('falha ao criar sessão')
    sessionId = linha.id

    const integracao = await saveIntegration(app.db, encryptionKey, {
      orgId: org.orgId,
      sessionId,
      kind: 'chatwoot',
      config: chatwootConfigSchema.parse({
        baseUrl: 'https://chat.exemplo.com',
        accountId: 1,
        inboxId: 7,
        apiAccessToken: 'token-de-acesso-do-agente',
        webhookToken: TOKEN,
      }),
    })
    integrationId = integracao.id
  })

  beforeEach(() => {
    chamadas = []
  })

  afterAll(async () => {
    await org?.cleanup()
    await app?.close()
  })

  describe('do WhatsApp para o Chatwoot', () => {
    it('abre a conversa uma vez e reaproveita nas seguintes', async () => {
      await receber('primeira mensagem')

      const vinculo = await findLink(app.db, integrationId, CHAT_ID)
      expect(vinculo?.externalConversationId).toBe('555')
      expect(vinculo?.externalContactId).toBe('42')

      const criouConversa = chamadas.filter((c) => c.url.endsWith('/conversations')).length
      expect(criouConversa).toBe(1)

      chamadas = []
      await receber('segunda mensagem')

      /**
       * Reabrir conversa a cada mensagem criaria uma thread nova no Chatwoot por
       * mensagem recebida — o operador veria a mesma conversa picada em dezenas
       * de pedaços.
       */
      expect(chamadas.filter((c) => c.url.endsWith('/conversations'))).toHaveLength(0)
      expect(chamadas.some((c) => c.url.includes('/messages'))).toBe(true)
    })

    it('leva o id do WhatsApp como source_id', async () => {
      const id = await receber('com rastro')

      const mensagem = chamadas.find((c) => c.url.includes('/messages'))
      expect((mensagem?.body as { source_id?: string })?.source_id).toBe(id)
      expect((mensagem?.body as { message_type?: string })?.message_type).toBe('incoming')
    })

    it('ignora mensagem sem texto', async () => {
      await receber('')
      expect(chamadas).toHaveLength(0)
    })

    /**
     * Chatwoot fora do ar não pode derrubar o tratamento do evento — no limite,
     * derrubaria a conexão do WhatsApp por causa de uma ferramenta de terceiro.
     */
    it('engole a falha e registra o erro na integração', async () => {
      const quebrado = vi.fn(
        async () => new Response(JSON.stringify({ message: 'fora do ar' }), { status: 503 }),
      ) as unknown as typeof fetch

      await expect(
        dispatcher(quebrado).aoReceber({
          orgId: org.orgId,
          sessionId,
          chatId: `5511900000000@s.whatsapp.net`,
          engineMessageId: `wamid.${randomUUID()}`,
          body: 'vai falhar',
          fromJid: null,
          occurredAt: new Date(),
        }),
      ).resolves.toBeUndefined()

      const [linha] = await app.db
        .select({ lastError: schema.integrations.lastError })
        .from(schema.integrations)
        .where(eq(schema.integrations.id, integrationId))
        .limit(1)

      expect(linha?.lastError).toMatch(/503/)
    })
  })

  describe('do Chatwoot para o WhatsApp', () => {
    const webhook = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: `/webhooks/chatwoot/${integrationId}/${TOKEN}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      })

    const respostaDeAgente = (id: number, content = 'resposta do agente') => ({
      event: 'message_created',
      id,
      content,
      message_type: 'outgoing',
      private: false,
      account: { id: 1 },
      inbox: { id: 7 },
      conversation: { id: 555 },
    })

    beforeAll(async () => {
      // Garante que o vínculo da conversa 555 existe antes desta bateria.
      await receber('abre a conversa')
    })

    it('recusa token errado', async () => {
      const resposta = await app.inject({
        method: 'POST',
        url: `/webhooks/chatwoot/${integrationId}/${'x'.repeat(32)}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(respostaDeAgente(1)),
      })

      expect(resposta.statusCode).toBe(403)
    })

    it('recusa evento de outra conta do Chatwoot', async () => {
      const resposta = await webhook({ ...respostaDeAgente(2), account: { id: 99 } })
      expect(resposta.statusCode).toBe(403)
    })

    it('enfileira a resposta do agente', async () => {
      const antes = (await fila()).length
      expect((await webhook(respostaDeAgente(1001))).statusCode).toBe(200)

      const depois = await aguardar(async () => {
        const linhas = await fila()
        return linhas.length > antes ? linhas : null
      })

      const nova = depois?.find((l) => l.clientMessageId === 'chatwoot:1001')
      expect(nova?.chatId).toBe(CHAT_ID)
      expect((nova?.payload as { text?: string })?.text).toBe('resposta do agente')
    })

    /**
     * O bug que este teste impede: o Chatwoot reentrega quando não recebe 200 a
     * tempo, e sem chave de idempotência o cliente recebe a mesma resposta duas
     * vezes.
     */
    it('reentrega do mesmo evento não duplica a mensagem', async () => {
      await webhook(respostaDeAgente(2002))
      await webhook(respostaDeAgente(2002))
      await webhook(respostaDeAgente(2002))

      const iguais = await aguardar(async () => {
        const linhas = (await fila()).filter((l) => l.clientMessageId === 'chatwoot:2002')
        return linhas.length > 0 ? linhas : null
      })

      expect(iguais).toHaveLength(1)
    })

    /**
     * O laço de eco: mensagem que nasceu no WhatsApp, foi criada por nós no
     * Chatwoot, e voltaria para o WhatsApp de novo. O `source_id` é o que corta.
     */
    it('não devolve ao WhatsApp a mensagem que veio de lá', async () => {
      const antes = (await fila()).length

      await webhook({
        ...respostaDeAgente(3003),
        message_type: 'incoming',
        source_id: 'wamid.QUEVEIODOWHATSAPP',
      })
      await webhook({ ...respostaDeAgente(3004), source_id: 'wamid.OUTRA' })

      await new Promise((r) => setTimeout(r, 400))
      expect((await fila()).length).toBe(antes)
    })

    it('não manda nota interna para o cliente', async () => {
      const antes = (await fila()).length
      await webhook({ ...respostaDeAgente(4004), private: true })

      await new Promise((r) => setTimeout(r, 400))
      expect((await fila()).length).toBe(antes)
    })

    it('ignora evento que não é criação de mensagem', async () => {
      const antes = (await fila()).length
      await webhook({ ...respostaDeAgente(5005), event: 'conversation_status_changed' })

      await new Promise((r) => setTimeout(r, 400))
      expect((await fila()).length).toBe(antes)
    })

    it('ignora resposta vazia', async () => {
      const antes = (await fila()).length
      await webhook(respostaDeAgente(6006, '   '))

      await new Promise((r) => setTimeout(r, 400))
      expect((await fila()).length).toBe(antes)
    })
  })

  describe('isolamento entre organizações', () => {
    it('não lista integração de outra org', async () => {
      const outra = await seedOrg(app.db)

      try {
        const resposta = await app.inject({
          method: 'GET',
          url: '/v1/integrations',
          headers: { authorization: `Bearer ${outra.token}` },
        })

        expect(resposta.statusCode).toBe(200)
        expect(resposta.json().integrations).toHaveLength(0)
      } finally {
        await outra.cleanup()
      }
    })

    it('não devolve as credenciais em leitura', async () => {
      const resposta = await app.inject({
        method: 'GET',
        url: '/v1/integrations',
        headers: { authorization: `Bearer ${org.token}` },
      })

      expect(resposta.body).not.toContain('token-de-acesso-do-agente')
      expect(resposta.body).not.toContain(TOKEN)
    })
  })

  it('uma integração de cada tipo por sessão', async () => {
    const config = chatwootConfigSchema.parse({
      baseUrl: 'https://outro.exemplo.com',
      accountId: 2,
      inboxId: 9,
      apiAccessToken: 'outro-token-de-acesso',
      webhookToken: 'z'.repeat(32),
    })

    // O segundo PUT substitui em vez de duplicar: duas do mesmo tipo na mesma
    // sessão fariam o operador ver a conversa em dobro.
    await saveIntegration(app.db, encryptionKey, {
      orgId: org.orgId,
      sessionId,
      kind: 'chatwoot',
      config,
    })

    const linhas = await app.db
      .select({ id: schema.integrations.id })
      .from(schema.integrations)
      .where(
        and(eq(schema.integrations.sessionId, sessionId), eq(schema.integrations.kind, 'chatwoot')),
      )

    expect(linhas).toHaveLength(1)
    expect(linhas[0]?.id).toBe(integrationId)
  })
})

async function aguardar<T>(consulta: () => Promise<T | null>, tentativas = 40): Promise<T | null> {
  for (let i = 0; i < tentativas; i++) {
    const resultado = await consulta()
    if (resultado) return resultado
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}
