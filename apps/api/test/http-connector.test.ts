import { describe, expect, it, vi } from 'vitest'
import { httpConfigSchema } from '../src/integrations/config'
import {
  EVENTO_DE_TESTE,
  extrairRespostas,
  HttpConnector,
  HttpConnectorError,
} from '../src/integrations/http/connector'
import { verify } from '../src/webhooks/signature'

const CONFIG = httpConfigSchema.parse({ url: 'https://meu-fluxo.exemplo.com/awah' })

function resposta(corpo: string, status = 200): Response {
  return new Response(status === 204 ? null : corpo, { status })
}

function conector(corpo: string, status = 200, extra?: Partial<typeof CONFIG>) {
  const chamadas: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ url: String(url), init })
    return resposta(corpo, status)
  })

  return {
    conector: new HttpConnector(httpConfigSchema.parse({ ...CONFIG, ...extra }), {
      fetch: fetchImpl as unknown as typeof fetch,
    }),
    chamadas,
  }
}

describe('formatos de resposta aceitos', () => {
  /**
   * Ser permissivo aqui é decisão de adoção: quem monta um fluxo no n8n devolve
   * `{"reply": "..."}` sem pensar, e recusar isso porque a documentação pedia
   * `replies` seria rigor que só produz frustração.
   */
  it('aceita as formas que aparecem na prática', () => {
    const formas = [
      '{"reply":"olá"}',
      '{"replies":["olá"]}',
      '{"text":"olá"}',
      '{"message":"olá"}',
      '["olá"]',
      '"olá"',
    ]

    for (const forma of formas) {
      expect(extrairRespostas(forma).replies, forma).toEqual(['olá'])
    }
  })

  it('preserva a ordem de várias mensagens', () => {
    expect(extrairRespostas('{"replies":["um","dois","três"]}').replies).toEqual([
      'um',
      'dois',
      'três',
    ])
  })

  it('descarta texto vazio entre respostas válidas', () => {
    expect(extrairRespostas('{"replies":["um","   ","dois"]}').replies).toEqual(['um', 'dois'])
  })

  /** Nem todo evento pede resposta: quem só registra o que chega devolve vazio. */
  it('corpo vazio é resposta válida, não erro', () => {
    expect(extrairRespostas('')).toEqual({ replies: [], diagnostico: null })
    expect(extrairRespostas('   ')).toEqual({ replies: [], diagnostico: null })
  })

  it('segue o caminho configurado quando a resposta vem aninhada', () => {
    const corpo = '{"data":{"saida":{"reply":"achou"}}}'
    expect(extrairRespostas(corpo, 'data.saida').replies).toEqual(['achou'])
  })
})

describe('diagnóstico de quem acabou de plugar', () => {
  /**
   * Silêncio é o pior resultado possível: a pessoa fica olhando para uma
   * conversa parada sem nenhuma pista do que está errado.
   */
  it('explica resposta que não é JSON', () => {
    const { diagnostico } = extrairRespostas('<html>erro</html>')
    expect(diagnostico).toMatch(/not JSON/i)
    expect(diagnostico).toMatch(/reply/)
  })

  it('lista os campos que vieram quando nenhum serve', () => {
    const { replies, diagnostico } = extrairRespostas('{"resultado":"ok","codigo":200}')

    expect(replies).toEqual([])
    expect(diagnostico).toMatch(/resultado, codigo/)
    expect(diagnostico).toMatch(/"reply"/)
  })

  it('avisa quando o caminho configurado não existe', () => {
    const { diagnostico } = extrairRespostas('{"data":{}}', 'data.saida')
    expect(diagnostico).toMatch(/data\.saida/)
  })
})

describe('envio', () => {
  it('posta o evento com a forma do webhook message.received', async () => {
    const { conector: c, chamadas } = conector('{"reply":"oi"}')
    await c.enviar(EVENTO_DE_TESTE)

    const corpo = JSON.parse(String(chamadas[0]?.init?.body))
    expect(corpo.event).toBe('message.received')
    expect(corpo.data.chatId).toBe('5511999999999@s.whatsapp.net')
  })

  /**
   * Mesma assinatura dos webhooks, de propósito: quem já valida webhook do AWAH
   * valida isto com a mesma função, e o SDK serve aos dois.
   */
  it('assina com o mesmo esquema dos webhooks', async () => {
    const segredo = 'segredo-do-conector-http'
    const { conector: c, chamadas } = conector('{"reply":"oi"}', 200, { secret: segredo })

    await c.enviar(EVENTO_DE_TESTE)

    const headers = chamadas[0]?.init?.headers as Record<string, string>
    const payload = String(chamadas[0]?.init?.body)

    expect(
      verify({
        payload,
        secret: segredo,
        signature: headers['x-awah-signature'] ?? '',
        timestamp: Number(headers['x-awah-timestamp']),
      }),
    ).toBe(true)
  })

  it('não assina quando não há segredo', async () => {
    const { conector: c, chamadas } = conector('{"reply":"oi"}')
    await c.enviar(EVENTO_DE_TESTE)

    const headers = chamadas[0]?.init?.headers as Record<string, string>
    expect(headers['x-awah-signature']).toBeUndefined()
  })

  it('manda os cabeçalhos fixos, que é onde entra a autenticação do outro lado', async () => {
    const { conector: c, chamadas } = conector('{}', 200, {
      headers: { authorization: 'Bearer token-do-n8n' },
    })

    await c.enviar(EVENTO_DE_TESTE)

    const headers = chamadas[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer token-do-n8n')
  })

  it('204 sem corpo não vira erro', async () => {
    const { conector: c } = conector('', 204)
    const resultado = await c.enviar(EVENTO_DE_TESTE)

    expect(resultado.replies).toEqual([])
    expect(resultado.diagnostico).toBeNull()
  })

  it('mede o tempo, para o painel mostrar quanto a plataforma demorou', async () => {
    const { conector: c } = conector('{"reply":"oi"}')
    const resultado = await c.enviar(EVENTO_DE_TESTE)

    expect(resultado.durationMs).toBeGreaterThanOrEqual(0)
    expect(resultado.status).toBe(200)
  })

  it('erro da plataforma vira exceção com o corpo dela', async () => {
    const { conector: c } = conector('{"erro":"fluxo não encontrado"}', 404)

    await expect(c.enviar(EVENTO_DE_TESTE)).rejects.toMatchObject({
      status: 404,
      isPermanente: true,
    })
  })

  it('separa erro de configuração de indisponibilidade', () => {
    expect(new HttpConnectorError(422, 'x').isPermanente).toBe(true)
    // Estes valem repetir: são do outro lado, e passam.
    expect(new HttpConnectorError(429, 'x').isPermanente).toBe(false)
    expect(new HttpConnectorError(502, 'x').isPermanente).toBe(false)
  })

  /**
   * O conector fica no caminho da mensagem: uma plataforma que demora atrasa a
   * fila daquela conversa inteira.
   */
  it('o teto de espera é curto por padrão e limitado', () => {
    expect(CONFIG.timeoutMs).toBe(10_000)
    expect(() => httpConfigSchema.parse({ url: CONFIG.url, timeoutMs: 120_000 })).toThrow()
  })
})
