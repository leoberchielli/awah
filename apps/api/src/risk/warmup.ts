import type { SessionLimits } from './limits'

/**
 * Number warm-up curve.
 *
 * A freshly paired number that blasts a thousand messages on day one is the
 * most obvious throwaway-account pattern there is, and it is the first thing
 * WhatsApp takes down. The curve releases volume as the session ages: it starts
 * at 5% of the cap and reaches 100% in thirty days.
 *
 * The ramp is interpolated between milestones, not stepped — a step would make
 * volume jump from one day to the next, which is exactly the kind of abrupt
 * change we are trying to avoid.
 */
const MILESTONES: Array<{ day: number; factor: number }> = [
  { day: 0, factor: 0.05 },
  { day: 1, factor: 0.1 },
  { day: 3, factor: 0.2 },
  { day: 7, factor: 0.4 },
  { day: 14, factor: 0.7 },
  { day: 30, factor: 1 },
]

/** Factor between 0 and 1 applied to the caps, based on age in days. */
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
 * Session age in fractional days. A session that was never paired is treated as
 * age zero: without pairing there is no history to justify volume.
 */
export function sessionAgeInDays(pairedAt: Date | null, now: Date = new Date()): number {
  if (!pairedAt) return 0
  const elapsed = now.getTime() - pairedAt.getTime()
  return elapsed <= 0 ? 0 : elapsed / (24 * 60 * 60 * 1000)
}

/**
 * Effective limits after warm-up.
 *
 * The floor of 1 exists so a freshly paired session does not end up with a cap
 * of zero and lock up completely — it sends little, but it sends.
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
