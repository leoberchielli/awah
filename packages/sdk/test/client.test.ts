import { describe, expect, it, vi } from 'vitest'
import { Awah, AwahError } from '../src/index'

interface Chamada {
  url: string
  init: RequestInit
}

/**
 * Fetch de mentira que devolve as respostas na ordem em que foram programadas e
 * grava tudo que recebeu.
 */
function fakeFetch(respostas: Array<{ status: number; body?: unknown; headers?: HeadersInit }>) {
  const calls: Chamada[] = []
  let indice = 0

  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })

    const programada = respostas[Math.min(indice, respostas.length - 1)]
    indice++

    const status = programada?.status ?? 200
    // O construtor de Response recusa corpo em 204, 205 e 304.
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

function cliente(fetchImpl: typeof fetch, maxRetries = 2) {
  return new Awah({
    baseUrl: 'https://awah.exemplo.com/',
    apiKey: 'awah_abc_segredo',
    fetch: fetchImpl,
    maxRetries,
  })
}

describe('montagem da requisição', () => {
  it('descarta a barra final da baseUrl para não gerar barra dupla', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { sessions: [] } }])
    await cliente(impl).sessions.list()

    expect(calls[0]?.url).toBe('https://awah.exemplo.com/v1/sessions')
  })

  it('manda a chave como bearer', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { sessions: [] } }])
    await cliente(impl).sessions.list()

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer awah_abc_segredo')
  })

  it('omite parâmetro de query que não foi informado', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: {} }])
    await cliente(impl).kpi.delivery({ hours: 168 })

    expect(calls[0]?.url).toContain('hours=168')
    expect(calls[0]?.url).not.toContain('sessionId')
  })
})

describe('idempotência do envio', () => {
  /**
   * É o que torna o retry automático seguro: sem chave, repetir um POST depois
   * de um timeout de rede geraria duas mensagens para o cliente final.
   */
  it('gera clientMessageId quando não vem um', async () => {
    const { impl, calls } = fakeFetch([{ status: 202, body: { id: 'x' } }])
    await cliente(impl).messages.sendText('sessao', { chatId: '5511999999999', text: 'oi' })

    const body = JSON.parse(String(calls[0]?.init.body))
    expect(body.clientMessageId).toBeTruthy()
    expect(body.text).toBe('oi')
  })

  it('respeita o clientMessageId de quem chamou', async () => {
    const { impl, calls } = fakeFetch([{ status: 202, body: { id: 'x' } }])
    await cliente(impl).messages.sendText('sessao', {
      chatId: '5511999999999',
      text: 'oi',
      clientMessageId: 'pedido-4821',
    })

    expect(JSON.parse(String(calls[0]?.init.body)).clientMessageId).toBe('pedido-4821')
  })

  it('a mesma chave em duas chamadas vai igual nas duas', async () => {
    const { impl, calls } = fakeFetch([{ status: 202, body: { duplicate: false } }])
    const awah = cliente(impl)

    const envio = { chatId: '5511999999999', text: 'oi', clientMessageId: 'pedido-1' }
    await awah.messages.sendText('sessao', envio)
    await awah.messages.sendText('sessao', envio)

    const keys = calls.map((c) => JSON.parse(String(c.init.body)).clientMessageId)
    expect(keys).toEqual(['pedido-1', 'pedido-1'])
  })

  it('o override de risco vira cabeçalho, não campo do corpo', async () => {
    const { impl, calls } = fakeFetch([{ status: 202, body: {} }])
    await cliente(impl).messages.sendText('sessao', {
      chatId: '5511999999999',
      text: 'urgente',
      bypassRisk: true,
    })

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['x-awah-bypass-risk']).toBe('true')
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty('bypassRisk')
  })
})

describe('política de retentativa', () => {
  it('repete 503 e devolve a resposta boa', async () => {
    const { impl, calls } = fakeFetch([
      { status: 503, body: { error: { code: 'unavailable', message: 'fora do ar' } } },
      { status: 200, body: { sessions: [{ id: 'a' }] } },
    ])

    const result = await cliente(impl).sessions.list()

    expect(calls).toHaveLength(2)
    expect(result.sessions).toHaveLength(1)
  })

  /**
   * Repetir 4xx é desperdício: o servidor rejeitou o conteúdo, e mandar de novo
   * produz exatamente a mesma rejeição.
   */
  it('não repete 400', async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: { error: { code: 'validation_failed', message: 'inválido' } } },
    ])

    await expect(cliente(impl).sessions.list()).rejects.toThrow(/inválido/)
    expect(calls).toHaveLength(1)
  })

  it('não repete 401', async () => {
    const { impl, calls } = fakeFetch([
      { status: 401, body: { error: { code: 'unauthorized', message: 'chave inválida' } } },
    ])

    await expect(cliente(impl).sessions.list()).rejects.toMatchObject({ isAuth: true })
    expect(calls).toHaveLength(1)
  })

  it('desiste depois do teto de tentativas', async () => {
    const { impl, calls } = fakeFetch([{ status: 500, body: {} }])

    await expect(cliente(impl, 2).sessions.list()).rejects.toBeInstanceOf(AwahError)
    expect(calls).toHaveLength(3)
  })

  it('respeita o Retry-After quando ele é curto', async () => {
    const { impl, calls } = fakeFetch([
      { status: 429, body: {}, headers: { 'retry-after': '0' } },
      { status: 200, body: { sessions: [] } },
    ])

    await cliente(impl).sessions.list()
    expect(calls).toHaveLength(2)
  })

  it('repete falha de rede em rota segura', async () => {
    let attempts = 0
    const impl = vi.fn(async () => {
      attempts++
      if (attempts === 1) throw new TypeError('fetch failed')
      return new Response(JSON.stringify({ sessions: [] }), { status: 200 })
    })

    await cliente(impl as unknown as typeof fetch).sessions.list()
    expect(attempts).toBe(2)
  })
})

describe('erros', () => {
  it('preserva o code do envelope da API', async () => {
    const { impl } = fakeFetch([
      {
        status: 409,
        body: { error: { code: 'conflict', message: 'Esta sessão já está em execução.' } },
      },
    ])

    try {
      await cliente(impl).sessions.start('abc')
      expect.unreachable('deveria ter lançado')
    } catch (error) {
      expect(error).toBeInstanceOf(AwahError)
      expect((error as AwahError).code).toBe('conflict')
      expect((error as AwahError).status).toBe(409)
    }
  })

  it('sobrevive a resposta fora do envelope', async () => {
    const { impl } = fakeFetch([{ status: 502, body: 'gateway ruim' }])

    await expect(cliente(impl, 0).sessions.list()).rejects.toMatchObject({
      code: 'unknown',
      status: 502,
    })
  })

  it('204 vira undefined, não erro de parse', async () => {
    const { impl } = fakeFetch([{ status: 204 }])
    await expect(cliente(impl).sessions.delete('abc')).resolves.toBeUndefined()
  })
})

describe('construção do cliente', () => {
  it('exige baseUrl e apiKey', () => {
    expect(() => new Awah({ baseUrl: '', apiKey: 'x' })).toThrow(/baseUrl/)
    expect(() => new Awah({ baseUrl: 'https://a', apiKey: '' })).toThrow(/apiKey/)
  })
})
