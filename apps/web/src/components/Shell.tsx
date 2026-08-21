import type { ReactNode } from 'react'
import { NavLink, useLocation, useSearchParams } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { type TranslationKey, useT } from '../i18n'
import { post } from '../lib/api'
import { windowLabel } from '../lib/format'
import { roleAtLeast, useMe } from '../lib/session'
import {
  BusinessIcon,
  KeyIcon,
  MonitorIcon,
  MoonIcon,
  PeopleIcon,
  PlugIcon,
  PulseIcon,
  SessionIcon,
  SignOutIcon,
  SunIcon,
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

/** Width of the side bar. Referenced twice, so it lives in one place. */
const RAIL = 'sm:w-[232px]'
const RAIL_OFFSET = 'sm:ps-[232px]'

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
  const raw = Number(params.get('hours') ?? 24)
  const hours = WINDOWS.some((j) => j.hours === raw) ? raw : 24
  const session = params.get('session')

  return {
    hours: hours,
    session: session,
    setHours: (value: number) => {
      const next = new URLSearchParams(params)
      next.set('hours', String(value))
      setParams(next, { replace: true })
    },
    setSession: (value: string | null) => {
      const next = new URLSearchParams(params)
      if (value) next.set('session', value)
      else next.delete('session')
      setParams(next, { replace: true })
    },
    /** Suffix ready to append to the endpoint URL. */
    query: `hours=${hours}${session ? `&sessionId=${session}` : ''}`,
  }
}

interface Tab {
  to: string
  key: TranslationKey
  Icon: (props: { width?: number; height?: number }) => ReactNode
  /** Minimum role for the tab to exist. Absent, it applies to everyone. */
  floor?: 'admin'
}

const TABS: Tab[] = [
  { to: '/operations', key: 'nav.operation', Icon: PulseIcon },
  { to: '/business', key: 'nav.business', Icon: BusinessIcon },
  { to: '/sessions', key: 'nav.sessions', Icon: SessionIcon },
  { to: '/integrations', key: 'nav.integrations', Icon: PlugIcon },
  { to: '/keys', key: 'nav.keys', Icon: KeyIcon, floor: 'admin' },
  { to: '/users', key: 'nav.users', Icon: PeopleIcon },
]

/**
 * The tabs this role can reach.
 *
 * Showing the keys tab to someone who will get a 403 on opening it is not
 * transparency, it is a door painted on the wall. Authorization stays with the
 * server.
 */
function useTabs() {
  const me = useMe()
  return TABS.filter((tab) => !tab.floor || roleAtLeast(me.role, tab.floor))
}

async function signOut() {
  await post('/v1/auth/logout').catch(() => undefined)
  window.location.assign('/signin')
}

export function Shell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="min-h-dvh bg-ground">
      <Rail />
      <div className={cx('flex min-h-dvh min-w-0 flex-col', RAIL_OFFSET)}>
        <MobileHeader />
        <TopBar actions={actions} />
        <DemoBanner />
        <main className="flex-1 px-3 pt-4 pb-10 sm:px-5">{children}</main>
      </div>
    </div>
  )
}

/**
 * Says, on every screen, that these numbers came from a simulator.
 *
 * This is the price of running the fake engine on a public instance, and it is
 * worth paying: what makes a simulated engine dangerous is that nothing looks
 * wrong — sends are accepted, everything reports delivered, and the dashboard
 * is indistinguishable from one watching real phones. A line at the top of the
 * page is the difference between a demo and a trap.
 *
 * It renders nothing anywhere else, because `me.demo` is null anywhere else.
 */
function DemoBanner() {
  const me = useMe()
  const t = useT()

  if (!me.demo) return null

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-xs text-ink sm:px-5"
    >
      <span className="font-semibold uppercase tracking-wide text-warn">{t('demo.badge')}</span>
      <span className="text-muted">{t('demo.bannerEngine')}</span>
      {me.demo.resetMinutes > 0 && (
        <span className="text-muted">
          {t('demo.bannerReset', { minutes: me.demo.resetMinutes })}
        </span>
      )}
    </div>
  )
}

/**
 * The side bar.
 *
 * Dark in both themes, and the only dark thing on the screen in the light one.
 * That is what makes it read as chrome rather than as content: it frames the
 * data instead of taking part in it, and the eye stops treating it as
 * something to scan every time the page changes.
 */
