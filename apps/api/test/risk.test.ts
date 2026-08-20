import { describe, expect, it } from 'vitest'
import { humanDelayMs, logNormal, typingDurationMs } from '../src/risk/jitter'
import { DEFAULT_LIMITS, resolveLimits } from '../src/risk/limits'
import { computeScore, throttleFactor } from '../src/risk/score'
import { applyWarmup, sessionAgeInDays, warmupFactor } from '../src/risk/warmup'

describe('curva de warmup', () => {
  it('começa muito restrita e chega ao teto em 30 dias', () => {
    expect(warmupFactor(0)).toBe(0.05)
    expect(warmupFactor(30)).toBe(1)
    expect(warmupFactor(60)).toBe(1)
  })

  it('sobe de forma monotônica', () => {
    let anterior = 0
    for (const dia of [0, 1, 3, 7, 14, 21, 30]) {
      const atual = warmupFactor(dia)
      expect(atual).toBeGreaterThanOrEqual(anterior)
      anterior = atual
    }
  })

  /** An interpolated ramp, not a step: volume must not jump from one day to the next. */
  it('interpola entre os marcos', () => {
    const meio = warmupFactor(2)
    expect(meio).toBeGreaterThan(warmupFactor(1))
    expect(meio).toBeLessThan(warmupFactor(3))
  })

  it('trata idade inválida como sessão nova', () => {
    expect(warmupFactor(-5)).toBe(0.05)
    expect(warmupFactor(Number.NaN)).toBe(0.05)
  })

  /** A zero cap would freeze the session entirely; it sends little, but it sends. */
  it('nunca zera os limites', () => {
    const limites = applyWarmup(DEFAULT_LIMITS, 0)
    expect(limites.perMinute).toBeGreaterThanOrEqual(1)
    expect(limites.perDay).toBeGreaterThanOrEqual(1)
    expect(limites.newContactsPerDay).toBeGreaterThanOrEqual(1)
  })

  it('libera o teto cheio quando a sessão amadurece', () => {
    expect(applyWarmup(DEFAULT_LIMITS, 30)).toEqual(DEFAULT_LIMITS)
  })

  it('chip novo envia muito menos que chip maduro', () => {
    expect(applyWarmup(DEFAULT_LIMITS, 0).perDay).toBeLessThan(
      applyWarmup(DEFAULT_LIMITS, 30).perDay / 10,
    )
  })
})

describe('idade da sessão', () => {
  const agora = new Date('2026-08-18T12:00:00Z')

  it('conta em dias fracionários', () => {
    expect(sessionAgeInDays(new Date('2026-08-17T12:00:00Z'), agora)).toBe(1)
    expect(sessionAgeInDays(new Date('2026-08-18T00:00:00Z'), agora)).toBe(0.5)
  })

  /** With no pairing there is no history to justify volume. */
  it('sessão nunca pareada tem idade zero', () => {
    expect(sessionAgeInDays(null, agora)).toBe(0)
  })

  it('data futura não vira idade negativa', () => {
    expect(sessionAgeInDays(new Date('2026-09-01T00:00:00Z'), agora)).toBe(0)
  })
})

describe('limites por sessão', () => {
  it('cai nos defaults sem configuração', () => {
    expect(resolveLimits(null)).toEqual(DEFAULT_LIMITS)
    expect(resolveLimits({})).toEqual(DEFAULT_LIMITS)
    expect(resolveLimits({ limits: 'não é objeto' })).toEqual(DEFAULT_LIMITS)
  })

  it('aceita override parcial', () => {
    const limites = resolveLimits({ limits: { perMinute: 30 } })
    expect(limites.perMinute).toBe(30)
    expect(limites.perHour).toBe(DEFAULT_LIMITS.perHour)
  })

  /** A corrupted config must never unlock the limit. */
  it('ignora valores inválidos e mantém o conservador', () => {
    const limites = resolveLimits({
      limits: { perMinute: -5, perHour: 0, perDay: 'muitos', newContactsPerDay: Number.NaN },
    })
    expect(limites).toEqual(DEFAULT_LIMITS)
  })
})

