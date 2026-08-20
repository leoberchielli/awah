import { describe, expect, it } from 'vitest'
import { extractContent, isStatusAdvance, mapStatus, toDate } from '../src/engines/baileys/mapping'
import { exponentialBackoff } from '../src/lib/backoff'
import { applyRetention } from '../src/messaging/retention'

describe('ACK mapping', () => {
  it('translates the protocol codes', () => {
    expect(mapStatus(2)).toBe('sent')
    expect(mapStatus(3)).toBe('delivered')
    expect(mapStatus(4)).toBe('read')
    expect(mapStatus(5)).toBe('played')
    expect(mapStatus(0)).toBe('failed')
  })

  it('ignores a missing or unknown code', () => {
    expect(mapStatus(null)).toBeNull()
    expect(mapStatus(undefined)).toBeNull()
    expect(mapStatus(99)).toBeNull()
  })
})

describe('status advance', () => {
  /**
   * ACKs arrive out of order all the time. Without this rule, the dashboard
   * would show a message going backwards from read to delivered.
   */
  it('never goes backwards', () => {
    expect(isStatusAdvance('read', 'delivered')).toBe(false)
    expect(isStatusAdvance('delivered', 'sent')).toBe(false)
    expect(isStatusAdvance('played', 'read')).toBe(false)
  })

  it('advances in the protocol order', () => {
    expect(isStatusAdvance('pending', 'sent')).toBe(true)
    expect(isStatusAdvance('sent', 'delivered')).toBe(true)
    expect(isStatusAdvance('delivered', 'read')).toBe(true)
    expect(isStatusAdvance('read', 'played')).toBe(true)
  })

  it('does not count the same status as an advance', () => {
    expect(isStatusAdvance('delivered', 'delivered')).toBe(false)
  })
})

describe('content extraction', () => {
  it('reads plain and extended text', () => {
    expect(extractContent({ conversation: 'hi' })).toEqual({ type: 'text', body: 'hi' })
    expect(extractContent({ extendedTextMessage: { text: 'link' } })).toEqual({
      type: 'text',
      body: 'link',
    })
  })

  it('uses the media caption as the body', () => {
    expect(extractContent({ imageMessage: { caption: 'foto do produto' } })).toEqual({
      type: 'image',
      body: 'foto do produto',
    })
    expect(extractContent({ videoMessage: {} })).toEqual({ type: 'video', body: null })
  })

  it('falls back to the file name when the document has no caption', () => {
    expect(extractContent({ documentMessage: { fileName: 'nota.pdf' } })).toEqual({
      type: 'document',
      body: 'nota.pdf',
    })
  })

  it('classifies what has no textual content', () => {
    expect(extractContent({ audioMessage: {} }).type).toBe('audio')
    expect(extractContent({ stickerMessage: {} }).type).toBe('sticker')
    expect(extractContent({ reactionMessage: { text: '👍' } })).toEqual({
      type: 'reaction',
      body: '👍',
    })
  })

  it('treats an empty or protocol message as system', () => {
    expect(extractContent(null)).toEqual({ type: 'system', body: null })
    expect(extractContent({})).toEqual({ type: 'system', body: null })
    expect(extractContent({ protocolMessage: {} }).type).toBe('system')
  })
})

describe('protocol timestamp', () => {
  it('converts seconds into a date', () => {
    expect(toDate(1700000000).toISOString()).toBe('2023-11-14T22:13:20.000Z')
  })

  it('accepts a protobuf Long via valueOf', () => {
    expect(toDate({ toString: () => '1700000000', valueOf: () => 1700000000 }).getTime()).toBe(
      1700000000000,
    )
  })

  it('falls back to nowMs when the value is no good', () => {
    for (const input of [null, undefined, 0, -5, Number.NaN]) {
      expect(toDate(input).getTime()).toBeGreaterThan(Date.now() - 5000)
    }
  })
})

describe('retention policy', () => {
  const nowMs = new Date('2026-08-18T12:00:00Z')

  it('marks the expiry date on the 30-day default', () => {
    const result = applyRetention('content', 30, nowMs)
    expect(result.body).toBe('content')
    expect(result.contentExpiresAt?.toISOString()).toBe('2026-09-17T12:00:00.000Z')
  })

  /** Zero means never persist a body — the row is born with metadata only. */
  it('drops the body when retention is zero', () => {
    const result = applyRetention('sensitive', 0, nowMs)
    expect(result.body).toBeNull()
    expect(result.contentExpiresAt).toBeNull()
  })

  it('retains forever with -1', () => {
    const result = applyRetention('content', -1, nowMs)
    expect(result.body).toBe('content')
    expect(result.contentExpiresAt).toBeNull()
  })

  it('preserves a null body without inventing content', () => {
    expect(applyRetention(null, 30, nowMs).body).toBeNull()
  })
})

describe('exponential backoff', () => {
  const withoutJitter = () => 0

  it('doubles on each attempt', () => {
    const opts = { baseMs: 2000, capMs: 3_600_000, random: withoutJitter }
    expect(exponentialBackoff({ ...opts, attempt: 1 })).toBe(2000)
    expect(exponentialBackoff({ ...opts, attempt: 2 })).toBe(4000)
    expect(exponentialBackoff({ ...opts, attempt: 3 })).toBe(8000)
  })

  it('respects the cap', () => {
    expect(
      exponentialBackoff({ attempt: 50, baseMs: 2000, capMs: 60_000, random: withoutJitter }),
    ).toBe(60_000)
  })

  it('adds proportional jitter', () => {
    const opts = { attempt: 3, baseMs: 1000, capMs: 100_000 }
    expect(exponentialBackoff({ ...opts, random: () => 0 })).toBe(4000)
    expect(exponentialBackoff({ ...opts, random: () => 1 })).toBe(5000)
  })
})
