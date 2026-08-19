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

  let caminhos: string[]

  /** Um fluxo que sempre responde e sempre espera a próxima mensagem. */
  function fetchDoTypebot(resposta?: unknown): typeof fetch {
    return vi.fn(async (url: string | URL) => {
      caminhos.push(String(url))

      return new Response(
        JSON.stringify(
          resposta ?? {
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

  async function receber(body: string, fetchImpl?: typeof fetch) {
    const engineMessageId = `wamid.${randomUUID()}`
    await dispatcher(fetchImpl).aoReceber({
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
      .values({ orgId: org.orgId, name: `fluxo-${randomUUID().slice(0, 8)}`, engine: 'baileys' })
      .returning({ id: schema.sessions.id })
    if (!linha) throw new Error('falha ao criar sessão')
    sessionId = linha.id

    const integracao = await saveIntegration(app.db, encryptionKey, {
      orgId: org.orgId,
      sessionId,
      kind: 'typebot',
      config: typebotConfigSchema.parse({
        baseUrl: 'https://typebot.exemplo.com',
        typebotId: 'meu-fluxo',
      }),
    })
    integrationId = integracao.id
  })

  beforeEach(() => {
    caminhos = []
  })

  afterAll(async () => {
    await org?.cleanup()
    await app?.close()
  })

  it('inicia o fluxo na primeira mensagem e continua na segunda', async () => {
    await receber('oi')
    expect(caminhos[0]).toContain('/startChat')

    const vinculo = await findLink(app.db, integrationId, CHAT_ID)
    expect(vinculo?.externalConversationId).toBe('sess-do-fluxo')

    caminhos = []
    await receber('quero saber o preço')

    /**
     * Recomeçar o fluxo a cada mensagem apagaria tudo que o cliente já
     * respondeu — ele ficaria preso na primeira pergunta para sempre.
     */
    expect(caminhos[0]).toContain('/sessions/sess-do-fluxo/continueChat')
  })

  it('a resposta do fluxo entra pela mesma fila de qualquer envio', async () => {
    const id = await receber('oi de novo')

    const enfileirada = (await fila()).find((l) => l.clientMessageId.includes(id))
    expect((enfileirada?.payload as { text?: string })?.text).toBe('Oi! Sou o robô.')
  })

  /**
   * É o que torna este arranjo melhor que ligar o Typebot direto na Meta: a
   * resposta do fluxo herda ordem por conversa, motor de risco e reentrega.
   */
  it('processar o mesmo evento duas vezes não duplica a resposta', async () => {
    const engineMessageId = `wamid.${randomUUID()}`
    const evento = {
      orgId: org.orgId,
      sessionId,
      chatId: CHAT_ID,
      engineMessageId,
      body: 'mensagem repetida',
      fromJid: CHAT_ID,
      occurredAt: new Date(),
    }

    await dispatcher().aoReceber(evento)
    await dispatcher().aoReceber(evento)

    const iguais = (await fila()).filter((l) => l.clientMessageId.includes(engineMessageId))
    expect(iguais).toHaveLength(1)
  })

  describe('escape para atendimento humano', () => {
    it('encerra a sessão de fluxo sem chamar o Typebot', async () => {
      await receber('oi')
      caminhos = []

      await receber('atendente')

      // Mandar ao fluxo produziria mais uma resposta automática justamente para
      // quem pediu para parar de recebê-las.
      expect(caminhos).toHaveLength(0)
      expect(await findLink(app.db, integrationId, CHAT_ID)).toBeNull()
    })

    it('reconhece a palavra em qualquer caixa e avisa o cliente', async () => {
      const id = await receber('ATENDENTE')

      const aviso = (await fila()).find((l) => l.clientMessageId.includes(id))
      expect((aviso?.payload as { text?: string })?.text).toMatch(/equipe/i)
    })
  })

  it('fluxo encerrado deixa a próxima mensagem recomeçar do zero', async () => {
    const encerrado = fetchDoTypebot({
      sessionId: 'sess-terminada',
      messages: [{ type: 'text', content: { richText: [{ children: [{ text: 'Até mais!' }] }] } }],
    })

    await receber('quero encerrar', encerrado)

    /**
     * Sem `input`, o Typebot informou que o fluxo acabou. O vínculo já nasce
     * vencido para que a mensagem seguinte comece um fluxo novo, em vez de
     * tentar continuar uma sessão que não existe mais.
     */
    expect(await findLink(app.db, integrationId, CHAT_ID)).toBeNull()
  })

  it('sessão morta do outro lado recomeça em vez de calar o contato', async () => {
    await receber('oi')

    let chamada = 0
    const expirando = vi.fn(async (url: string | URL) => {
      caminhos.push(String(url))
      chamada++

      // O continueChat responde 404: a sessão morreu no Typebot.
      if (chamada === 1) {
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

    caminhos = []
    const id = await receber('e agora?', expirando)

    expect(caminhos[0]).toContain('/continueChat')
    expect(caminhos[1]).toContain('/startChat')

    const resposta = (await fila()).find((l) => l.clientMessageId.includes(id))
    expect((resposta?.payload as { text?: string })?.text).toBe('Recomeçando')
  })
})
