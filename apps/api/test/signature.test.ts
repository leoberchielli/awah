import { describe, expect, it } from 'vitest'
import { sign, verify } from '../src/webhooks/signature'

const secret = 'segredo-de-teste'
const payload = JSON.stringify({ event: 'message.received', data: { text: 'oi' } })
const nowSeconds = Math.floor(Date.now() / 1000)

describe('assinatura de webhook', () => {
  it('valida a própria assinatura', () => {
    const signature = sign(payload, secret, nowSeconds)
    expect(verify({ payload, secret, signature, timestamp: nowSeconds })).toBe(true)
  })

  it('rejeita segredo errado', () => {
    const signature = sign(payload, secret, nowSeconds)
    expect(verify({ payload, secret: 'outro', signature, timestamp: nowSeconds })).toBe(false)
  })

  it('rejeita corpo adulterado', () => {
    const signature = sign(payload, secret, nowSeconds)
    const adulterado = payload.replace('oi', 'tchau')
    expect(verify({ payload: adulterado, secret, signature, timestamp: nowSeconds })).toBe(false)
  })

  /**
   * The timestamp is part of what gets signed for exactly this reason: a
   * captured delivery cannot be replayed later, because moving the timestamp
   * to escape the window invalidates the signature.
   */
  it('rejeita entrega antiga, mesmo com assinatura correta', () => {
    const oldest = nowSeconds - 3600
    const signature = sign(payload, secret, oldest)

    expect(verify({ payload, secret, signature, timestamp: oldest })).toBe(false)
    // Inside the configured window, the same signature passes.
    expect(verify({ payload, secret, signature, timestamp: oldest, toleranceSeconds: 7200 })).toBe(
      true,
    )
  })

  it('rejeita timestamp trocado sem reassinar', () => {
    const signature = sign(payload, secret, nowSeconds)
    expect(verify({ payload, secret, signature, timestamp: nowSeconds + 10 })).toBe(false)
  })

  it('rejeita timestamp muito no futuro', () => {
    const future = nowSeconds + 3600
    const signature = sign(payload, secret, future)
    expect(verify({ payload, secret, signature, timestamp: future })).toBe(false)
  })

  it('não estoura com assinatura de tamanho diferente', () => {
    expect(verify({ payload, secret, signature: 'curta', timestamp: nowSeconds })).toBe(false)
    expect(verify({ payload, secret, signature: '', timestamp: nowSeconds })).toBe(false)
  })

  it('usa o prefixo do algoritmo', () => {
    expect(sign(payload, secret, nowSeconds)).toMatch(/^sha256=[0-9a-f]{64}$/)
  })
})
