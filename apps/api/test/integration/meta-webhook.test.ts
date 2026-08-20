import { createHmac, randomUUID } from 'node:crypto'
import { and, eq, schema } from '@awah/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { saveCloudApiCredentials } from '../../src/engines/cloud-api/credentials'
import { loadEnv } from '../../src/env'
import { type SeededOrg, seedOrg } from './helpers'

const hasInfra = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL)

const APP_SECRET = 'meta-app-secret'
const VERIFY_TOKEN = 'token-de-verificacao'

/**
 * Meta's webhook is the only public endpoint in the system: the caller is
 * their infrastructure, with no API key. The whole defence is the signature,
 * and that is exactly what these tests exercise.
 */
describe.skipIf(!hasInfra)('Cloud API webhook', () => {
  let app: FastifyInstance
  let org: SeededOrg
  let sessionId: string

  function sign(body: string): string {
    return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`
  }

  async function send(body: unknown, signature?: string) {
    const payload = JSON.stringify(body)
    return app.inject({
      method: 'POST',
      url: `/webhooks/meta/${sessionId}`,
      headers: {
        'content-type': 'application/json',
        ...(signature ? { 'x-hub-signature-256': signature } : {}),
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
    if (!row) throw new Error('failed to create the test session')
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

  describe('verification handshake', () => {
    it('returns the challenge when the token matches', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/webhooks/meta/${sessionId}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1234567890`,
      })

      expect(response.statusCode).toBe(200)
      expect(response.body).toBe('1234567890')
    })

    /** Without this, anyone could point another account's webhook at us. */
    it('refuses a wrong verify token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/webhooks/meta/${sessionId}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1234`,
      })

      expect(response.statusCode).toBe(403)
    })

    it('does not confirm that an unknown session exists', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/webhooks/meta/${randomUUID()}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`,
      })

      expect(response.statusCode).toBe(404)
    })
  })

  describe('event intake', () => {
    it('refuses an event with no signature', async () => {
      const response = await send({ entry: [] })
      expect(response.statusCode).toBe(403)
    })

    it('refuses a signature made with another secret', async () => {
      const body = { entry: [] }
      const forged = `sha256=${createHmac('sha256', 'other-secret').update(JSON.stringify(body)).digest('hex')}`

      const response = await send(body, forged)
      expect(response.statusCode).toBe(403)
    })

    it('persists the received message and answers 200', async () => {
      const messageId = `wamid.${randomUUID()}`
      const body = {
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
                      text: { body: 'hello via the official one' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }

      const response = await send(body, sign(JSON.stringify(body)))
      expect(response.statusCode).toBe(200)

      // Processing is asynchronous on purpose: Meta does not wait for it.
      const recorded = await wait(async () => {
        const [row] = await app.db
          .select({ body: schema.messages.body, direction: schema.messages.direction })
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.sessionId, sessionId),
              eq(schema.messages.engineMessageId, messageId),
            ),
          )
          .limit(1)
        return row ?? null
      })

      expect(recorded?.body).toBe('hello via the official one')
      expect(recorded?.direction).toBe('inbound')
    })

    /**
     * The signature covers the exact bytes Meta sent. Re-serializing the JSON
     * would produce similar bytes, not identical ones — and the HMAC would fail
     * intermittently. This body has odd spacing precisely to prove it is the
     * raw buffer being checked.
     */
    it('checks the signature over the raw bytes, not over re-serialized JSON', async () => {
      const raw = '{ "entry" :  [ ] }'

      const response = await app.inject({
        method: 'POST',
        url: `/webhooks/meta/${sessionId}`,
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sign(raw),
        },
        payload: raw,
      })

      expect(response.statusCode).toBe(200)
    })
  })
})

/** Waits for an async condition without pinning the test to a fixed sleep. */
async function wait<T>(query: () => Promise<T | null>, attempts = 40): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    const result = await query()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}
