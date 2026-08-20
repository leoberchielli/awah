import { describe, expect, it, vi } from 'vitest'
import { httpConfigSchema } from '../src/integrations/config'
import {
  extractReplies,
  HttpConnector,
  HttpConnectorError,
  TEST_EVENT,
} from '../src/integrations/http/connector'
import { verify } from '../src/webhooks/signature'

const CONFIG = httpConfigSchema.parse({ url: 'https://meu-fluxo.exemplo.com/awah' })

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

describe('formatos de resposta aceitos', () => {
  /**
   * Being permissive here is an adoption decision: someone wiring up a flow in
   * n8n returns `{"reply": "..."}` without thinking, and rejecting that because
   * the docs asked for `replies` is rigour that only produces frustration.
   */
  it('aceita as formas que aparecem na prática', () => {
    const shapes = [
      '{"reply":"olá"}',
      '{"replies":["olá"]}',
      '{"text":"olá"}',
      '{"message":"olá"}',
      '["olá"]',
      '"olá"',
    ]

    for (const shape of shapes) {
      expect(extractReplies(shape).replies, shape).toEqual(['olá'])
    }
  })

  it('preserva a ordem de várias mensagens', () => {
    expect(extractReplies('{"replies":["um","dois","três"]}').replies).toEqual([
      'um',
      'dois',
      'três',
    ])
  })

  it('descarta texto vazio entre respostas válidas', () => {
    expect(extractReplies('{"replies":["um","   ","dois"]}').replies).toEqual(['um', 'dois'])
  })

  /** Not every event wants a reply: a flow that only logs arrivals returns empty. */
  it('corpo vazio é resposta válida, não erro', () => {
    expect(extractReplies('')).toEqual({ replies: [], diagnosis: null })
    expect(extractReplies('   ')).toEqual({ replies: [], diagnosis: null })
  })

  it('segue o caminho configurado quando a resposta vem aninhada', () => {
    const body = '{"data":{"saida":{"reply":"achou"}}}'
    expect(extractReplies(body, 'data.saida').replies).toEqual(['achou'])
  })
})

describe('diagnóstico de quem acabou de plugar', () => {
  /**
   * Silence is the worst possible outcome: the person sits staring at a dead
   * conversation with no clue what is wrong.
   */
  it('explica resposta que não é JSON', () => {
    const { diagnosis } = extractReplies('<html>erro</html>')
    expect(diagnosis).toMatch(/not JSON/i)
    expect(diagnosis).toMatch(/reply/)
  })

  it('lista os campos que vieram quando nenhum serve', () => {
    const { replies, diagnosis } = extractReplies('{"resultado":"ok","codigo":200}')

    expect(replies).toEqual([])
    expect(diagnosis).toMatch(/resultado, codigo/)
    expect(diagnosis).toMatch(/"reply"/)
  })

  it('avisa quando o caminho configurado não existe', () => {
    const { diagnosis } = extractReplies('{"data":{}}', 'data.saida')
    expect(diagnosis).toMatch(/data\.saida/)
  })
})

describe('envio', () => {
  it('posta o evento com a forma do webhook message.received', async () => {
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
  it('assina com o mesmo esquema dos webhooks', async () => {
    const secret = 'segredo-do-conector-http'
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

  it('não assina quando não há segredo', async () => {
    const { connector: c, calls } = connector('{"reply":"oi"}')
    await c.send(TEST_EVENT)

    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers['x-awah-signature']).toBeUndefined()
  })

  it('manda os cabeçalhos fixos, que é onde entra a autenticação do outro lado', async () => {
    const { connector: c, calls } = connector('{}', 200, {
      headers: { authorization: 'Bearer token-do-n8n' },
    })

    await c.send(TEST_EVENT)

    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer token-do-n8n')
  })

  it('204 sem corpo não vira erro', async () => {
    const { connector: c } = connector('', 204)
    const result = await c.send(TEST_EVENT)

    expect(result.replies).toEqual([])
    expect(result.diagnosis).toBeNull()
  })

  it('mede o tempo, para o painel mostrar quanto a plataforma demorou', async () => {
    const { connector: c } = connector('{"reply":"oi"}')
    const result = await c.send(TEST_EVENT)

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.status).toBe(200)
  })

  it('erro da plataforma vira exceção com o corpo dela', async () => {
    const { connector: c } = connector('{"erro":"fluxo não encontrado"}', 404)

    await expect(c.send(TEST_EVENT)).rejects.toMatchObject({
      status: 404,
      isPermanente: true,
    })
  })

  it('separa erro de configuração de indisponibilidade', () => {
    expect(new HttpConnectorError(422, 'x').isPermanente).toBe(true)
    // These are worth retrying: they belong to the other side, and they pass.
    expect(new HttpConnectorError(429, 'x').isPermanente).toBe(false)
    expect(new HttpConnectorError(502, 'x').isPermanente).toBe(false)
  })

  /**
   * The connector sits in the message path: a slow platform delays the queue
   * for that entire conversation.
   */
  it('o teto de espera é curto por padrão e limitado', () => {
    expect(CONFIG.timeoutMs).toBe(10_000)
    expect(() => httpConfigSchema.parse({ url: CONFIG.url, timeoutMs: 120_000 })).toThrow()
  })
})
