import { type FormEvent, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LanguagePicker } from '../components/LanguagePicker'
import { Brand } from '../components/Shell'
import { useQuery } from '../hooks/useQuery'
import { useT } from '../i18n'
import type { Bootstrap, DemoInfo } from '../lib/api'
import { ApiError, post } from '../lib/api'
import { FirstRun } from './FirstRun'

/**
 * The dashboard's front door.
 *
 * User and password only: an API key never goes in here. A key pasted into the
 * browser is within reach of every installed extension, and it is the
 * credential that sends messages on behalf of every session in the
 * organization.
 */
export function SignIn() {
  const t = useT()
  const [params] = useSearchParams()
  // Whoever opens /signin on an empty instance needs the setup screen, not login.
  const bootstrap = useQuery<Bootstrap>('/v1/auth/bootstrap')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function send(event: FormEvent) {
    event.preventDefault()
    setSending(true)
    setError(null)

    try {
      await post('/v1/auth/login', { email, password: password })
      /**
       * `//evil.example` also starts with a slash.
       *
       * A protocol-relative URL is a full address to the browser, so the
       * "internal path only" check let `?return=//somewhere.else` send whoever
       * had just typed their password straight off the site. The second
       * character has to be part of the test, and a backslash counts as a
       * slash in more parsers than one would like.
       */
      const goBack = params.get('return')
      const internal = goBack && /^\/[^/\\]/.test(goBack) ? goBack : '/operations'
      window.location.assign(internal)
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('login.failed'))
      setSending(false)
    }
  }

  if (bootstrap.data?.needsSetup) return <FirstRun />

  const demo = bootstrap.data?.demo ?? null

  return (
    <div className="grid min-h-dvh place-items-center bg-ground px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col gap-2">
          {/* The picker comes before the form: whoever cannot read the detected
              language has to change it here, not after managing to sign in. */}
          <div className="flex items-start justify-between gap-3">
            <Brand />
            <LanguagePicker />
          </div>
          <p className="text-sm text-muted">{t('app.tagline')}</p>
        </div>

        {demo && (
          <DemoCard
            demo={demo}
            onUse={() => {
              setEmail(demo.email)
              setPassword(demo.password)
            }}
          />
        )}

        <form onSubmit={send} className="card flex flex-col gap-4 p-5">
          <Field
            id="email"
            label={t('login.email')}
            type="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
          />
          <Field
            id="senha"
            label={t('login.password')}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
          />

          {error && (
            <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={sending}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-fill transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {sending ? t('login.submitting') : t('login.submit')}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-muted">{t('login.noAccount')}</p>
      </div>
    </div>
  )
}

/**
 * The credentials, on the screen that asks for them.
 *
 * A public demo that keeps its password in the README is a demo half the
 * visitors never get into: they arrive at a login form from a link, with no
 * README in sight. The button fills the form instead of signing in on its own —
 * seeing the values go into the fields is what tells someone these are ordinary
 * credentials, not a bypass, and it leaves the ordinary sign-in path as the only
 * way in.
 */
function DemoCard({ demo, onUse }: { demo: DemoInfo; onUse: () => void }) {
  const t = useT()

  return (
    <div className="card mb-4 flex flex-col gap-2 border-accent/40 p-4">
      <span className="eyebrow text-accent">{t('demo.badge')}</span>
      <p className="text-xs text-muted">{t('demo.signInHint')}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">{t('login.email')}</dt>
        <dd className="font-mono text-ink">{demo.email}</dd>
        <dt className="text-muted">{t('login.password')}</dt>
        <dd className="font-mono text-ink">{demo.password}</dd>
      </dl>
      <button
        type="button"
        onClick={onUse}
        className="self-start rounded-md border border-accent/50 px-2.5 py-1 text-xs font-medium text-accent transition-opacity hover:opacity-80"
      >
        {t('demo.fillCredentials')}
      </button>
    </div>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  ...resto
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id'>) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <input
        id={id}
        required
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
        {...resto}
      />
    </label>
  )
}
