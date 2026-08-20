import type { ReactNode } from 'react'

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

const TONE_VAR = {
  accent: 'var(--accent)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  crit: 'var(--crit)',
  'data-1': 'var(--data-1)',
  'data-2': 'var(--data-2)',
  'data-3': 'var(--data-3)',
  'data-4': 'var(--data-4)',
} as const

export type CardTone = keyof typeof TONE_VAR

export function Card({
  title,
  hint,
  action,
  tone,
  children,
  className,
}: {
  title?: string
  hint?: string
  action?: ReactNode
  /** Draws a coloured rule along the top. Omit it for the ordinary card. */
  tone?: CardTone
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cx('card flex flex-col overflow-hidden', tone && 'card-tone', className)}
      style={tone ? ({ '--card-tone': TONE_VAR[tone] } as React.CSSProperties) : undefined}
    >
      {title && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-2.5">
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
 * A headline tile: one number, on a block of solid colour.
 *
 * The hue is the metric's own, from the series ramp, for as long as the metric
 * is inside its healthy band. When it leaves, `tone` overrides it with amber or
 * red. That join is deliberate: a wall of tiles whose colours never change is
 * decoration, and an operator learns within a week to stop reading it. These
 * change, so a glance is worth something.
 *
 * The watermark is the same icon the navigation uses for that area, so the tile
 * and the screen it leads to are recognisably the same thing.
 */
export function Tile({
  label,
  value,
  unit,
  hint,
  hue,
  tone = 'neutral',
  Icon,
}: {
  label: string
  value: string | number
  unit?: string
  hint?: string
  /** The metric's own colour, used while nothing is wrong. */
  hue: 'fill-1' | 'fill-2' | 'fill-3' | 'fill-4' | 'fill-hold'
  tone?: 'neutral' | 'ok' | 'warn' | 'crit'
  Icon: (props: { width?: number; height?: number }) => ReactNode
}) {
  /*
   * `ok` keeps the metric's own hue rather than turning everything green.
   * Five green tiles say exactly as little as five blue ones, and they spend
   * the colour that has to still mean something when it appears somewhere else.
   */
  const fill =
    tone === 'crit' ? 'var(--fill-crit)' : tone === 'warn' ? 'var(--fill-warn)' : `var(--${hue})`

  return (
    <div className="tile flex flex-col" style={{ '--tile': fill } as React.CSSProperties}>
      <div className="tile-mark">
        <Icon width={56} height={56} />
      </div>

      <div className="flex flex-1 flex-col gap-0.5 px-3 pt-3 pb-2">
        <span className="font-mono text-[30px] leading-none font-semibold tnum">
          {value}
          {unit && <span className="ml-0.5 text-lg opacity-80">{unit}</span>}
        </span>
        <span className="text-[13px] font-medium">{label}</span>
      </div>

      {hint && <div className="tile-foot">{hint}</div>}
    </div>
  )
}

/**
 * A big number with a label, on an ordinary surface.
 *
 * `tone` is not decoration: it is the reading from across the room. Whoever
 * walks past the monitor needs to know if something wants attention before
 * they can read the value.
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
  const color = {
    neutral: 'text-ink',
    ok: 'text-ok',
    warn: 'text-warn',
    crit: 'text-crit',
  }[tone]

  return (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <span className={cx('font-mono text-[26px] leading-none font-semibold tnum', color)}>
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

/** State as shape and colour, not colour alone — colour blindness is common among operators. */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-xs font-medium',
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
    <div className="flex min-h-24 items-center justify-center rounded border border-dashed border-line bg-surface-2 px-4 py-6 text-center text-sm text-muted">
      {children}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded bg-surface-2', className)} />
}
