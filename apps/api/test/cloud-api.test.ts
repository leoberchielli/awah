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
   * A matriz é o contrato com quem escolhe a engine. Estes valores existem para
   * que a diferença apareça antes da migração, não depois.
   */
  it('declara o que não faz', () => {
    const { adapter } = montar(vi.fn())

    expect(adapter.capabilities.groups).toBe(false)
    expect(adapter.capabilities.qrPairing).toBe(false)
    expect(adapter.capabilities.presence).toBe(false)
    // Fora da janela de 24 h só passa template aprovado.
    expect(adapter.capabilities.freeformMessaging).toBe(false)
  })

  it('não tem QR nem código de pareamento', async () => {
    const { adapter } = montar(vi.fn())

    expect(adapter.currentQr()).toBeNull()
    await expect(adapter.requestPairingCode()).rejects.toThrow(/pareamento/i)
  })

  /** Presença não existe na Cloud API; ignorar é melhor que falhar um envio. */
  it('presença é silenciosamente ignorada', async () => {
    const chamadas = vi.fn()
    const { adapter } = montar(chamadas)

    await expect(adapter.sendPresence()).resolves.toBeUndefined()
    expect(chamadas).not.toHaveBeenCalled()
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
   * Falhar aqui é o ponto: sem esta verificação, uma credencial errada só
   * apareceria na primeira mensagem, já dentro da fila e contando como falha de
   * entrega.
   */
  it('recusa credencial inválida antes de qualquer envio', async () => {
    const fetchImpl = vi.fn(async () =>
      resposta({ error: { message: 'Invalid OAuth access token' } }, false, 401),
    )
    const { adapter, eventos } = montar(fetchImpl as unknown as typeof fetch)

    await expect(adapter.connect()).rejects.toThrow(/recusou as credenciais/i)
    expect(adapter.isReady()).toBe(false)

    const fechamento = eventos.find((e) => e.type === 'closed')
    expect(fechamento).toMatchObject({ shouldReconnect: false, loggedOut: true })
  })

  it('token expirado não fica reconectando em laço', async () => {
    const fetchImpl = vi.fn(async () => resposta({ error: { message: 'expired' } }, false, 403))
    const { adapter, eventos } = montar(fetchImpl as unknown as typeof fetch)

    await expect(adapter.connect()).rejects.toThrow()
    const fechamento = eventos.find((e) => e.type === 'closed')
    expect(fechamento).toMatchObject({ shouldReconnect: false })
  })
})

describe('envio', () => {
  it('recusa envio antes de conectar', async () => {
    const { adapter } = montar(vi.fn())
    await expect(adapter.sendText('5511999999999', 'oi')).rejects.toThrow(/não está conectada/i)
  })

  it('envia e devolve o id da Meta', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return resposta({ display_phone_number: '5511999999999' })
      return resposta({ messages: [{ id: 'wamid.ABC123' }] })
    })

    const { adapter } = montar(fetchImpl as unknown as typeof fetch)
    await adapter.connect()

    const resultado = await adapter.sendText('5511988887777@s.whatsapp.net', 'olá')
    expect(resultado.engineMessageId).toBe('wamid.ABC123')
  })

  /** A Meta espera dígitos; o sufixo de JID é do protocolo não-oficial. */
  it('converte JID para o formato da Meta', async () => {
    let corpoEnviado: Record<string, unknown> = {}
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return resposta({ display_phone_number: '551199999999' })
      corpoEnviado = JSON.parse(String(init.body))
      return resposta({ messages: [{ id: 'wamid.X' }] })
    })

    const { adapter } = montar(fetchImpl as unknown as typeof fetch)
    await adapter.connect()
    await adapter.sendText('5511988887777@s.whatsapp.net', 'oi')

    expect(corpoEnviado.to).toBe('5511988887777')
    expect(corpoEnviado.messaging_product).toBe('whatsapp')
  })

  /**
   * O erro mais confuso da Cloud API: sem tradução, quem integra vê um código
   * numérico e conclui que a credencial quebrou, quando o problema é a janela.
   */
  it('traduz a janela de 24 h encerrada', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.method) return resposta({ display_phone_number: '551199999999' })
      return resposta({ error: { code: 131047, message: 'Re-engagement message' } }, false, 400)
    })

    const { adapter } = montar(fetchImpl as unknown as typeof fetch)
    await adapter.connect()

    await expect(adapter.sendText('5511988887777', 'oi')).rejects.toThrow(/janela de 24 h/i)
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
