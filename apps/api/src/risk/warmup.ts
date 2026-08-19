import type { SessionLimits } from './limits'

/**
 * Curva de aquecimento de chip.
 *
 * Um número recém-pareado que dispara mil mensagens no primeiro dia é o padrão
 * mais óbvio de conta descartável, e é o que o WhatsApp derruba primeiro. A
 * curva libera volume conforme a sessão acumula idade: começa em 5% do teto e
 * chega a 100% em trinta dias.
 *
 * A rampa é interpolada entre marcos, não escalonada — degrau faria o volume
 * saltar de um dia para o outro, que é exatamente o tipo de variação brusca que
 * se quer evitar.
 */
const MILESTONES: Array<{ day: number; factor: number }> = [
  { day: 0, factor: 0.05 },
  { day: 1, factor: 0.1 },
  { day: 3, factor: 0.2 },
  { day: 7, factor: 0.4 },
  { day: 14, factor: 0.7 },
  { day: 30, factor: 1 },
]

/** Fator entre 0 e 1 aplicado aos tetos, conforme a idade em dias. */
export function warmupFactor(ageInDays: number): number {
  if (!Number.isFinite(ageInDays) || ageInDays <= 0) {
    return MILESTONES[0]?.factor ?? 0.05
  }

  const last = MILESTONES[MILESTONES.length - 1]
  if (!last) return 1
  if (ageInDays >= last.day) return last.factor

  for (let i = 0; i < MILESTONES.length - 1; i++) {
    const current = MILESTONES[i]
    const next = MILESTONES[i + 1]
    if (!current || !next) break

    if (ageInDays >= current.day && ageInDays < next.day) {
      const span = next.day - current.day
      const progress = (ageInDays - current.day) / span
      return current.factor + (next.factor - current.factor) * progress
    }
  }

  return last.factor
}

/**
 * Idade da sessão em dias fracionários. Sessão nunca pareada é tratada como
 * idade zero: sem pareamento não há histórico para justificar volume.
 */
export function sessionAgeInDays(pairedAt: Date | null, now: Date = new Date()): number {
  if (!pairedAt) return 0
  const elapsed = now.getTime() - pairedAt.getTime()
  return elapsed <= 0 ? 0 : elapsed / (24 * 60 * 60 * 1000)
}

/**
 * Limites efetivos depois do warmup.
 *
 * O mínimo de 1 existe para que uma sessão recém-pareada não fique com teto
 * zero e trave completamente — ela envia pouco, mas envia.
 */
export function applyWarmup(limits: SessionLimits, ageInDays: number): SessionLimits {
  const factor = warmupFactor(ageInDays)
  const scale = (value: number) => Math.max(1, Math.floor(value * factor))

  return {
    perMinute: scale(limits.perMinute),
    perHour: scale(limits.perHour),
    perDay: scale(limits.perDay),
    newContactsPerDay: scale(limits.newContactsPerDay),
  }
}
