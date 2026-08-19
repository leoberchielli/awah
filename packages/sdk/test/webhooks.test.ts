import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SIGNATURE_HEADER,
  signWebhook,
  TIMESTAMP_HEADER,
  verifyWebhook,
  verifyWebhookRequest,
} from '../src/index'

const SEGREDO = 'segredo-do-endpoint'
const CORPO = '{"event":"message.received","data":{"chatId":"5511999999999"}}'
const AGORA = 1_800_000_000_000

const agora = () => AGORA
const emSegundos = Math.floor(AGORA / 1000)

/** A implementação de referência do servidor, para provar que as duas batem. */
function assinarComoOServidor(payload: string, secret: string, timestamp: number): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`
}

describe('paridade com o servidor', () => {
  it('produz exatamente a mesma assinatura que o node:crypto do servidor', async () => {
    const doSdk = await signWebhook(CORPO, SEGREDO, emSegundos)
    expect(doSdk).toBe(assinarComoOServidor(CORPO, SEGREDO, emSegundos))
  })
})

describe('verificação', () => {
  it('aceita entrega legítima', async () => {
    const valido = await verifyWebhook({
      payload: CORPO,
      secret: SEGREDO,
      signature: assinarComoOServidor(CORPO, SEGREDO, emSegundos),
      timestamp: emSegundos,
      now: agora,
    })

    expect(valido).toBe(true)
  })

  it('recusa segredo errado', async () => {
    const valido = await verifyWebhook({
      payload: CORPO,
      secret: 'outro-segredo',
      signature: assinarComoOServidor(CORPO, SEGREDO, emSegundos),
      timestamp: emSegundos,
      now: agora,
    })

    expect(valido).toBe(false)
  })

  it('recusa corpo adulterado', async () => {
    const valido = await verifyWebhook({
      payload: CORPO.replace('5511999999999', '5511000000000'),
      secret: SEGREDO,
      signature: assinarComoOServidor(CORPO, SEGREDO, emSegundos),
      timestamp: emSegundos,
      now: agora,
    })

    expect(valido).toBe(false)
  })

  /**
   * O ponto do esquema: o timestamp está **dentro** da assinatura. Uma entrega
   * capturada não pode ser reenviada depois, e mudar o timestamp para escapar da
   * janela invalida a assinatura.
   */
  it('recusa entrega antiga', async () => {
    const velho = emSegundos - 3600

    const valido = await verifyWebhook({
      payload: CORPO,
      secret: SEGREDO,
      signature: assinarComoOServidor(CORPO, SEGREDO, velho),
      timestamp: velho,
      now: agora,
    })

    expect(valido).toBe(false)
  })

  it('recusa timestamp trocado para escapar da janela', async () => {
    const velho = emSegundos - 3600

    const valido = await verifyWebhook({
      payload: CORPO,
      secret: SEGREDO,
      // Assinada com o timestamp antigo, apresentada com o atual.
      signature: assinarComoOServidor(CORPO, SEGREDO, velho),
      timestamp: emSegundos,
      now: agora,
    })

    expect(valido).toBe(false)
  })

  it('a janela é configurável', async () => {
    const velho = emSegundos - 3600

    const valido = await verifyWebhook({
      payload: CORPO,
      secret: SEGREDO,
      signature: assinarComoOServidor(CORPO, SEGREDO, velho),
      timestamp: velho,
      toleranceSeconds: 7200,
      now: agora,
    })

    expect(valido).toBe(true)
  })

  it('aceita o timestamp como string, que é como ele chega no header', async () => {
    const valido = await verifyWebhook({
      payload: CORPO,
      secret: SEGREDO,
      signature: assinarComoOServidor(CORPO, SEGREDO, emSegundos),
      timestamp: String(emSegundos),
      now: agora,
    })

    expect(valido).toBe(true)
  })

  it('recusa header ausente sem estourar', async () => {
    await expect(
      verifyWebhook({ payload: CORPO, secret: SEGREDO, signature: '', timestamp: '' }),
    ).resolves.toBe(false)
  })
})

describe('atalho para Request padrão', () => {
  it('valida e devolve o corpo cru para quem for parsear depois', async () => {
    const timestamp = Math.floor(Date.now() / 1000)

    const request = new Request('https://meu-sistema/hook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: assinarComoOServidor(CORPO, SEGREDO, timestamp),
        [TIMESTAMP_HEADER]: String(timestamp),
      },
      body: CORPO,
    })

    const { valid, payload } = await verifyWebhookRequest(request, SEGREDO)

    expect(valid).toBe(true)
    expect(payload).toBe(CORPO)
    expect(JSON.parse(payload).event).toBe('message.received')
  })

  it('reprova quando falta a assinatura', async () => {
    const request = new Request('https://meu-sistema/hook', { method: 'POST', body: CORPO })
    const { valid } = await verifyWebhookRequest(request, SEGREDO)

    expect(valid).toBe(false)
  })
})
