import type { ReactNode } from 'react'
import { NavLink, useLocation, useSearchParams } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { type TranslationKey, useT } from '../i18n'
import { post } from '../lib/api'
import { windowLabel } from '../lib/format'
import { roleAtLeast, useMe } from '../lib/sessao'
import {
  IconeLua,
  IconeMonitor,
  IconeNegocio,
  IconePessoas,
  IconePulso,
  IconeSol,
  KeyIcon,
  PlugIcon,
  SessionIcon,
  SignOutIcon,
} from './icons'
import { LanguagePicker } from './LanguagePicker'
import { cx } from './ui'

/** The windows on offer. More than this is a menu; fewer is a limitation. */
export const WINDOWS = [
  { hours: 1, value: 1, unit: 'hour' },
  { hours: 6, value: 6, unit: 'hour' },
  { hours: 24, value: 24, unit: 'hour' },
  { hours: 168, value: 7, unit: 'day' },
  { hours: 720, value: 30, unit: 'day' },
] as const satisfies ReadonlyArray<{ hours: number; value: number; unit: 'hour' | 'day' }>

/**
 * The window and the session filter live in the URL.
 *
 * An operator who sees something odd sends the link to a colleague, and the
 * colleague opens exactly the same screen. Keeping this in component state
 * would turn every conversation about an incident into "click 7 days, then
 * filter by...".
 */
export function useFilter() {
  const [params, setParams] = useSearchParams()
  const bruto = Number(params.get('horas') ?? 24)
  const hours = WINDOWS.some((j) => j.hours === bruto) ? bruto : 24
  const session = params.get('sessao')

  return {
    hours: hours,
    session: session,
    setHours: (value: number) => {
      const next = new URLSearchParams(params)
      next.set('horas', String(value))
      setParams(next, { replace: true })
    },
    setSession: (value: string | null) => {
      const next = new URLSearchParams(params)
      if (value) next.set('sessao', value)
      else next.delete('sessao')
      setParams(next, { replace: true })
    },
    /** Suffix ready to append to the endpoint URL. */
    query: `hours=${hours}${session ? `&sessionId=${session}` : ''}`,
  }
}

interface Aba {
  to: string
  key: TranslationKey
  Icone: (props: { width?: number; height?: number }) => ReactNode
  /** Minimum role for the tab to exist. Absent, it applies to everyone. */
  floor?: 'admin'
}

const ABAS: Aba[] = [
  { to: '/operations', key: 'nav.operation', Icone: IconePulso },
  { to: '/business', key: 'nav.business', Icone: IconeNegocio },
  { to: '/sessions', key: 'nav.sessions', Icone: SessionIcon },
  { to: '/integrations', key: 'nav.integrations', Icone: PlugIcon },
  { to: '/keys', key: 'nav.keys', Icone: KeyIcon, floor: 'admin' },
  { to: '/users', key: 'nav.users', Icone: IconePessoas },
]

/**
 * The tabs this role can reach.
 *
 * Showing the keys tab to someone who will get a 403 on opening it is not
 * transparency, it is a door painted on the wall. Authorization stays with the
 * server.
 */
function useAbas() {
  const me = useMe()
  return ABAS.filter((aba) => !aba.floor || roleAtLeast(me.role, aba.floor))
}

export function Shell({ children, acoes }: { children: ReactNode; acoes?: ReactNode }) {
  return (
    <div className="min-h-dvh bg-ground">
      <div className="mx-auto flex w-full max-w-[1400px] px-3 sm:px-5">
        <Rail />
        <div className="min-w-0 flex-1 py-4 sm:pl-5">
          <CabecalhoMovel />
          <TopBar acoes={acoes} />
          <main className="mt-4 pb-12">{children}</main>
        </div>
      </div>
    </div>
  )
}

/**
 * Navigation on a phone.
 *
 * The side rail does not fit on a narrow screen, and hiding it with nothing in
 * its place would leave the other two tabs out of reach — the panel would
 * become a single screen for whoever opens it on a phone, which is exactly the
 * person who is out of the office with an incident on their hands.
 */
