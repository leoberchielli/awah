import { type FormEvent, useState } from 'react'
import { Shell } from '../components/Shell'
import { Card, cx, Empty, Pill, Skeleton, Stat, type Tone } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import { Rich, type Translate, type TranslationKey, useT } from '../i18n'
import type { QrResponse, RiskSnapshot, SessionEvent, SessionRow } from '../lib/api'
import { ApiError, post } from '../lib/api'
import { dateTime, num, pct, phone, since } from '../lib/format'
import { statusLabel, statusTone } from '../lib/sessionStatus'

const ENGINES: Array<{ value: string; label: TranslationKey }> = [
  { value: 'baileys', label: 'engine.baileys' },
  { value: 'cloud_api', label: 'engine.cloudApi' },
]

const PAIRING_STATUSES = ['pairing', 'connecting']

export function Sessions() {
  const t = useT()
  const [selected, setSelected] = useState<string | null>(null)
  const sessions = useQuery<{ sessions: SessionRow[] }>('/v1/sessions', 4000)
  const list = sessions.data?.sessions ?? []

  const selectedSession = list.find((s) => s.id === selected) ?? null

  /**
   * A session waiting for a QR takes the whole screen, with nobody having to
   * click it.
   *
   * The code expires in seconds and the phone is in the operator's hand: it is
   * the one moment when the screen has exactly one thing to do. Leaving the QR
   * hidden behind a selection — as it was — makes the most important step in
   * the product invisible to whoever just pressed "Start".
   */
  const pairing = list.find((s) => PAIRING_STATUSES.includes(s.status)) ?? null

  return (
    <Shell>
      <div className="flex flex-col gap-4">
        {pairing && <PairingCard session={pairing} onChange={sessions.refetch} />}

        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="flex min-w-0 flex-col gap-4">
            <Card
              title={t('sessions.title')}
              hint={t('sessions.hint')}
              action={<NewSession onCreate={sessions.refetch} />}
            >
              {!sessions.settled ? (
                <Skeleton className="h-32" />
              ) : list.length === 0 ? (
                <Empty>
                  <Rich text={t('sessions.empty')} />
                </Empty>
              ) : (
                <ul className="flex flex-col">
                  {list.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      selected={session.id === selected}
                      onSelect={() => setSelected(session.id === selected ? null : session.id)}
                      onStart={() => setSelected(session.id)}
                      onChange={sessions.refetch}
                    />
                  ))}
                </ul>
              )}
            </Card>

            {selectedSession && <Timeline sessionId={selectedSession.id} />}
          </div>

          <div className="flex flex-col gap-4">
            {selectedSession ? (
              <RiskPanel sessionId={selectedSession.id} />
            ) : (
              <Card title={t('sessions.detail')}>
                <Empty>{t('sessions.detailEmpty')}</Empty>
              </Card>
            )}
          </div>
        </div>
      </div>
    </Shell>
  )
}

/** The pairing step, with the QR and what to do on the phone side by side. */
function PairingCard({ session, onChange }: { session: SessionRow; onChange: () => void }) {
  const t = useT()

  return (
    <Card
      title={t('pairing.title', { name: session.name })}
      hint={t('pairing.hint')}
      action={<Pill tone="warn">{statusLabel(t, session.status)}</Pill>}
    >
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <QrPanel sessionId={session.id} />

        <ol className="flex flex-1 flex-col gap-3 text-sm text-muted">
          <Step n={1} text={t('pairing.step1')} />
          <Step n={2} text={t('pairing.step2')} />
          <Step n={3} text={t('pairing.step3')} />
          <Step n={4} text={t('pairing.step4')} />

          <li className="mt-1">
            <CancelPairing sessionId={session.id} onChange={onChange} />
          </li>
        </ol>
      </div>
    </Card>
  )
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-[11px] font-medium text-accent"
      >
        {n}
      </span>
      <span className="text-ink/80">
        <Rich text={text} />
      </span>
    </li>
  )
}

