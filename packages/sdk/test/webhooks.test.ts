import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SIGNATURE_HEADER,
  signWebhook,
  TIMESTAMP_HEADER,
  verifyWebhook,
  verifyWebhookRequest,
} from '../src/index'

const SECRET = 'endpoint-secret'
const BODY = '{"event":"message.received","data":{"chatId":"5511999999999"}}'
const NOW = 1_800_000_000_000

const agora = () => NOW
const emSegundos = Math.floor(NOW / 1000)

/** The server's reference implementation, to prove the two agree. */
function assinarComoOServidor(payload: string, secret: string, timestamp: number): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`
}

describe('parity with the server', () => {
  it('produces exactly the same signature as the node:crypto on the server', async () => {
    const doSdk = await signWebhook(BODY, SECRET, emSegundos)
    expect(doSdk).toBe(assinarComoOServidor(BODY, SECRET, emSegundos))
  })
})

describe('verification', () => {
  it('accepts a legitimate delivery', async () => {
    const valido = await verifyWebhook({
      payload: BODY,
      secret: SECRET,
      signature: assinarComoOServidor(BODY, SECRET, emSegundos),
      timestamp: emSegundos,
      now: agora,
    })

    expect(valido).toBe(true)
  })

  it('refuses the wrong secret', async () => {
    const valido = await verifyWebhook({
      payload: BODY,
      secret: 'other-secret',
      signature: assinarComoOServidor(BODY, SECRET, emSegundos),
      timestamp: emSegundos,
      now: agora,
    })

    expect(valido).toBe(false)
  })

  it('refuses a tampered body', async () => {
    const valido = await verifyWebhook({
      payload: BODY.replace('5511999999999', '5511000000000'),
      secret: SECRET,
      signature: assinarComoOServidor(BODY, SECRET, emSegundos),
      timestamp: emSegundos,
      now: agora,
    })

    expect(valido).toBe(false)
  })

  /**
   * The point of the scheme: the timestamp is **inside** the signature. A
   * captured delivery cannot be replayed later, and changing the timestamp to
   * escape the window invalidates the signature.
   */
  it('refuses an old delivery', async () => {
    const velho = emSegundos - 3600

    const valido = await verifyWebhook({
      payload: BODY,
      secret: SECRET,
      signature: assinarComoOServidor(BODY, SECRET, velho),
      timestamp: velho,
      now: agora,
    })

    expect(valido).toBe(false)
  })

  it('refuses a timestamp swapped to escape the window', async () => {
    const velho = emSegundos - 3600

    const valido = await verifyWebhook({
      payload: BODY,
      secret: SECRET,
      // Signed with the old timestamp, presented with the current one.
      signature: assinarComoOServidor(BODY, SECRET, velho),
      timestamp: emSegundos,
      now: agora,
    })

    expect(valido).toBe(false)
  })

  it('the window is configurable', async () => {
    const velho = emSegundos - 3600

    const valido = await verifyWebhook({
      payload: BODY,
      secret: SECRET,
      signature: assinarComoOServidor(BODY, SECRET, velho),
      timestamp: velho,
      toleranceSeconds: 7200,
      now: agora,
    })

    expect(valido).toBe(true)
  })

  it('accepts the timestamp as a string, which is how it arrives in the header', async () => {
    const valido = await verifyWebhook({
      payload: BODY,
      secret: SECRET,
      signature: assinarComoOServidor(BODY, SECRET, emSegundos),
      timestamp: String(emSegundos),
      now: agora,
    })

    expect(valido).toBe(true)
  })

  it('refuses a missing header without blowing up', async () => {
    await expect(
      verifyWebhook({ payload: BODY, secret: SECRET, signature: '', timestamp: '' }),
    ).resolves.toBe(false)
  })
})

describe('shortcut for a standard Request', () => {
  it('validates and returns the raw body for whoever parses it later', async () => {
    const timestamp = Math.floor(Date.now() / 1000)

    const request = new Request('https://meu-sistema/hook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: assinarComoOServidor(BODY, SECRET, timestamp),
        [TIMESTAMP_HEADER]: String(timestamp),
      },
      body: BODY,
    })

    const { valid, payload } = await verifyWebhookRequest(request, SECRET)

    expect(valid).toBe(true)
    expect(payload).toBe(BODY)
    expect(JSON.parse(payload).event).toBe('message.received')
  })

  it('fails when the signature is missing', async () => {
    const request = new Request('https://meu-sistema/hook', { method: 'POST', body: BODY })
    const { valid } = await verifyWebhookRequest(request, SECRET)

    expect(valid).toBe(false)
  })
})
