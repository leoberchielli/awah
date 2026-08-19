import { createHmac, randomUUID } from 'node:crypto'
import { and, eq, schema } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { saveCloudApiCredentials } from '../../src/engines/cloud-api/credentials'
import { loadEnv } from '../../src/env'
import { type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

const APP_SECRET = 'segredo-do-app-da-meta'
const VERIFY_TOKEN = 'token-de-verificacao'

/**
 * O webhook da Meta é o único endpoint público do sistema: quem chama é a
 * infraestrutura deles, sem chave de API. Toda a defesa está na assinatura, e é
 * exatamente isso que estes testes exercitam.
 */
describe.skipIf(!hasInfra)('webhook da Cloud API', () => {
  let app: FastifyInstance
  let org: SeededOrg
  let sessionId: string

  function assinar(corpo: string): string {
    return `sha256=${createHmac('sha256', APP_SECRET).update(corpo).digest('hex')}`
  }

  async function enviar(corpo: unknown, assinatura?: string) {
    const payload = JSON.stringify(corpo)
    return app.inject({
      method: 'POST',
      url: `/webhooks/meta/${sessionId}`,
      headers: {
        'content-type': 'application/json',
        ...(assinatura ? { 'x-hub-signature-256': assinatura } : {}),
      },
      payload,
    })
  }

  beforeAll(async () => {
    app = await buildApp(loadEnv())
    await app.ready()
    org = await seedOrg(app.db)

    const [row] = await app.db
      .insert(schema.sessions)
      .values({ orgId: org.orgId, name: `meta-${randomUUID().slice(0, 8)}`, engine: 'cloud_api' })
      .returning({ id: schema.sessions.id })
    if (!row) throw new Error('falha ao criar sessão de teste')
    sessionId = row.id

    await saveCloudApiCredentials(
      app.db,
      sessionId,
      Buffer.from(app.env.ENCRYPTION_KEY, 'base64'),
      {
        phoneNumberId: '109876543210987',
        accessToken: 'EAAG'.padEnd(48, 'x'),
        verifyToken: VERIFY_TOKEN,
        appSecret: APP_SECRET,
        graphVersion: 'v21.0',
      },
    )
  })

  afterAll(async () => {
    await org?.cleanup()
    await app?.close()
  })

  describe('handshake de verificação', () => {
    it('devolve o desafio quando o token confere', async () => {
      const resposta = await app.inject({
        method: 'GET',
        url: `/webhooks/meta/${sessionId}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1234567890`,
      })

      expect(resposta.statusCode).toBe(200)
      expect(resposta.body).toBe('1234567890')
    })

    /** Sem isto, qualquer um apontaria o webhook de outra conta para cá. */
    it('recusa token de verificação errado', async () => {
      const resposta = await app.inject({
        method: 'GET',
        url: `/webhooks/meta/${sessionId}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1234`,
      })

      expect(resposta.statusCode).toBe(403)
    })

    it('não confirma a existência de sessão desconhecida', async () => {
      const resposta = await app.inject({
        method: 'GET',
        url: `/webhooks/meta/${randomUUID()}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
      })

      expect(resposta.statusCode).toBe(404)
    })
  })

  describe('recebimento de eventos', () => {
    it('recusa evento sem assinatura', async () => {
      const resposta = await enviar({ entry: [] })
      expect(resposta.statusCode).toBe(403)
    })

    it('recusa assinatura de outro segredo', async () => {
      const corpo = { entry: [] }
      const forjada = `sha256=${createHmac('sha256', 'outro-segredo').update(JSON.stringify(corpo)).digest('hex')}`

      const resposta = await enviar(corpo, forjada)
      expect(resposta.statusCode).toBe(403)
    })

    it('persiste a mensagem recebida e responde 200', async () => {
      const messageId = `wamid.${randomUUID()}`
      const corpo = {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: messageId,
                      from: '5511988887777',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: 'olá pela oficial' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }

      const resposta = await enviar(corpo, assinar(JSON.stringify(corpo)))
      expect(resposta.statusCode).toBe(200)

      // O processamento é assíncrono de propósito: a Meta não espera por ele.
      const gravada = await aguardar(async () => {
        const [linha] = await app.db
          .select({ body: schema.messages.body, direction: schema.messages.direction })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.sessionId, sessionId),
              eq(schema.messages.engineMessageId, messageId),
            ),
          )
          .limit(1)
        return linha ?? null
      })

      expect(gravada?.body).toBe('olá pela oficial')
      expect(gravada?.direction).toBe('inbound')
    })

    /**
     * A assinatura cobre os bytes exatos que a Meta enviou. Reserializar o JSON
     * produziria bytes parecidos, não idênticos — e o HMAC falharia de forma
     * intermitente. Este corpo tem espaçamento fora do padrão justamente para
     * provar que é o buffer cru que está sendo conferido.
     */
    it('confere a assinatura sobre os bytes crus, não sobre o JSON reserializado', async () => {
      const cru = '{ "entry" :  [ ] }'

      const resposta = await app.inject({
        method: 'POST',
        url: `/webhooks/meta/${sessionId}`,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': assinar(cru),
        },
        payload: cru,
      })

      expect(resposta.statusCode).toBe(200)
    })
  })
})

/** Espera uma condição assíncrona sem prender o teste em sleep fixo. */
async function aguardar<T>(consulta: () => Promise<T | null>, tentativas = 40): Promise<T | null> {
  for (let i = 0; i < tentativas; i++) {
    const resultado = await consulta()
    if (resultado) return resultado
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}
