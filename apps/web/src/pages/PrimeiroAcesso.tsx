import { type FormEvent, useState } from 'react'
import { LanguagePicker } from '../components/LanguagePicker'
import { Marca } from '../components/Shell'
import { Rich, useT } from '../i18n'
import { ApiError, post } from '../lib/api'

/**
 * The instance's first run.
 *
 * Without this screen, the only way to create the first organization was to
 * assemble a `curl` from the README — and that is the most expensive block a
 * self-hosted project can have, because it happens before anyone has seen any
 * value.
 *
 * The route closes itself as soon as an organization exists, so this screen
 * shows up once in the life of the instance.
 */
export function FirstRun() {
  const t = useT()
  const [organizationName, setOrganizationName] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const curta = password.length > 0 && password.length < 12

  async function criar(evento: FormEvent) {
    evento.preventDefault()
    setSending(true)
    setError(null)

    try {
      await post('/v1/auth/register', { organizationName, name, email, password })
      // Registration hands back a live session: go straight in, no login prompt.
      window.location.assign('/sessions')
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('setup.apiUnreachable'))
      setSending(false)
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center bg-ground px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col gap-2">
          <div className="flex items-start justify-between gap-3">
            <Marca />
            <LanguagePicker />
          </div>
          <h1 className="text-lg font-semibold text-ink">{t('setup.title')}</h1>
          <p className="text-sm text-muted">{t('setup.hint')}</p>
        </div>

        <form onSubmit={criar} className="card flex flex-col gap-4 p-5">
          <Field
            id="organizationName"
            label={t('setup.orgName')}
            placeholder={t('setup.orgPlaceholder')}
            value={organizationName}
            onChange={setOrganizationName}
          />
          <Field
            id="name"
            label={t('setup.yourName')}
            autoComplete="name"
            value={name}
            onChange={setName}
          />
          <Field
            id="email"
            label={t('login.email')}
            type="email"
            autoComplete="username"
            value={email}
            onChange={setEmail}
          />
          <Field
            id="password"
            label={t('login.password')}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            dica={curta ? t('setup.passwordShort') : t('setup.passwordHint')}
            problema={curta}
          />

          {error && (
            <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={sending || curta}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-fill transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {sending ? t('setup.submitting') : t('setup.submit')}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-muted">
          <Rich text={t('setup.ownerNote')} />
        </p>
      </div>
    </div>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  dica,
  problema,
  ...resto
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  dica?: string
  problema?: boolean
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
      {dica && (
        <span className={problema ? 'text-xs text-crit' : 'text-xs text-muted'}>{dica}</span>
      )}
    </label>
  )
}