function Rail() {
  const { search } = useLocation()
  const tabs = useTabs()
  const t = useT()

  return (
    <nav
      aria-label={t('common.sections')}
      className={cx(
        'fixed inset-y-0 start-0 z-30 hidden w-0 flex-col bg-nav sm:flex',
        'shadow-[1px_0_0_0_var(--color-nav-line)]',
        RAIL,
      )}
    >
      <div className="flex h-[52px] shrink-0 items-center border-b border-nav-line px-4">
        <Brand onDark />
      </div>

      <div className="flex-1 overflow-y-auto py-3">
        {tabs.map(({ to, key, Icon }) => (
          <NavLink
            key={to}
            to={{ pathname: to, search }}
            className={({ isActive }) =>
              cx(
                'mx-2 mb-0.5 flex items-center gap-3 rounded px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-accent font-medium text-on-fill shadow-sm'
                  : 'text-nav-ink hover:bg-nav-2 hover:text-nav-ink-strong',
              )
            }
          >
            <Icon width={17} height={17} />
            {t(key)}
          </NavLink>
        ))}
      </div>

      <div className="flex shrink-0 flex-col items-start gap-0.5 border-t border-nav-line px-4 py-3">
        <a href="/docs" className="py-1 text-xs text-nav-ink hover:text-nav-ink-strong">
          {t('common.apiDocs')}
        </a>
        <button
          type="button"
          onClick={signOut}
          className="flex items-center gap-2 py-1 text-xs text-nav-ink hover:text-nav-ink-strong"
        >
          <SignOutIcon width={14} height={14} />
          {t('common.signOut')}
        </button>
      </div>
    </nav>
  )
}

/**
 * Navigation on a phone.
 *
 * The side bar does not fit on a narrow screen, and hiding it with nothing in
 * its place would leave the other tabs out of reach — the panel would become a
 * single screen for whoever opens it on a phone, which is exactly the person
 * who is out of the office with an incident on their hands.
 */
function MobileHeader() {
  const { search } = useLocation()
  const tabs = useTabs()
  const t = useT()

  return (
    <div className="sticky top-0 z-20 flex flex-col gap-2 bg-nav px-3 py-2.5 sm:hidden">
      <div className="flex items-center justify-between">
        <Brand onDark />
        <button
          type="button"
          onClick={signOut}
          className="flex items-center gap-1.5 text-xs text-nav-ink"
        >
          <SignOutIcon width={14} height={14} />
          {t('common.signOut')}
        </button>
      </div>

      <nav aria-label={t('common.sections')} className="flex gap-1 overflow-x-auto">
        {tabs.map(({ to, key, Icon }) => (
          <NavLink
            key={to}
            to={{ pathname: to, search }}
            className={({ isActive }) =>
              cx(
                'flex shrink-0 items-center gap-2 rounded px-3 py-1.5 text-sm transition-colors',
                isActive
                  ? 'bg-accent font-medium text-on-fill'
                  : 'bg-nav-2 text-nav-ink hover:text-nav-ink-strong',
              )
            }
          >
            <Icon width={15} height={15} />
            {t(key)}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

export function Brand({ onDark = false }: { onDark?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid size-7 shrink-0 place-items-center rounded bg-accent font-mono text-[13px] font-medium text-on-fill"
      >
        A
      </span>
      <span
        className={cx(
          'text-[15px] font-semibold tracking-tight',
          onDark ? 'text-nav-ink-strong' : 'text-ink',
        )}
      >
        AWAH
      </span>
    </span>
  )
}

function TopBar({ actions }: { actions?: ReactNode }) {
  const { hours, setHours } = useFilter()
  const t = useT()

  /*
   * On a phone the header is what sticks, because it carries the navigation.
   * If this bar stuck to the top as well it would land behind the header and
   * the filter would vanish on scroll. From `sm` up the header is gone and the
   * spot is free.
   */
  return (
    <div className="chrome flex flex-wrap items-center justify-between gap-3 border-b border-line px-3 py-2.5 sm:sticky sm:top-0 sm:z-10 sm:min-h-[52px] sm:px-5">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset demands a visible legend and brings its own layout; these are toggle buttons, not form fields */}
        <div
          role="group"
          aria-label={t('common.timeWindow')}
          className="flex overflow-hidden rounded border border-line"
        >
          {WINDOWS.map((option) => (
            <button
              key={option.hours}
              type="button"
              onClick={() => setHours(option.hours)}
              aria-pressed={hours === option.hours}
              className={cx(
                'px-2.5 py-1.5 font-mono text-xs transition-colors',
                hours === option.hours
                  ? 'bg-accent font-medium text-on-fill'
                  : 'bg-surface text-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              {windowLabel(option.value, option.unit)}
            </button>
          ))}
        </div>
        {actions}
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
    { value: 'light' as const, Icon: SunIcon, key: 'common.themeLight' as const },
    { value: 'system' as const, Icon: MonitorIcon, key: 'common.themeSystem' as const },
    { value: 'dark' as const, Icon: MoonIcon, key: 'common.themeDark' as const },
  ]

  return (
    // biome-ignore lint/a11y/useSemanticElements: same reason as the window picker
    <div
      role="group"
      aria-label={t('common.theme')}
      className="flex overflow-hidden rounded border border-line"
    >
      {options.map(({ value, Icon, key }) => (
        <button
          key={value}
          type="button"
          title={t(key)}
          aria-label={t(key)}
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={cx(
            'px-2 py-1.5 transition-colors',
            theme === value
              ? 'bg-accent text-on-fill'
              : 'bg-surface text-muted hover:bg-surface-2 hover:text-ink',
          )}
        >
          <Icon width={15} height={15} />
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
        onChange={(event) => setSession(event.target.value || null)}
        className="rounded border border-line bg-surface px-2 py-[7px] text-xs text-ink"
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
