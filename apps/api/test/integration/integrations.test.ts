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

  /** Records everything the connector tried to say to Chatwoot. */
  let calls: Array<{ url: string; method: string; body: unknown }>

  function chatwootFetch(): typeof fetch {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const address = String(url)
      calls.push({
        url: address,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })

      if (address.includes('/contacts/search')) {
        return new Response(
          JSON.stringify({
            payload: [{ id: 42, contact_inboxes: [{ source_id: 'src-42', inbox: { id: 7 } }] }],
          }),
          { status: 200 },
        )
      }

      if (address.endsWith('/conversations')) {
        return new Response(JSON.stringify({ id: 555 }), { status: 200 })
      }

      return new Response(JSON.stringify({ id: 999 }), { status: 200 })
    }) as unknown as typeof fetch
  }

  function dispatcher(fetchImpl = chatwootFetch()): IntegrationDispatcher {
    return new IntegrationDispatcher({
      db: app.db,
      encryptionKey,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      maxAttempts: 5,
      chatwootFactory: (config) => new ChatwootClient(config, { fetch: fetchImpl }),
    })
  }

  async function receive(body: string, engineMessageId = `wamid.${randomUUID()}`) {
    await dispatcher().onReceive({
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

  async function queue() {
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

    const [row] = await app.db
      .insert(schema.sessions)
      .values({ orgId: org.orgId, name: `integra-${randomUUID().slice(0, 8)}`, engine: 'baileys' })
      .returning({ id: schema.sessions.id })
    if (!row) throw new Error('falha ao criar sessão')
    sessionId = row.id

    const integration = await saveIntegration(app.db, encryptionKey, {
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
    integrationId = integration.id
  })

  beforeEach(() => {
    calls = []
  })

  afterAll(async () => {
    await org?.cleanup()
    await app?.close()
  })

  describe('do WhatsApp para o Chatwoot', () => {
    it('abre a conversa uma vez e reaproveita nas seguintes', async () => {
      await receive('primeira mensagem')

      const link = await findLink(app.db, integrationId, CHAT_ID)
      expect(link?.externalConversationId).toBe('555')
      expect(link?.externalContactId).toBe('42')

      const conversationsCreated = calls.filter((c) => c.url.endsWith('/conversations')).length
      expect(conversationsCreated).toBe(1)

      calls = []
      await receive('segunda mensagem')

      /**
       * Reopening the conversation on every message would create a new Chatwoot
       * thread per inbound message — the operator would see one conversation
       * chopped into dozens of pieces.
       */
      expect(calls.filter((c) => c.url.endsWith('/conversations'))).toHaveLength(0)
      expect(calls.some((c) => c.url.includes('/messages'))).toBe(true)
    })

    it('leva o id do WhatsApp como source_id', async () => {
      const id = await receive('com rastro')

      const message = calls.find((c) => c.url.includes('/messages'))
      expect((message?.body as { source_id?: string })?.source_id).toBe(id)
      expect((message?.body as { message_type?: string })?.message_type).toBe('incoming')
    })

    it('ignora mensagem sem texto', async () => {
      await receive('')
      expect(calls).toHaveLength(0)
    })

    /**
     * Chatwoot being down must not take the event handling with it — at the
     * limit, it would drop the WhatsApp connection over a third-party tool.
     */
    it('engole a falha e registra o erro na integração', async () => {
      const broken = vi.fn(
        async () => new Response(JSON.stringify({ message: 'fora do ar' }), { status: 503 }),
      ) as unknown as typeof fetch

      await expect(
        dispatcher(broken).onReceive({
          orgId: org.orgId,
          sessionId,
          chatId: `5511900000000@s.whatsapp.net`,
          engineMessageId: `wamid.${randomUUID()}`,
          body: 'vai falhar',
          fromJid: null,
          occurredAt: new Date(),
        }),
      ).resolves.toBeUndefined()

      const [row] = await app.db
        .select({ lastError: schema.integrations.lastError })
        .from(schema.integrations)
        .where(eq(schema.integrations.id, integrationId))
        .limit(1)

      expect(row?.lastError).toMatch(/503/)
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

    const agentReply = (id: number, content = 'resposta do agente') => ({
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
      // Makes sure the link for conversation 555 exists before this batch runs.
      await receive('abre a conversa')
    })

    it('recusa token errado', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/chatwoot/${integrationId}/${'x'.repeat(32)}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(agentReply(1)),
      })

      expect(response.statusCode).toBe(403)
    })

    it('recusa evento de outra conta do Chatwoot', async () => {
      const response = await webhook({ ...agentReply(2), account: { id: 99 } })
      expect(response.statusCode).toBe(403)
    })

    it('enfileira a resposta do agente', async () => {
      const before = (await queue()).length
      expect((await webhook(agentReply(1001))).statusCode).toBe(200)

      const after = await wait(async () => {
        const rows = await queue()
        return rows.length > before ? rows : null
      })

      const newRow = after?.find((l) => l.clientMessageId === 'chatwoot:1001')
      expect(newRow?.chatId).toBe(CHAT_ID)
      expect((newRow?.payload as { text?: string })?.text).toBe('resposta do agente')
    })

    /**
     * The bug this test prevents: Chatwoot redelivers when it does not get a
     * 200 in time, and with no idempotency key the customer gets the same reply
     * twice.
     */
    it('reentrega do mesmo evento não duplica a mensagem', async () => {
      await webhook(agentReply(2002))
      await webhook(agentReply(2002))
      await webhook(agentReply(2002))

      const duplicates = await wait(async () => {
        const rows = (await queue()).filter((l) => l.clientMessageId === 'chatwoot:2002')
        return rows.length > 0 ? rows : null
      })

      expect(duplicates).toHaveLength(1)
    })

    /**
     * The echo loop: a message born on WhatsApp, created by us in Chatwoot, and
     * about to go back out to WhatsApp again. `source_id` is what cuts it.
     */
    it('não devolve ao WhatsApp a mensagem que veio de lá', async () => {
      const before = (await queue()).length

      await webhook({
        ...agentReply(3003),
        message_type: 'incoming',
        source_id: 'wamid.QUEVEIODOWHATSAPP',
      })
      await webhook({ ...agentReply(3004), source_id: 'wamid.OUTRA' })

      await new Promise((r) => setTimeout(r, 400))
      expect((await queue()).length).toBe(before)
    })

    it('não manda nota interna para o cliente', async () => {
      const before = (await queue()).length
      await webhook({ ...agentReply(4004), private: true })

      await new Promise((r) => setTimeout(r, 400))
      expect((await queue()).length).toBe(before)
    })

    it('ignora evento que não é criação de mensagem', async () => {
      const before = (await queue()).length
      await webhook({ ...agentReply(5005), event: 'conversation_status_changed' })

      await new Promise((r) => setTimeout(r, 400))
      expect((await queue()).length).toBe(before)
    })

    it('ignora resposta vazia', async () => {
      const before = (await queue()).length
      await webhook(agentReply(6006, '   '))

      await new Promise((r) => setTimeout(r, 400))
      expect((await queue()).length).toBe(before)
    })
  })

  describe('isolamento entre organizações', () => {
    it('não lista integração de outra org', async () => {
      const other = await seedOrg(app.db)

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/integrations',
          headers: { authorization: `Bearer ${other.token}` },
        })

        expect(response.statusCode).toBe(200)
        expect(response.json().integrations).toHaveLength(0)
      } finally {
        await other.cleanup()
      }
    })

    it('não devolve as credenciais em leitura', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/integrations',
        headers: { authorization: `Bearer ${org.token}` },
      })

      expect(response.body).not.toContain('token-de-acesso-do-agente')
      expect(response.body).not.toContain(TOKEN)
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

    // The second PUT replaces instead of duplicating: two of the same kind on
    // the same session would show the operator every conversation twice.
    await saveIntegration(app.db, encryptionKey, {
      orgId: org.orgId,
      sessionId,
      kind: 'chatwoot',
      config,
    })

    const rows = await app.db
      .select({ id: schema.integrations.id })
      .from(schema.integrations)
      .where(
        and(eq(schema.integrations.sessionId, sessionId), eq(schema.integrations.kind, 'chatwoot')),
      )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(integrationId)
  })
})

async function wait<T>(query: () => Promise<T | null>, attempts = 40): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    const result = await query()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}