function CancelPairing({ sessionId, onChange }: { sessionId: string; onChange: () => void }) {
  const t = useT()
  const [busy, setBusy] = useState(false)

  return (
    <Button
      tone="neutral"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await post(`/v1/sessions/${sessionId}/stop`).catch(() => undefined)
        onChange()
        setBusy(false)
      }}
    >
      {t('pairing.cancel')}
    </Button>
  )
}

function SessionCard({
  session,
  selected,
  onSelect,
  onStart,
  onChange,
}: {
  session: SessionRow
  selected: boolean
  onSelect: () => void
  onStart: () => void
  onChange: () => void
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sendCommand(action: 'start' | 'stop' | 'logout') {
    setBusy(true)
    setError(null)
    try {
      await post(`/v1/sessions/${session.id}/${action}`)
      // Whoever pressed Start wants to see what happened to this session.
      if (action === 'start') onStart()
      onChange()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('sessions.commandFailed'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Intent and reality disagree.
   *
   * "Should be running, but isn't" is the state that costs money quietly: the
   * queue keeps accepting messages and nothing goes out. It gets its own
   * highlight.
   */
  const diverged = session.desiredState === 'running' && !session.running

  return (
    <li className="border-b border-line last:border-0">
      <div className="flex flex-wrap items-center gap-3 py-3">
        <button
          type="button"
          onClick={onSelect}
          className={cx(
            'flex min-w-0 flex-1 items-center gap-3 text-left',
            selected && 'text-accent',
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{session.name}</span>
            <span className="block truncate font-mono text-xs text-muted">
              {phone(session.phoneNumber)} · {session.engine}
              {session.ownerNodeId &&
                ` · ${t('sessions.onNode', { id: session.ownerNodeId.slice(0, 8) })}`}
            </span>
          </span>
        </button>

        <div className="flex items-center gap-2">
          <Pill tone={statusTone(session.status)}>{statusLabel(t, session.status)}</Pill>

          {diverged && <Pill tone="crit">{t('sessions.shouldBeRunning')}</Pill>}

          {session.running ? (
            <>
              <Button onClick={() => sendCommand('stop')} disabled={busy}>
                {t('sessions.stop')}
              </Button>
              <Button onClick={() => sendCommand('logout')} disabled={busy} tone="danger">
                {t('sessions.logout')}
              </Button>
            </>
          ) : (
            <Button onClick={() => sendCommand('start')} disabled={busy} tone="primary">
              {t('sessions.start')}
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="pb-2 text-xs text-crit">
          {error}
        </p>
      )}
    </li>
  )
}

function Button({
  children,
  onClick,
  disabled,
  tone = 'neutral',
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  tone?: 'neutral' | 'primary' | 'danger'
  type?: 'button' | 'submit'
}) {
  const className = {
    neutral: 'border-line bg-surface text-ink hover:bg-surface-2',
    primary: 'border-transparent bg-accent text-on-fill hover:opacity-90',
    danger: 'border-line bg-surface text-crit hover:bg-surface-2',
  }[tone]

  return (
    <button
      type={type === 'submit' ? 'submit' : 'button'}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  )
}

function NewSession({ onCreate }: { onCreate: () => void }) {
  const t = useT()
  const [isOpen, setIsOpen] = useState(false)
  const [name, setName] = useState('')
  const [engine, setEngine] = useState('baileys')
  const [error, setError] = useState<string | null>(null)

  async function create(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      await post('/v1/sessions', { name: name, engine })
      setName('')
      setIsOpen(false)
      onCreate()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('sessions.createFailed'))
    }
  }

  if (!isOpen) {
    return (
      <Button onClick={() => setIsOpen(true)} tone="primary">
        {t('sessions.new')}
      </Button>
    )
  }

  return (
    <form onSubmit={create} className="flex flex-wrap items-center gap-2">
      <input
        // biome-ignore lint/a11y/noAutofocus: the form only exists after an explicit click
        autoFocus
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('sessions.namePlaceholder')}
        className="w-40 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink"
      />
      <select
        value={engine}
        onChange={(e) => setEngine(e.target.value)}
        className="rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink"
      >
        {ENGINES.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {t(entry.label)}
          </option>
        ))}
      </select>
      <Button type="submit" tone="primary">
        {t('sessions.create')}
      </Button>
      <Button onClick={() => setIsOpen(false)}>{t('common.cancel')}</Button>
      {error && (
        <span role="alert" className="w-full text-xs text-crit">
          {error}
        </span>
      )}
    </form>
  )
}

/**
 * The QR expires in seconds and the engine regenerates it.
 *
 * Fetching every two seconds is what keeps the image on screen the same one
 * WhatsApp will accept — a QR from ten seconds ago has already failed.
 */
function QrPanel({ sessionId }: { sessionId: string }) {
  const t = useT()
  const qr = useQuery<QrResponse>(`/v1/sessions/${sessionId}/qr`, 2000)

  /**
   * White background always, dark theme included.
   *
   * A QR reader needs contrast between module and background; inverting the
   * colours along with the rest of the interface would make the phone's camera
   * simply not see the code.
   */
  if (!qr.data) {
    return (
      <div className="grid size-[248px] shrink-0 place-items-center rounded-lg border border-dashed border-line text-center text-sm text-muted">
        Aguardando a engine
        <br />
        gerar o código…
      </div>
    )
  }

  return (
    <img
      src={qr.data.image}
      alt={t('pairing.qrAlt')}
      width={248}
      height={248}
      className="size-[248px] shrink-0 rounded border border-line bg-white p-2"
    />
  )
}

/** Just the three fields the wording needs, so it does not shadow the row type. */
type CauseOf = {
  cause: string | null
  causeCode: string | null
  detail: Record<string, string | number> | null
}

/**
 * Why the session did what it did, in the reader's language.
 *
 * The hint above this list promises "the raw protocol code next to the
 * translated cause", and for a long time only the first half was true: the
 * sentence came from the server in English and was printed as it arrived, in a
 * panel translated into ten languages. The server now sends a stable code and
 * the numbers beside it, and the wording happens here.
 *
 * The English sentence stays as the fallback. A disconnect reason the catalogue
 * has never seen — and WhatsApp invents them — is better shown untranslated
 * than not shown at all.
 */
function causa(t: Translate, event: CauseOf): string {
  if (!event.causeCode) return event.cause ?? '—'
  const key = `events.cause.${event.causeCode}` as TranslationKey
  const traduzida = t(key, event.detail ?? undefined)
  return traduzida === key ? (event.cause ?? '—') : traduzida
}

type ScoreFactor = { name: string; detail: string; values: Record<string, number> }

/**
 * The factor's explanation, in the reader's language.
 *
 * The API sends the fact twice: as numbers, and as an English sentence. The
 * panel is translated into ten languages, so it words the numbers itself and
 * keeps the sentence only as a fallback — a signal added to the score later
 * still shows up here, in English but visible, instead of vanishing from the
 * one list that explains why the score is what it is.
 *
 * `t` returns the key itself when it knows no translation and English has none
 * either, which is exactly the "no wording for this signal" case.
 */
function explain(t: Translate, factor: ScoreFactor): string {
  const key = `risk.factor.${factor.name}` as TranslationKey
  const worded = t(key, factor.values)
  return worded === key ? factor.detail : worded
}

function RiskPanel({ sessionId }: { sessionId: string }) {
  const t = useT()
  const risk = useQuery<RiskSnapshot>(`/v1/sessions/${sessionId}/risk`, 5000)

  if (!risk.settled) {
    return (
      <Card title={t('risk.title')}>
        <Skeleton className="h-52" />
      </Card>
    )
  }

  if (!risk.data) {
    return (
      <Card title={t('risk.title')}>
        <Empty>{t('risk.none')}</Empty>
      </Card>
    )
  }

  const { score, usage, limits, warmup, throttleFactor } = risk.data
  const tone: Tone = score.value < 40 ? 'ok' : score.value < 70 ? 'warn' : 'crit'
  const scoring = score.factors.filter((factor) => factor.points > 0)

  return (
    <Card title={t('risk.title')} hint={t('risk.hint')}>
      <div className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-3">
          <Stat
            label={t('risk.score')}
            value={score.value}
            unit="/100"
            tone={tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'crit'}
          />
          <div className="text-right">
            <span className="eyebrow">{t('risk.warmup')}</span>
            <p className="font-mono text-sm text-ink tnum">{pct(warmup.factor)}</p>
            <p className="text-xs text-muted">
              {t('risk.ageDays', { n: warmup.ageInDays.toFixed(1) })}
            </p>
          </div>
        </div>

        {throttleFactor < 1 && (
          <p className="rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
            {t('risk.throttled', { rate: pct(throttleFactor) })}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <span className="eyebrow">{t('risk.windows')}</span>
          <Barra label={t('risk.perMinute')} used={usage.minute} limit={limits.perMinute} />
          <Barra label={t('risk.perHour')} used={usage.hour} limit={limits.perHour} />
          <Barra label={t('risk.perDay')} used={usage.day} limit={limits.perDay} />
          <Barra
            label={t('risk.newContactsToday')}
            used={usage.newContactsToday}
            limit={limits.newContactsPerDay}
          />
        </div>

        {/* A factor that scored nothing explains nothing; the heading alone just takes space. */}
        {scoring.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">{t('risk.factors')}</span>
            <ul className="flex flex-col gap-1">
              {scoring.map((factor) => (
                <li key={factor.name} className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-muted">{explain(t, factor)}</span>
                  <span className="shrink-0 font-mono text-xs text-ink tnum">
                    +{factor.points}
                    <span className="text-muted">/{factor.max}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}

function Barra({ label, used, limit }: { label: string; used: number; limit: number }) {
  const fraction = limit > 0 ? Math.min(used / limit, 1) : 0
  const color = fraction > 0.9 ? 'var(--crit)' : fraction > 0.7 ? 'var(--warn)' : 'var(--ok)'

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted">{label}</span>
        <span className="font-mono text-ink tnum">
          {num(used)}
          <span className="text-muted">/{num(limit)}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${fraction * 100}%`, background: color }}
        />
      </div>
    </div>
  )
}

const TONE_BY_EVENT: Record<string, Tone> = {
  connected: 'ok',
  paired: 'ok',
  connecting: 'warn',
  qr: 'warn',
  disconnected: 'crit',
  logged_out: 'crit',
  banned: 'crit',
}

function Timeline({ sessionId }: { sessionId: string }) {
  const t = useT()
  const events = useQuery<{ events: SessionEvent[] }>(
    `/v1/sessions/${sessionId}/events?limit=40`,
    10_000,
  )

  return (
    <Card title={t('events.title')} hint={t('events.hint')}>
      {!events.settled ? (
        <Skeleton className="h-32" />
      ) : (events.data?.events.length ?? 0) === 0 ? (
        <Empty>{t('events.empty')}</Empty>
      ) : (
        <ol className="flex flex-col">
          {events.data?.events.map((event) => (
            <li
              key={event.id}
              className="flex flex-wrap items-center gap-3 border-b border-line py-2 last:border-0"
            >
              <Pill tone={TONE_BY_EVENT[event.type] ?? 'hold'}>{event.type}</Pill>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                {causa(t, event)}
                {event.rawCode !== null && (
                  <span className="ml-1.5 font-mono opacity-70">({event.rawCode})</span>
                )}
              </span>
              <span className="font-mono text-xs text-muted tnum" title={dateTime(event.createdAt)}>
                {since(event.createdAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}