describe('score de risco', () => {
  const base = {
    outbound24h: 0,
    inbound24h: 0,
    newContacts24h: 0,
    newContactsLimit: 100,
    deliveryFailureRate: 0,
    minuteUsage: 0,
    minuteLimit: 12,
  }

  it('sessão parada tem score zero', () => {
    expect(computeScore(base).value).toBe(0)
  })

  it('conversa equilibrada mantém score baixo', () => {
    const score = computeScore({ ...base, outbound24h: 100, inbound24h: 90 })
    expect(score.value).toBeLessThan(20)
  })

  /** The strongest signal: people talk both ways, a bot only talks. */
  it('penaliza conversa unilateral', () => {
    const unilateral = computeScore({ ...base, outbound24h: 500, inbound24h: 2 })
    const equilibrada = computeScore({ ...base, outbound24h: 500, inbound24h: 400 })
    expect(unilateral.value).toBeGreaterThan(equilibrada.value + 25)
  })

  /** Low volume is not blasting, even with no replies — 5 messages unanswered is normal. */
  it('não pune volume pequeno sem resposta', () => {
    const fator = computeScore({ ...base, outbound24h: 5, inbound24h: 0 }).factors.find(
      (f) => f.name === 'conversa_unilateral',
    )
    expect(fator?.points).toBe(0)
  })

  it('penaliza muitos contatos novos', () => {
    const score = computeScore({ ...base, newContacts24h: 100, newContactsLimit: 100 })
    const fator = score.factors.find((f) => f.name === 'contatos_novos')
    expect(fator?.points).toBe(25)
  })

  it('penaliza falha de entrega alta', () => {
    const score = computeScore({ ...base, outbound24h: 100, deliveryFailureRate: 0.3 })
    const fator = score.factors.find((f) => f.name === 'falha_de_entrega')
    expect(fator?.points).toBe(25)
  })

  it('nunca ultrapassa 100', () => {
    const pior = computeScore({
      outbound24h: 5000,
      inbound24h: 0,
      newContacts24h: 500,
      newContactsLimit: 100,
      deliveryFailureRate: 1,
      minuteUsage: 50,
      minuteLimit: 12,
    })
    expect(pior.value).toBeLessThanOrEqual(100)
    expect(pior.value).toBeGreaterThan(80)
  })

  /** A bare number from 0 to 100 helps nobody decide what to change. */
  it('explica cada fator', () => {
    const score = computeScore({ ...base, outbound24h: 200, inbound24h: 5 })
    expect(score.factors).toHaveLength(4)
    for (const fator of score.factors) {
      expect(fator.detail.length).toBeGreaterThan(0)
      expect(fator.points).toBeLessThanOrEqual(fator.max)
    }
  })
})

describe('freio adaptativo', () => {
  it('não interfere em comportamento normal', () => {
    expect(throttleFactor(0)).toBe(1)
    expect(throttleFactor(39)).toBe(1)
  })

  it('aperta progressivamente conforme o score sobe', () => {
    expect(throttleFactor(55)).toBeLessThan(1)
    expect(throttleFactor(75)).toBeLessThan(throttleFactor(55))
    expect(throttleFactor(95)).toBeLessThan(throttleFactor(75))
  })

  /** §2 settled it: the engine regulates, never blocks — a session never fully stops. */
  it('nunca chega a zero', () => {
    expect(throttleFactor(100)).toBeGreaterThan(0)
  })
})

describe('jitter humano', () => {
  it('respeita o piso e o teto', () => {
    for (let i = 0; i < 200; i++) {
      const atraso = humanDelayMs()
      expect(atraso).toBeGreaterThanOrEqual(250)
      expect(atraso).toBeLessThanOrEqual(120_000)
    }
  })

  it('fica perto da mediana com sorte neutra', () => {
    // random = 0.5 on both draws returns a z close to zero.
    const atraso = humanDelayMs({ medianMs: 3000, random: () => 0.5 })
    expect(atraso).toBeGreaterThan(1500)
    expect(atraso).toBeLessThan(6000)
  })

  it('o freio do score aumenta a espera', () => {
    const normal = humanDelayMs({ throttleFactor: 1, random: () => 0.5 })
    const freado = humanDelayMs({ throttleFactor: 0.25, random: () => 0.5 })
    expect(freado).toBeGreaterThan(normal * 3)
  })

  /** A uniform interval would produce a regular pattern — exactly what we avoid. */
  it('produz valores variados', () => {
    const amostras = new Set(Array.from({ length: 50 }, () => humanDelayMs()))
    expect(amostras.size).toBeGreaterThan(40)
  })

  it('log-normal só devolve positivos', () => {
    for (let i = 0; i < 100; i++) {
      expect(logNormal(3000, 0.55, Math.random)).toBeGreaterThan(0)
    }
  })
})

describe('tempo de digitação', () => {
  it('cresce com o tamanho do texto', () => {
    expect(typingDurationMs(500)).toBeGreaterThan(typingDurationMs(20))
  })

  it('respeita piso e teto', () => {
    expect(typingDurationMs(0)).toBe(700)
    expect(typingDurationMs(100_000)).toBe(9000)
  })

  it('usa ritmo plausível de digitação', () => {
    // 180 characters at ~18 per second land near ten seconds, clamped to the cap.
    expect(typingDurationMs(180)).toBeGreaterThan(5000)
  })
})
