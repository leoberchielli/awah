import { type FormEvent, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { LanguagePicker } from '../components/LanguagePicker'
import { Marca } from '../components/Shell'
import { useQuery } from '../hooks/useQuery'
import { useT } from '../i18n'
import type { Bootstrap } from '../lib/api'
import { ApiError, post } from '../lib/api'
import { FirstRun } from './PrimeiroAcesso'

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
  // Whoever opens /entrar on an empty instance needs the setup screen, not login.
  const bootstrap = useQuery<Bootstrap>('/v1/auth/bootstrap')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  async function send(evento: FormEvent) {
    evento.preventDefault()
    setSending(true)
    setError(null)

    try {
      await post('/v1/auth/login', { email, password: password })
      const goBack = params.get('voltar')
      window.location.assign(goBack?.startsWith('/') ? goBack : '/operacao')
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('login.failed'))
      setSending(false)
    }
  }

  if (bootstrap.data?.needsSetup) return <FirstRun />

  return (
    <div className="grid min-h-dvh place-items-center bg-ground px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col gap-2">
          {/* The picker comes before the form: whoever cannot read the detected
              language has to change it here, not after managing to sign in. */}
          <div className="flex items-start justify-between gap-3">
            <Marca />
            <LanguagePicker />
          </div>
          <p className="text-sm text-muted">{t('app.tagline')}</p>
        </div>

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
        onChange={(evento) => onChange(evento.target.value)}
        className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
        {...resto}
      />
    </label>
  )
}
