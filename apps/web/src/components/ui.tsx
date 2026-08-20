import type { ReactNode } from 'react'

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

export function Card({
  title,
  hint,
  action,
  children,
  className,
}: {
  title?: string
  hint?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cx('card flex flex-col overflow-hidden', className)}>
      {title && (
        <header className="flex items-start justify-between gap-3 border-b border-line/60 px-4 py-3">
          <div>
            <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
            {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="flex-1 p-4">{children}</div>
    </section>
  )
}

/**
 * Número grande com rótulo.
 *
 * O `tone` não é enfeite: ele é a leitura de longe. Quem passa pelo monitor
 * precisa saber se algo pede atenção antes de conseguir ler o valor.
 */
export function Stat({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string | number
  unit?: string
  hint?: string
  tone?: 'neutral' | 'ok' | 'warn' | 'crit'
}) {
  const cor = {
    neutral: 'text-ink',
    ok: 'text-ok',
    warn: 'text-warn',
    crit: 'text-crit',
  }[tone]

  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span className={cx('stat-glow font-mono text-[26px] leading-none font-semibold tnum', cor)}>
        {value}
        {unit && <span className="ml-1 text-sm text-muted">{unit}</span>}
      </span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  )
}

const TONES = {
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  hold: 'text-hold',
} as const

export type Tone = keyof typeof TONES

/** Estado como forma e cor, não só cor — daltonismo é comum entre operadores. */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border border-line/70 bg-surface-2/70 px-2.5 py-0.5 text-xs font-medium',
        TONES[tone],
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-24 items-center justify-center rounded-xl border border-dashed border-line/80 bg-surface/30 px-4 py-6 text-center text-sm text-muted">
      {children}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-lg bg-surface-2/70', className)} />
}
