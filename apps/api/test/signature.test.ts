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
   * O timestamp entra no que é assinado justamente para isto: uma entrega
   * capturada não pode ser reenviada depois, porque mudar o timestamp para
   * escapar da janela invalida a assinatura.
   */
  it('rejeita entrega antiga, mesmo com assinatura correta', () => {
    const antigo = agora - 3600
    const signature = sign(payload, secret, antigo)

    expect(verify({ payload, secret, signature, timestamp: antigo })).toBe(false)
    // Dentro da janela configurada, a mesma assinatura passa.
    expect(verify({ payload, secret, signature, timestamp: antigo, toleranceSeconds: 7200 })).toBe(
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
