import { describe, expect, it, vi } from 'vitest'
import { CloudApiAdapter } from '../src/engines/cloud-api/adapter'
import type { CloudApiCredentials } from '../src/engines/cloud-api/credentials'
import type { EngineEvent } from '../src/engines/types'

const credenciais: CloudApiCredentials = {
  phoneNumberId: '123456789',
  accessToken: 'token-de-teste-bem-longo-aqui',
  verifyToken: 'verificacao',
  appSecret: 'segredo-do-app',
  graphVersion: 'v21.0',
}

function resposta(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}

function montar(fetchImpl: typeof fetch) {
  const eventos: EngineEvent[] = []
  const adapter = new CloudApiAdapter({
    sessionId: 'sessao-teste',
    credentials: credenciais,
    onEvent: (evento) => eventos.push(evento),
    fetchImpl,
  })
  return { adapter, eventos }
}

describe('capacidades da engine oficial', () => {
  /**
   * The matrix is the contract with whoever picks the engine. These values
   * exist so the difference shows up before the migration, not after.
   */
  it('declara o que não faz', () => {
    const { adapter } = montar(vi.fn())

    expect(adapter.capabilities.groups).toBe(false)
    expect(adapter.capabilities.qrPairing).toBe(false)
    expect(adapter.capabilities.presence).toBe(false)
    // Outside the 24 h window only an approved template gets through.
    expect(adapter.capabilities.freeformMessaging).toBe(false)
  })

  it('não tem QR nem código de pareamento', async () => {
    const { adapter } = montar(vi.fn())

    expect(adapter.currentQr()).toBeNull()
    await expect(adapter.requestPairingCode()).rejects.toThrow(/pairing/i)
  })

  /** Presence does not exist in the Cloud API; ignoring it beats failing a send. */
  it('presença é silenciosamente ignorada', async () => {
    const calls = vi.fn()
    const { adapter } = montar(calls)

    await expect(adapter.sendPresence()).resolves.toBeUndefined()
    expect(calls).not.toHaveBeenCalled()
  })
})

describe('conexão', () => {
  it('valida as credenciais e reporta o número', async () => {
    const fetchImpl = vi.fn(async () => resposta({ display_phone_number: '+55 11 99999-9999' }))
    const { adapter, eventos } = montar(fetchImpl as unknown as typeof fetch)

    await adapter.connect()

    expect(adapter.isReady()).toBe(true)
    expect(eventos).toContainEqual({ type: 'paired', phoneNumber: '5511999999999' })
    expect(eventos).toContainEqual({ type: 'status', status: 'connected' })
  })

  /**
   * Failing here is the whole point: without this check, a wrong credential
   * would only surface on the first message, already inside the queue and
   * counting as a delivery failure.
   */
  it('recusa credencial inválida antes de qualquer envio', async () => {
    const fetchImpl = vi.fn(async () =>
      resposta({ error: { message: 'Invalid OAuth access token' } }, false, 401),
    )
    const { adapter, eventos } = montar(fetchImpl as unknown as typeof fetch)

    await expect(adapter.connect()).rejects.toThrow(/rejected the credentials/i)
    expect(adapter.isReady()).toBe(false)

    const closing = eventos.find((e) => e.type === 'closed')
    expect(closing).toMatchObject({ shouldReconnect: false, loggedOut: true })
  })

  it('token expirado não fica reconectando em laço', async () => {
    const fetchImpl = vi.fn(async () => resposta({ error: { message: 'expired' } }, false, 403))
    const { adapter, eventos } = montar(fetchImpl as unknown as typeof fetch)

    await expect(adapter.connect()).rejects.toThrow()
    const closing = eventos.find((e) => e.type === 'closed')
    expect(closing).toMatchObject({ shouldReconnect: false })
  })
})

describe('envio', () => {
  it('recusa envio antes de conectar', async () => {
    const { adapter } = montar(vi.fn())
    await expect(adapter.sendText('5511999999999', 'oi')).rejects.toThrow(/not connected/i)
  })

  it('envia e devolve o id da Meta', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return resposta({ display_phone_number: '5511999999999' })
      return resposta({ messages: [{ id: 'wamid.ABC123' }] })
    })

    const { adapter } = montar(fetchImpl as unknown as typeof fetch)
    await adapter.connect()

    const result = await adapter.sendText('5511988887777@s.whatsapp.net', 'olá')
    expect(result.engineMessageId).toBe('wamid.ABC123')
  })

  /** Meta expects digits; the JID suffix belongs to the unofficial protocol. */
  it('converte JID para o formato da Meta', async () => {
    let sentBody: Record<string, unknown> = {}
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return resposta({ display_phone_number: '551199999999' })
      sentBody = JSON.parse(String(init.body))
      return resposta({ messages: [{ id: 'wamid.X' }] })
    })

    const { adapter } = montar(fetchImpl as unknown as typeof fetch)
    await adapter.connect()
    await adapter.sendText('5511988887777@s.whatsapp.net', 'oi')

    expect(sentBody.to).toBe('5511988887777')
    expect(sentBody.messaging_product).toBe('whatsapp')
  })

  /**
   * The most confusing Cloud API error: untranslated, whoever is integrating
   * sees a numeric code and concludes the credential broke, when the real
   * problem is the window.
   */
  it('traduz a janela de 24 h encerrada', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return resposta({ display_phone_number: '551199999999' })
      return resposta({ error: { code: 131047, message: 'Re-engagement message' } }, false, 400)
    })

    const { adapter } = montar(fetchImpl as unknown as typeof fetch)
    await adapter.connect()

    await expect(adapter.sendText('5511988887777', 'oi')).rejects.toThrow(/24 h window/i)
  })

  it('propaga a mensagem de erro da Meta', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return resposta({ display_phone_number: '551199999999' })
      return resposta(
        { error: { message: 'Recipient phone number not in allowed list' } },
        false,
        400,
      )
    })

    const { adapter } = montar(fetchImpl as unknown as typeof fetch)
    await adapter.connect()

    await expect(adapter.sendText('5511988887777', 'oi')).rejects.toThrow(/allowed list/i)
  })

  it('usa a versão configurada da Graph API', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      return resposta({ display_phone_number: '551199999999' })
    })

    const { adapter } = montar(fetchImpl as unknown as typeof fetch)
    await adapter.connect()

    expect(urls[0]).toContain('/v21.0/123456789')
  })
})
