import { describe, expect, it, vi } from 'vitest'
import { Awah, AwahError } from '../src/index'

interface Chamada {
  url: string
  init: RequestInit
}

/**
 * A fake fetch that hands back the queued responses in order and records
 * everything it was called with.
 */
function fakeFetch(respostas: Array<{ status: number; body?: unknown; headers?: HeadersInit }>) {
  const calls: Chamada[] = []
  let index = 0

  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })

    const programada = respostas[Math.min(index, respostas.length - 1)]
    index++

    const status = programada?.status ?? 200
    // The Response constructor refuses a body on 204, 205 and 304.
    const withoutBody = status === 204 || status === 205 || status === 304

    return new Response(
      withoutBody || programada?.body === undefined ? null : JSON.stringify(programada.body),
      {
        status,
        headers: { 'content-type': 'application/json', ...programada?.headers },
      },
    )
  })

  return { impl: impl as unknown as typeof fetch, calls: calls }
}

function client(fetchImpl: typeof fetch, maxRetries = 2) {
  return new Awah({
    baseUrl: 'https://awah.example.com/',
    apiKey: 'awah_abc_segredo',
    fetch: fetchImpl,
    maxRetries,
  })
}

describe('request assembly', () => {
  it('drops the trailing slash from baseUrl so the URL has no double slash', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { sessions: [] } }])
    await client(impl).sessions.list()

    expect(calls[0]?.url).toBe('https://awah.example.com/v1/sessions')
  })

  it('sends the key as a bearer token', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { sessions: [] } }])
    await client(impl).sessions.list()

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer awah_abc_segredo')
  })

  it('omits a query parameter that was not given', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: {} }])
    await client(impl).kpi.delivery({ hours: 168 })

    expect(calls[0]?.url).toContain('hours=168')
    expect(calls[0]?.url).not.toContain('sessionId')
  })
})

describe('send idempotency', () => {
  /**
   * This is what makes the automatic retry safe: without a key, repeating a POST
   * after a network timeout would send the end customer two messages.
   */
  it('generates a clientMessageId when none is given', async () => {
    const { impl, calls } = fakeFetch([{ status: 202, body: { id: 'x' } }])
    await client(impl).messages.sendText('session', { chatId: '5511999999999', text: 'hi' })

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.clientMessageId).toBeTruthy()
    expect(body.text).toBe('hi')
  })

  it('respects the clientMessageId the caller supplied', async () => {
    const { impl, calls } = fakeFetch([{ status: 202, body: { id: 'x' } }])
    await client(impl).messages.sendText('session', {
      chatId: '5511999999999',
      text: 'hi',
      clientMessageId: 'pedido-4821',
    })

    expect(JSON.parse(String(calls[0]?.init.body)).clientMessageId).toBe('pedido-4821')
  })

  it('the same key goes out identical on both calls', async () => {
    const { impl, calls } = fakeFetch([{ status: 202, body: { duplicate: false } }])
    const awah = client(impl)

    const envio = { chatId: '5511999999999', text: 'hi', clientMessageId: 'pedido-1' }
    await awah.messages.sendText('session', envio)
    await awah.messages.sendText('session', envio)

    const keys = calls.map((c) => JSON.parse(String(c.init.body)).clientMessageId)
    expect(keys).toEqual(['pedido-1', 'pedido-1'])
  })

  it('the risk override becomes a header, not a body field', async () => {
    const { impl, calls } = fakeFetch([{ status: 202, body: {} }])
    await client(impl).messages.sendText('session', {
      chatId: '5511999999999',
      text: 'urgente',
      bypassRisk: true,
    })

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['x-awah-bypass-risk']).toBe('true')
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty('bypassRisk')
  })
})

describe('retry policy', () => {
  it('retries a 503 and returns the good response', async () => {
    const { impl, calls } = fakeFetch([
      { status: 503, body: { error: { code: 'unavailable', message: 'fora do ar' } } },
      { status: 200, body: { sessions: [{ id: 'a' }] } },
    ])

    const result = await client(impl).sessions.list()

    expect(calls).toHaveLength(2)
    expect(result.sessions).toHaveLength(1)
  })

  /**
   * Retrying a 4xx is waste: the server rejected the content, and sending it
   * again produces exactly the same rejection.
   */
  it('does not retry a 400', async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: { error: { code: 'validation_failed', message: 'invalid' } } },
    ])

    await expect(client(impl).sessions.list()).rejects.toThrow(/invalid/)
    expect(calls).toHaveLength(1)
  })

  it('does not retry a 401', async () => {
    const { impl, calls } = fakeFetch([
      { status: 401, body: { error: { code: 'unauthorized', message: 'invalid key' } } },
    ])

    await expect(client(impl).sessions.list()).rejects.toMatchObject({ isAuth: true })
    expect(calls).toHaveLength(1)
  })

  it('gives up after the attempt cap', async () => {
    const { impl, calls } = fakeFetch([{ status: 500, body: {} }])

    await expect(client(impl, 2).sessions.list()).rejects.toBeInstanceOf(AwahError)
    expect(calls).toHaveLength(3)
  })

  it('respects Retry-After when it is short', async () => {
    const { impl, calls } = fakeFetch([
      { status: 429, body: {}, headers: { 'retry-after': '0' } },
      { status: 200, body: { sessions: [] } },
    ])

    await client(impl).sessions.list()
    expect(calls).toHaveLength(2)
  })

  it('retries a network failure on a safe route', async () => {
    let attempts = 0
    const impl = vi.fn(async () => {
      attempts++
      if (attempts === 1) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 })
    })

    await client(impl as unknown as typeof fetch).sessions.list()
    expect(attempts).toBe(2)
  })
})

describe('errors', () => {
  it('preserves the code from the API envelope', async () => {
    const { impl } = fakeFetch([
      {
        status: 409,
        body: { error: { code: 'conflict', message: 'This session is already running.' } },
      },
    ])

    try {
      await client(impl).sessions.start('abc')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AwahError)
      expect((error as AwahError).code).toBe('conflict')
      expect((error as AwahError).status).toBe(409)
    }
  })

  it('survives a response outside the envelope', async () => {
    const { impl } = fakeFetch([{ status: 502, body: 'bad gateway' }])

    await expect(client(impl, 0).sessions.list()).rejects.toMatchObject({
      code: 'unknown',
      status: 502,
    })
  })

  it('204 becomes undefined, not a parse error', async () => {
    const { impl } = fakeFetch([{ status: 204 }])
    await expect(client(impl).sessions.delete('abc')).resolves.toBeUndefined()
  })
})

describe('client construction', () => {
  it('requires baseUrl and apiKey', () => {
    expect(() => new Awah({ baseUrl: '', apiKey: 'x' })).toThrow(/baseUrl/)
    expect(() => new Awah({ baseUrl: 'https://a', apiKey: '' })).toThrow(/apiKey/)
  })
})