function CabecalhoMovel() {
  const { search } = useLocation()
  const abas = useAbas()
  const t = useT()

  return (
    <div className="chrome sticky top-0 z-20 -mx-3 mb-3 flex flex-col gap-3 px-3 py-3 sm:hidden">
      <div className="flex items-center justify-between">
        <Marca />
        <button
          type="button"
          onClick={async () => {
            await post('/v1/auth/logout').catch(() => undefined)
            window.location.assign('/entrar')
          }}
          className="flex items-center gap-1.5 text-xs text-muted"
        >
          <SignOutIcon width={14} height={14} />
          {t('common.signOut')}
        </button>
      </div>

      <nav aria-label={t('common.sections')} className="flex gap-1 overflow-x-auto">
        {abas.map(({ to, key, Icone }) => (
          <NavLink
            key={to}
            to={{ pathname: to, search }}
            className={({ isActive }) =>
              cx(
                'flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
                isActive
                  ? 'border border-accent/30 bg-accent-soft font-medium text-accent shadow-sm'
                  : 'border border-line/70 bg-surface/60 text-muted backdrop-blur-sm',
              )
            }
          >
            <Icone width={15} height={15} />
            {t(key)}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

function Rail() {
  const { search } = useLocation()
  const abas = useAbas()
  const t = useT()

  return (
    <nav
      aria-label={t('common.sections')}
      className="chrome sticky top-0 z-20 hidden h-dvh w-48 shrink-0 flex-col gap-1 border-e border-line/70 py-5 pe-4 sm:flex"
    >
      <div className="mb-5 px-2">
        <Marca />
      </div>

      {abas.map(({ to, key, Icone }) => (
        <NavLink
          key={to}
          to={{ pathname: to, search }}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
              isActive
                ? 'bg-accent-soft font-medium text-accent shadow-[inset_0_0_0_1px_rgb(var(--glass-edge))]'
                : 'text-muted hover:bg-surface-2/70 hover:text-ink',
            )
          }
        >
          <Icone />
          {t(key)}
        </NavLink>
      ))}

      <div className="mt-auto flex flex-col items-start gap-1 px-2.5">
        <a href="/docs" className="py-1.5 text-xs text-muted hover:text-ink">
          {t('common.apiDocs')}
        </a>
        <button
          type="button"
          onClick={async () => {
            await post('/v1/auth/logout').catch(() => undefined)
            window.location.assign('/entrar')
          }}
          className="flex items-center gap-2 py-1.5 text-xs text-muted hover:text-ink"
        >
          <SignOutIcon width={14} height={14} />
          {t('common.signOut')}
        </button>
      </div>
    </nav>
  )
}

export function Marca() {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-lg bg-accent font-mono text-[13px] font-medium text-on-fill"
      >
        A
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">AWAH</span>
    </span>
  )
}

function TopBar({ acoes }: { acoes?: ReactNode }) {
  const { hours, setHours } = useFilter()
  const t = useT()

  /*
   * On a phone the header is what sticks, because it carries the navigation.
   * If this bar stuck to the top as well it would land behind the header and
   * the filter would vanish on scroll. From `sm` up the header is gone and the
   * spot is free.
   */
  return (
    <div className="chrome -mx-3 flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-3 py-3 sm:sticky sm:top-0 sm:z-10 sm:-mx-5 sm:px-5">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset demands a visible legend and brings its own layout; these are toggle buttons, not form fields */}
        <div
          role="group"
          aria-label={t('common.timeWindow')}
          className="flex overflow-hidden rounded-lg border border-line/70 bg-surface/60 backdrop-blur-sm"
        >
          {WINDOWS.map((opcao) => (
            <button
              key={opcao.hours}
              type="button"
              onClick={() => setHours(opcao.hours)}
              aria-pressed={hours === opcao.hours}
              className={cx(
                'px-2.5 py-1.5 font-mono text-xs transition-colors',
                hours === opcao.hours
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'text-muted hover:text-ink',
              )}
            >
              {windowLabel(opcao.value, opcao.unit)}
            </button>
          ))}
        </div>
        {acoes}
      </div>

      <div className="flex items-center gap-2">
        <LanguagePicker />
        <ThemeToggle />
      </div>
    </div>
  )
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme()
  const t = useT()

  const options = [
    { value: 'light' as const, Icone: IconeSol, key: 'common.themeLight' as const },
    { value: 'system' as const, Icone: IconeMonitor, key: 'common.themeSystem' as const },
    { value: 'dark' as const, Icone: IconeLua, key: 'common.themeDark' as const },
  ]

  return (
    // biome-ignore lint/a11y/useSemanticElements: same reason as the window picker
    <div
      role="group"
      aria-label={t('common.theme')}
      className="flex overflow-hidden rounded-lg border border-line/70 bg-surface/60 backdrop-blur-sm"
    >
      {options.map(({ value, Icone, key }) => (
        <button
          key={value}
          type="button"
          title={t(key)}
          aria-label={t(key)}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={cx(
            'px-2 py-1.5 transition-colors',
            theme === value ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink',
          )}
        >
          <Icone width={15} height={15} />
        </button>
      ))}
    </div>
  )
}

/** Session picker, mounted by the screens that already have the list loaded. */
export function SessionFilter({ sessions }: { sessions: Array<{ id: string; name: string }> }) {
  const { session, setSession } = useFilter()
  const t = useT()

  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="sr-only">{t('common.filterBySession')}</span>
      <select
        value={session ?? ''}
        onChange={(evento) => setSession(evento.target.value || null)}
        className="rounded-lg border border-line/70 bg-surface/60 px-2 py-[7px] text-xs text-ink backdrop-blur-sm"
      >
        <option value="">{t('common.allSessions')}</option>
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  )
}
