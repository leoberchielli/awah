import { describe, expect, it, vi } from 'vitest'
import { CloudApiAdapter } from '../src/engines/cloud-api/adapter'
import type { CloudApiCredentials } from '../src/engines/cloud-api/credentials'
import type { EngineEvent } from '../src/engines/types'

const credentials: CloudApiCredentials = {
  phoneNumberId: '123456789',
  accessToken: 'a-nice-long-test-token-here',
  verifyToken: 'verificacao',
  appSecret: 'app-secret',
  graphVersion: 'v21.0',
}

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}

function makeAdapter(fetchImpl: typeof fetch) {
  const events: EngineEvent[] = []
  const adapter = new CloudApiAdapter({
    sessionId: 'test-session',
    credentials: credentials,
    onEvent: (event) => events.push(event),
    fetchImpl,
  })
  return { adapter, events: events }
}

describe('official engine capabilities', () => {
  /**
   * The matrix is the contract with whoever picks the engine. These values
   * exist so the difference shows up before the migration, not after.
   */
  it('declares what it does not do', () => {
    const { adapter } = makeAdapter(vi.fn())

    expect(adapter.capabilities.groups).toBe(false)
    expect(adapter.capabilities.qrPairing).toBe(false)
    expect(adapter.capabilities.presence).toBe(false)
    // Outside the 24 h window only an approved template gets through.
    expect(adapter.capabilities.freeformMessaging).toBe(false)
  })

  it('has no QR and no pairing code', async () => {
    const { adapter } = makeAdapter(vi.fn())

    expect(adapter.currentQr()).toBeNull()
    await expect(adapter.requestPairingCode()).rejects.toThrow(/pairing/i)
  })

  /** Presence does not exist in the Cloud API; ignoring it beats failing a send. */
  it('presence is silently ignored', async () => {
    const calls = vi.fn()
    const { adapter } = makeAdapter(calls)

    await expect(adapter.sendPresence()).resolves.toBeUndefined()
    expect(calls).not.toHaveBeenCalled()
  })
})

describe('connection', () => {
  it('validates the credentials and reports the number', async () => {
    const fetchImpl = vi.fn(async () => response({ display_phone_number: '+55 11 99999-9999' }))
    const { adapter, events } = makeAdapter(fetchImpl as unknown as typeof fetch)

    await adapter.connect()

    expect(adapter.isReady()).toBe(true)
    expect(events).toContainEqual({ type: 'paired', phoneNumber: '5511999999999' })
    expect(events).toContainEqual({ type: 'status', status: 'connected' })
  })

  /**
   * Failing here is the whole point: without this check, a wrong credential
   * would only surface on the first message, already inside the queue and
   * counting as a delivery failure.
   */
  it('refuses an invalid credential before any send', async () => {
    const fetchImpl = vi.fn(async () =>
      response({ error: { message: 'Invalid OAuth access token' } }, false, 401),
    )
    const { adapter, events } = makeAdapter(fetchImpl as unknown as typeof fetch)

    await expect(adapter.connect()).rejects.toThrow(/rejected the credentials/i)
    expect(adapter.isReady()).toBe(false)

    const closing = events.find((e) => e.type === 'closed')
    expect(closing).toMatchObject({ shouldReconnect: false, loggedOut: true })
  })

  it('an expired token does not reconnect in a loop', async () => {
    const fetchImpl = vi.fn(async () => response({ error: { message: 'expired' } }, false, 403))
    const { adapter, events } = makeAdapter(fetchImpl as unknown as typeof fetch)

    await expect(adapter.connect()).rejects.toThrow()
    const closing = events.find((e) => e.type === 'closed')
    expect(closing).toMatchObject({ shouldReconnect: false })
  })
})

describe('sending', () => {
  it('refuses to send before connecting', async () => {
    const { adapter } = makeAdapter(vi.fn())
    await expect(adapter.sendText('5511999999999', 'hi')).rejects.toThrow(/not connected/i)
  })

  it("sends and returns Meta's id", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return response({ display_phone_number: '5511999999999' })
      return response({ messages: [{ id: 'wamid.ABC123' }] })
    })

    const { adapter } = makeAdapter(fetchImpl as unknown as typeof fetch)
    await adapter.connect()

    const result = await adapter.sendText('5511988887777@s.whatsapp.net', 'hi')
    expect(result.engineMessageId).toBe('wamid.ABC123')
  })

  /** Meta expects digits; the JID suffix belongs to the unofficial protocol. */
  it("converts a JID to Meta's format", async () => {
    let sentBody: Record<string, unknown> = {}
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return response({ display_phone_number: '551199999999' })
      sentBody = JSON.parse(String(init.body))
      return response({ messages: [{ id: 'wamid.X' }] })
    })

    const { adapter } = makeAdapter(fetchImpl as unknown as typeof fetch)
    await adapter.connect()
    await adapter.sendText('5511988887777@s.whatsapp.net', 'hi')

    expect(sentBody.to).toBe('5511988887777')
    expect(sentBody.messaging_product).toBe('whatsapp')
  })

  /**
   * The most confusing Cloud API error: untranslated, whoever is integrating
   * sees a numeric code and concludes the credential broke, when the real
   * problem is the window.
   */
  it('translates the closed 24 h window', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return response({ display_phone_number: '551199999999' })
      return response({ error: { code: 131047, message: 'Re-engagement message' } }, false, 400)
    })

    const { adapter } = makeAdapter(fetchImpl as unknown as typeof fetch)
    await adapter.connect()

    await expect(adapter.sendText('5511988887777', 'hi')).rejects.toThrow(/24 h window/i)
  })

  it("propagates Meta's error message", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return response({ display_phone_number: '551199999999' })
      return response(
        { error: { message: 'Recipient phone number not in allowed list' } },
        false,
        400,
      )
    })

    const { adapter } = makeAdapter(fetchImpl as unknown as typeof fetch)
    await adapter.connect()

    await expect(adapter.sendText('5511988887777', 'hi')).rejects.toThrow(/allowed list/i)
  })

  it('uses the configured Graph API version', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return response({ display_phone_number: '551199999999' })
    })

    const { adapter } = makeAdapter(fetchImpl as unknown as typeof fetch)
    await adapter.connect()

    expect(urls[0]).toContain('/v21.0/123456789')
  })
})
