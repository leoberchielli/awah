import { describe, expect, it } from 'vitest'
import { extractContent, isStatusAdvance, mapStatus, toDate } from '../src/engines/baileys/mapping'
import { exponentialBackoff } from '../src/lib/backoff'
import { applyRetention } from '../src/messaging/retention'

describe('mapeamento de ACK', () => {
  it('traduz os códigos do protocolo', () => {
    expect(mapStatus(2)).toBe('sent')
    expect(mapStatus(3)).toBe('delivered')
    expect(mapStatus(4)).toBe('read')
    expect(mapStatus(5)).toBe('played')
    expect(mapStatus(0)).toBe('failed')
  })

  it('ignora código ausente ou desconhecido', () => {
    expect(mapStatus(null)).toBeNull()
    expect(mapStatus(undefined)).toBeNull()
    expect(mapStatus(99)).toBeNull()
  })
})

describe('avanço de status', () => {
  /**
   * ACKs arrive out of order all the time. Without this rule, the dashboard
   * would show a message going backwards from read to delivered.
   */
  it('nunca regride', () => {
    expect(isStatusAdvance('read', 'delivered')).toBe(false)
    expect(isStatusAdvance('delivered', 'sent')).toBe(false)
    expect(isStatusAdvance('played', 'read')).toBe(false)
  })

  it('avança na ordem do protocolo', () => {
    expect(isStatusAdvance('pending', 'sent')).toBe(true)
    expect(isStatusAdvance('sent', 'delivered')).toBe(true)
    expect(isStatusAdvance('delivered', 'read')).toBe(true)
    expect(isStatusAdvance('read', 'played')).toBe(true)
  })

  it('não considera o mesmo status um avanço', () => {
    expect(isStatusAdvance('delivered', 'delivered')).toBe(false)
  })
})

describe('extração de conteúdo', () => {
  it('lê texto simples e estendido', () => {
    expect(extractContent({ conversation: 'oi' })).toEqual({ type: 'text', body: 'oi' })
    expect(extractContent({ extendedTextMessage: { text: 'link' } })).toEqual({
      type: 'text',
      body: 'link',
    })
  })

  it('usa a legenda da mídia como corpo', () => {
    expect(extractContent({ imageMessage: { caption: 'foto do produto' } })).toEqual({
      type: 'image',
      body: 'foto do produto',
    })
    expect(extractContent({ videoMessage: {} })).toEqual({ type: 'video', body: null })
  })

  it('cai no nome do arquivo quando o documento não tem legenda', () => {
    expect(extractContent({ documentMessage: { fileName: 'nota.pdf' } })).toEqual({
      type: 'document',
      body: 'nota.pdf',
    })
  })

  it('classifica o que não tem conteúdo textual', () => {
    expect(extractContent({ audioMessage: {} }).type).toBe('audio')
    expect(extractContent({ stickerMessage: {} }).type).toBe('sticker')
    expect(extractContent({ reactionMessage: { text: '👍' } })).toEqual({
      type: 'reaction',
      body: '👍',
    })
  })

  it('trata mensagem vazia ou de protocolo como sistema', () => {
    expect(extractContent(null)).toEqual({ type: 'system', body: null })
    expect(extractContent({})).toEqual({ type: 'system', body: null })
    expect(extractContent({ protocolMessage: {} }).type).toBe('system')
  })
})

describe('timestamp do protocolo', () => {
  it('converte segundos em data', () => {
    expect(toDate(1700000000).toISOString()).toBe('2023-11-14T22:13:20.000Z')
  })

  it('aceita Long do protobuf via valueOf', () => {
    expect(toDate({ toString: () => '1700000000', valueOf: () => 1700000000 }).getTime()).toBe(
      1700000000000,
    )
  })

  it('cai no nowMs quando o valor não presta', () => {
    for (const input of [null, undefined, 0, -5, Number.NaN]) {
      expect(toDate(input).getTime()).toBeGreaterThan(Date.now() - 5000)
    }
  })
})

describe('política de retenção', () => {
  const nowMs = new Date('2026-08-18T12:00:00Z')

  it('marca a data de expiração no padrão de 30 dias', () => {
    const result = applyRetention('conteúdo', 30, nowMs)
    expect(result.body).toBe('conteúdo')
    expect(result.contentExpiresAt?.toISOString()).toBe('2026-09-17T12:00:00.000Z')
  })

  /** Zero means never persist a body — the row is born with metadata only. */
  it('descarta o corpo quando a retenção é zero', () => {
    const result = applyRetention('sensível', 0, nowMs)
    expect(result.body).toBeNull()
    expect(result.contentExpiresAt).toBeNull()
  })

  it('retém para sempre com -1', () => {
    const result = applyRetention('conteúdo', -1, nowMs)
    expect(result.body).toBe('conteúdo')
    expect(result.contentExpiresAt).toBeNull()
  })

  it('preserva corpo nulo sem inventar conteúdo', () => {
    expect(applyRetention(null, 30, nowMs).body).toBeNull()
  })
})

describe('backoff exponencial', () => {
  const withoutJitter = () => 0

  it('dobra a cada tentativa', () => {
    const opts = { baseMs: 2000, capMs: 3_600_000, random: withoutJitter }
    expect(exponentialBackoff({ ...opts, attempt: 1 })).toBe(2000)
    expect(exponentialBackoff({ ...opts, attempt: 2 })).toBe(4000)
    expect(exponentialBackoff({ ...opts, attempt: 3 })).toBe(8000)
  })

  it('respeita o teto', () => {
    expect(
      exponentialBackoff({ attempt: 50, baseMs: 2000, capMs: 60_000, random: withoutJitter }),
    ).toBe(60_000)
  })

  it('soma jitter proporcional', () => {
    const opts = { attempt: 3, baseMs: 1000, capMs: 100_000 }
    expect(exponentialBackoff({ ...opts, random: () => 0 })).toBe(4000)
    expect(exponentialBackoff({ ...opts, random: () => 1 })).toBe(5000)
  })
})
