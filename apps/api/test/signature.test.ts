import { describe, expect, it } from 'vitest'
import { sign, verify } from '../src/webhooks/signature'

const secret = 'segredo-de-teste'
const payload = JSON.stringify({ event: 'message.received', data: { text: 'oi' } })
const agora = Math.floor(Date.now() / 1000)

describe('assinatura de webhook', () => {
  it('valida a própria assinatura', () => {
    const signature = sign(payload, secret, agora)
    expect(verify({ payload, secret, signature, timestamp: agora })).toBe(true)
  })

  it('rejeita segredo errado', () => {
    const signature = sign(payload, secret, agora)
    expect(verify({ payload, secret: 'outro', signature, timestamp: agora })).toBe(false)
  })

  it('rejeita corpo adulterado', () => {
    const signature = sign(payload, secret, agora)
    const adulterado = payload.replace('oi', 'tchau')
    expect(verify({ payload: adulterado, secret, signature, timestamp: agora })).toBe(false)
  })

  /**
   * The timestamp is part of what gets signed for exactly this reason: a
   * captured delivery cannot be replayed later, because moving the timestamp
   * to escape the window invalidates the signature.
   */
  it('rejeita entrega antiga, mesmo com assinatura correta', () => {
    const oldest = agora - 3600
    const signature = sign(payload, secret, oldest)

    expect(verify({ payload, secret, signature, timestamp: oldest })).toBe(false)
    // Inside the configured window, the same signature passes.
    expect(verify({ payload, secret, signature, timestamp: oldest, toleranceSeconds: 7200 })).toBe(
      true,
    )
  })

  it('rejeita timestamp trocado sem reassinar', () => {
    const signature = sign(payload, secret, agora)
    expect(verify({ payload, secret, signature, timestamp: agora + 10 })).toBe(false)
  })

  it('rejeita timestamp muito no futuro', () => {
    const futuro = agora + 3600
    const signature = sign(payload, secret, futuro)
    expect(verify({ payload, secret, signature, timestamp: futuro })).toBe(false)
  })

  it('não estoura com assinatura de tamanho diferente', () => {
    expect(verify({ payload, secret, signature: 'curta', timestamp: agora })).toBe(false)
    expect(verify({ payload, secret, signature: '', timestamp: agora })).toBe(false)
  })

  it('usa o prefixo do algoritmo', () => {
    expect(sign(payload, secret, agora)).toMatch(/^sha256=[0-9a-f]{64}$/)
  })
})
