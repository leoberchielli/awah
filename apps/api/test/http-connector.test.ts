import { describe, expect, it, vi } from 'vitest'
import { httpConfigSchema } from '../src/integrations/config'
import {
  extractReplies,
  HttpConnector,
  HttpConnectorError,
  TEST_EVENT,
} from '../src/integrations/http/connector'
import { verify } from '../src/webhooks/signature'

const CONFIG = httpConfigSchema.parse({ url: 'https://my-flow.example.com/awah' })

function response(body: string, status = 200): Response {
  return new Response(status === 204 ? null : body, { status })
}

function connector(body: string, status = 200, extra?: Partial<typeof CONFIG>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return response(body, status)
  })

  return {
    connector: new HttpConnector(httpConfigSchema.parse({ ...CONFIG, ...extra }), {
      fetch: fetchImpl as unknown as typeof fetch,
    }),
    calls: calls,
  }
}

describe('accepted response shapes', () => {
  /**
   * Being permissive here is an adoption decision: someone wiring up a flow in
   * n8n returns `{"reply": "..."}` without thinking, and rejecting that because
   * the docs asked for `replies` is rigour that only produces frustration.
   */
  it('accepts the shapes that show up in practice', () => {
    const shapes = [
      '{"reply":"hi"}',
      '{"replies":["hi"]}',
      '{"text":"hi"}',
      '{"message":"hi"}',
      '["hi"]',
      '"hi"',
    ]

    for (const shape of shapes) {
      expect(extractReplies(shape).replies, shape).toEqual(['hi'])
    }
  })

  it('preserves the order of several messages', () => {
    expect(extractReplies('{"replies":["one","two","three"]}').replies).toEqual([
      'one',
      'two',
      'three',
    ])
  })

  it('drops empty text between valid replies', () => {
    expect(extractReplies('{"replies":["one","   ","two"]}').replies).toEqual(['one', 'two'])
  })

  /** Not every event wants a reply: a flow that only logs arrivals returns empty. */
  it('an empty body is a valid reply, not an error', () => {
    expect(extractReplies('')).toEqual({ replies: [], diagnosis: null })
    expect(extractReplies('   ')).toEqual({ replies: [], diagnosis: null })
  })

  it('follows the configured path when the reply comes nested', () => {
    const body = '{"data":{"saida":{"reply":"achou"}}}'
    expect(extractReplies(body, 'data.saida').replies).toEqual(['achou'])
  })
})

describe('diagnostics for whoever has just plugged in', () => {
  /**
   * Silence is the worst possible outcome: the person sits staring at a dead
   * conversation with no clue what is wrong.
   */
  it('explains a response that is not JSON', () => {
    const { diagnosis } = extractReplies('<html>error</html>')
    expect(diagnosis).toMatch(/not JSON/i)
    expect(diagnosis).toMatch(/reply/)
  })

  it('lists the fields that came when none of them serve', () => {
    const { replies, diagnosis } = extractReplies('{"result":"ok","code":200}')

    expect(replies).toEqual([])
    expect(diagnosis).toMatch(/result, code/)
    expect(diagnosis).toMatch(/"reply"/)
  })

  it('warns when the configured path does not exist', () => {
    const { diagnosis } = extractReplies('{"data":{}}', 'data.saida')
    expect(diagnosis).toMatch(/data\.saida/)
  })
})

describe('sending', () => {
  it('posts the event in the shape of the message.received webhook', async () => {
    const { connector: c, calls } = connector('{"reply":"oi"}')
    await c.send(TEST_EVENT)

    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body.event).toBe('message.received')
    expect(body.data.chatId).toBe('5511999999999@s.whatsapp.net')
  })

  /**
   * Same signature as the webhooks, on purpose: anyone already validating an
   * AWAH webhook validates this with the same function, and the SDK serves both.
   */
  it('signs with the same scheme as the webhooks', async () => {
    const secret = 'http-connector-secret'
    const { connector: c, calls } = connector('{"reply":"oi"}', 200, { secret: secret })

    await c.send(TEST_EVENT)

    const headers = calls[0]?.init?.headers as Record<string, string>
    const payload = String(calls[0]?.init?.body)

    expect(
      verify({
        payload,
        secret: secret,
        signature: headers['x-awah-signature'] ?? '',
        timestamp: Number(headers['x-awah-timestamp']),
      }),
    ).toBe(true)
  })

  it('does not sign when there is no secret', async () => {
    const { connector: c, calls } = connector('{"reply":"oi"}')
    await c.send(TEST_EVENT)

    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-awah-signature']).toBeUndefined()
  })

  it("sends the fixed headers, which is where the other side's authentication goes", async () => {
    const { connector: c, calls } = connector('{}', 200, {
      headers: { authorization: 'Bearer token-do-n8n' },
    })

    await c.send(TEST_EVENT)

    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer token-do-n8n')
  })

  it('a 204 with no body does not become an error', async () => {
    const { connector: c } = connector('', 204)
    const result = await c.send(TEST_EVENT)

    expect(result.replies).toEqual([])
    expect(result.diagnosis).toBeNull()
  })

  it('measures the time, so the panel can show how long the platform took', async () => {
    const { connector: c } = connector('{"reply":"oi"}')
    const result = await c.send(TEST_EVENT)

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.status).toBe(200)
  })

  it('a platform error becomes an exception carrying its body', async () => {
    const { connector: c } = connector('{"error":"flow not found"}', 404)

    await expect(c.send(TEST_EVENT)).rejects.toMatchObject({
      status: 404,
      isPermanente: true,
    })
  })

  it('tells a configuration error apart from unavailability', () => {
    expect(new HttpConnectorError(422, 'x').isPermanente).toBe(true)
    // These are worth retrying: they belong to the other side, and they pass.
    expect(new HttpConnectorError(429, 'x').isPermanente).toBe(false)
    expect(new HttpConnectorError(502, 'x').isPermanente).toBe(false)
  })

  /**
   * The connector sits in the message path: a slow platform delays the queue
   * for that entire conversation.
   */
  it('the wait cap is short by default and bounded', () => {
    expect(CONFIG.timeoutMs).toBe(10_000)
    expect(() => httpConfigSchema.parse({ url: CONFIG.url, timeoutMs: 120_000 })).toThrow()
  })
})
