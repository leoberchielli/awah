import { randomUUID } from 'node:crypto'
import { eq, schema } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../src/app'
import { loadEnv } from '../../src/env'
import { saveIntegration, typebotConfigSchema } from '../../src/integrations/config'
import { IntegrationDispatcher } from '../../src/integrations/dispatcher'
import { findLink } from '../../src/integrations/links'
import { TypebotClient } from '../../src/integrations/typebot/client'
import { type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

const CHAT_ID = '5511977776666@s.whatsapp.net'

describe.skipIf(!hasInfra)('fluxo do Typebot', () => {
  let app: FastifyInstance
  let org: SeededOrg
  let sessionId: string
  let integrationId: string
  let encryptionKey: Buffer

  let paths: string[]

  /** A flow that always answers and always waits for the next message. */
  function fetchDoTypebot(response?: unknown): typeof fetch {
    return vi.fn(async (url: string | URL) => {
      paths.push(String(url))

      return new Response(
        JSON.stringify(
          response ?? {
            sessionId: 'sess-do-fluxo',
            input: { type: 'text input' },
            messages: [
              {
                type: 'text',
                content: { richText: [{ children: [{ text: 'Oi! Sou o robô.' }] }] },
              },
            ],
          },
        ),
        { status: 200 },
      )
    }) as unknown as typeof fetch
  }

  function dispatcher(fetchImpl = fetchDoTypebot()): IntegrationDispatcher {
    return new IntegrationDispatcher({
      db: app.db,
      encryptionKey,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      maxAttempts: 5,
      typebotFactory: (config) => new TypebotClient(config, { fetch: fetchImpl }),
    })
  }

  async function receive(body: string, fetchImpl?: typeof fetch) {
    const engineMessageId = `wamid.${randomUUID()}`
    await dispatcher(fetchImpl).onReceive({
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
      .values({ orgId: org.orgId, name: `fluxo-${randomUUID().slice(0, 8)}`, engine: 'baileys' })
      .returning({ id: schema.sessions.id })
    if (!row) throw new Error('falha ao criar sessão')
    sessionId = row.id

    const integration = await saveIntegration(app.db, encryptionKey, {
      orgId: org.orgId,
      sessionId,
      kind: 'typebot',
      config: typebotConfigSchema.parse({
        baseUrl: 'https://typebot.exemplo.com',
        typebotId: 'meu-fluxo',
      }),
    })
    integrationId = integration.id
  })

  beforeEach(() => {
    paths = []
  })

  afterAll(async () => {
    await org?.cleanup()
    await app?.close()
  })

  it('inicia o fluxo na primeira mensagem e continua na segunda', async () => {
    await receive('oi')
    expect(paths[0]).toContain('/startChat')

    const link = await findLink(app.db, integrationId, CHAT_ID)
    expect(link?.externalConversationId).toBe('sess-do-fluxo')

    paths = []
    await receive('quero saber o preço')

    /**
     * Restarting the flow on every message would erase everything the customer
     * had already answered — they would be stuck on the first question forever.
     */
    expect(paths[0]).toContain('/sessions/sess-do-fluxo/continueChat')
  })

  it('a resposta do fluxo entra pela mesma fila de qualquer envio', async () => {
    const id = await receive('oi de novo')

    const queued = (await queue()).find((l) => l.clientMessageId.includes(id))
    expect((queued?.payload as { text?: string })?.text).toBe('Oi! Sou o robô.')
  })

  /**
   * This is what makes the arrangement better than wiring Typebot straight into
   * Meta: the flow's reply inherits per-chat ordering, the risk engine and
   * redelivery.
   */
  it('processar o mesmo event duas vezes não duplica a resposta', async () => {
    const engineMessageId = `wamid.${randomUUID()}`
    const event = {
      orgId: org.orgId,
      sessionId,
      chatId: CHAT_ID,
      engineMessageId,
      body: 'mensagem repetida',
      fromJid: CHAT_ID,
      occurredAt: new Date(),
    }

    await dispatcher().onReceive(event)
    await dispatcher().onReceive(event)

    const duplicates = (await queue()).filter((l) => l.clientMessageId.includes(engineMessageId))
    expect(duplicates).toHaveLength(1)
  })

  describe('escape para atendimento humano', () => {
    it('encerra a sessão de fluxo sem chamar o Typebot', async () => {
      await receive('oi')
      paths = []

      await receive('agent')

      // Sending it on to the flow would produce one more automated reply for
      // the very person who asked to stop getting them.
      expect(paths).toHaveLength(0)
      expect(await findLink(app.db, integrationId, CHAT_ID)).toBeNull()
    })

    it('reconhece a palavra em qualquer caixa e avisa o cliente', async () => {
      const id = await receive('AGENT')

      const warning = (await queue()).find((l) => l.clientMessageId.includes(id))
      expect((warning?.payload as { text?: string })?.text).toMatch(/team/i)
    })
  })

  it('fluxo encerrado deixa a próxima mensagem recomeçar do zero', async () => {
    const finishedFlow = fetchDoTypebot({
      sessionId: 'sess-terminada',
      messages: [{ type: 'text', content: { richText: [{ children: [{ text: 'Até mais!' }] }] } }],
    })

    await receive('quero encerrar', finishedFlow)

    /**
     * With no `input`, Typebot has said the flow is over. The link is born
     * expired so the next message starts a fresh flow, instead of trying to
     * continue a session that no longer exists.
     */
    expect(await findLink(app.db, integrationId, CHAT_ID)).toBeNull()
  })

  it('sessão morta do outro lado recomeça em vez de calar o contato', async () => {
    await receive('oi')

    let call = 0
    const expiringFetch = vi.fn(async (url: string | URL) => {
      paths.push(String(url))
      call++

      // continueChat answers 404: the session died over in Typebot.
      if (call === 1) {
        return new Response(JSON.stringify({ message: 'session not found' }), { status: 404 })
      }

      return new Response(
        JSON.stringify({
          sessionId: 'sess-nova',
          input: { type: 'text input' },
          messages: [
            { type: 'text', content: { richText: [{ children: [{ text: 'Recomeçando' }] }] } },
          ],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    paths = []
    const id = await receive('e agora?', expiringFetch)

    expect(paths[0]).toContain('/continueChat')
    expect(paths[1]).toContain('/startChat')

    const response = (await queue()).find((l) => l.clientMessageId.includes(id))
    expect((response?.payload as { text?: string })?.text).toBe('Recomeçando')
  })
})
