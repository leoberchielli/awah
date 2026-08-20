import { describe, expect, it } from 'vitest'
import {
  describeDisconnect,
  reconnectDelayMs,
  statusCodeFromError,
} from '../src/engines/disconnect'

describe('tradução de códigos de desconexão', () => {
  it('separa queda passageira de credencial morta', () => {
    // 428 e 408 voltam sozinhos; 401 e 500 exigem parear de novo.
    expect(describeDisconnect(428).shouldReconnect).toBe(true)
    expect(describeDisconnect(408).shouldReconnect).toBe(true)
    expect(describeDisconnect(401).shouldReconnect).toBe(false)
    expect(describeDisconnect(401).loggedOut).toBe(true)
    expect(describeDisconnect(500).loggedOut).toBe(true)
  })

  /**
   * 440 é o código que mais confunde na prática: a sessão foi assumida em outro
   * lugar. Reconectar em laço faz as duas pontas se derrubarem alternadamente,
   * então este caso precisa continuar não-reconectável.
   */
  it('não reconecta quando a sessão foi assumida em outro lugar', () => {
    const info = describeDisconnect(440)
    expect(info.shouldReconnect).toBe(false)
    expect(info.loggedOut).toBe(false)
    expect(info.cause).toMatch(/elsewhere/i)
  })

  it('trata 515 como reinício esperado, não como falha', () => {
    const info = describeDisconnect(515)
    expect(info.shouldReconnect).toBe(true)
    expect(info.loggedOut).toBe(false)
  })

  it('não reconecta quando o acesso foi negado', () => {
    expect(describeDisconnect(403).shouldReconnect).toBe(false)
  })

  it('cai no genérico com código desconhecido ou ausente', () => {
    expect(describeDisconnect(null).cause).toMatch(/unknown/i)
    expect(describeDisconnect(undefined).cause).toMatch(/unknown/i)
    expect(describeDisconnect(999).cause).toMatch(/unknown/i)
    // O genérico tenta reconectar: a alternativa é derrubar sessão boa por código novo.
    expect(describeDisconnect(999).shouldReconnect).toBe(true)
  })

  it('sempre traz causa e orientação preenchidas', () => {
    for (const code of [401, 403, 408, 411, 428, 440, 500, 503, 515, 999]) {
      const info = describeDisconnect(code)
      expect(info.cause.length).toBeGreaterThan(0)
      expect(info.guidance.length).toBeGreaterThan(0)
    }
  })
})

describe('extração do código de erro', () => {
  it('lê o formato do Boom, usado pelo Baileys', () => {
    expect(statusCodeFromError({ output: { statusCode: 428 } })).toBe(428)
  })

  it('aceita statusCode na raiz', () => {
    expect(statusCodeFromError({ statusCode: 515 })).toBe(515)
  })

  it('devolve null para o que não carrega código', () => {
    expect(statusCodeFromError(new Error('sem código'))).toBeNull()
    expect(statusCodeFromError(null)).toBeNull()
    expect(statusCodeFromError(undefined)).toBeNull()
    expect(statusCodeFromError('texto')).toBeNull()
    expect(statusCodeFromError({ output: { statusCode: 'nao-numero' } })).toBeNull()
  })
})

describe('espera entre reconexões', () => {
  it('cresce exponencialmente', () => {
    const semJitter = () => 0
    expect(reconnectDelayMs(1, semJitter)).toBe(1000)
    expect(reconnectDelayMs(2, semJitter)).toBe(2000)
    expect(reconnectDelayMs(3, semJitter)).toBe(4000)
    expect(reconnectDelayMs(5, semJitter)).toBe(16000)
  })

  it('para de crescer em 5 minutos', () => {
    expect(reconnectDelayMs(20, () => 0)).toBe(300_000)
    expect(reconnectDelayMs(50, () => 0)).toBe(300_000)
  })

  /**
   * Sem jitter, todas as sessões que caem juntas — queda de rede do host —
   * voltam no mesmo milissegundo e repetem a rajada a cada ciclo.
   */
  it('espalha as tentativas com jitter de até 25%', () => {
    expect(reconnectDelayMs(3, () => 0)).toBe(4000)
    expect(reconnectDelayMs(3, () => 1)).toBe(5000)
    expect(reconnectDelayMs(3, () => 0.5)).toBe(4500)
  })

  it('trata tentativa zero ou negativa sem quebrar', () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(1000)
    expect(reconnectDelayMs(-5, () => 0)).toBe(1000)
  })
})
