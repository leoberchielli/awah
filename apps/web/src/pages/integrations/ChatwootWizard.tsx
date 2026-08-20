import { type FormEvent, useState } from 'react'
import { Card, cx, Empty } from '../../components/ui'
import { Rich, useT } from '../../i18n'
import type {
  ChatwootAccount,
  ChatwootDiscovery,
  ChatwootInbox,
  IntegrationSaved,
  SessionRow,
} from '../../lib/api'
import { ApiError, post, put } from '../../lib/api'

/**
 * Connect Chatwoot without leaving this screen.
 *
 * The manual for this integration had seven steps, and three of them were the
 * ones that made people give up: find the `accountId` in the URL, find the
 * `inboxId` in the URL, and go back to Chatwoot to paste the webhook URL. The
 * token already knows the first two answers, and the Chatwoot API will create
 * the inbox with the webhook already pointed at us — so none of the three has
 * to exist.
 */
export function ChatwootWizard({
  sessions,
  onSave,
}: {
  sessions: SessionRow[]
  onSave: () => void
}) {
  const t = useT()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [baseUrl, setBaseUrl] = useState('https://app.chatwoot.com')
  const [apiAccessToken, setToken] = useState('')
  const [accounts, setAccounts] = useState<ChatwootAccount[]>([])
  const [accountId, setAccountId] = useState<number | null>(null)
  const [inboxes, setInboxes] = useState<ChatwootInbox[]>([])
  const [choice, setChoice] = useState<'nova' | number>('nova')
  const [inboxName, setInboxName] = useState('WhatsApp (AWAH)')
  const [sessionId, setSessionId] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState<IntegrationSaved | null>(null)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('wizard.apiUnreachable'))
    } finally {
      setBusy(false)
    }
  }

  const discoverAccounts = (event: FormEvent) => {
    event.preventDefault()
    return run(async () => {
      const result = await post<ChatwootDiscovery>('/v1/integrations/chatwoot/discover', {
        baseUrl,
        apiAccessToken,
      })

      if (result.accounts.length === 0) {
        throw new ApiError(400, 'sem_conta', t('chatwoot.noAccount'))
      }

      setAccounts(result.accounts)
      // A single account does not deserve a question: move on and fetch its inboxes.
      const onlyAccount = result.accounts.length === 1 ? result.accounts[0] : null
      if (onlyAccount) {
        await pickAccount(onlyAccount.id)
        return
      }
      setStep(2)
    })
  }

  async function pickAccount(id: number) {
    const result = await post<ChatwootDiscovery>('/v1/integrations/chatwoot/discover', {
      baseUrl,
      apiAccessToken,
      accountId: id,
    })

    setAccountId(id)
    setInboxes(result.inboxes ?? [])
    setStep(3)
  }

  const connect = (event: FormEvent) => {
    event.preventDefault()
    return run(async () => {
      setReady(
        await put<IntegrationSaved>(`/v1/sessions/${sessionId}/integrations/chatwoot`, {
          baseUrl,
          apiAccessToken,
          accountId,
          ...(choice === 'nova' ? { createInbox: inboxName } : { inboxId: choice }),
        }),
      )
      onSave()
    })
  }

  if (ready) {
    return (
      <Card title={t('chatwoot.connected')}>
        <div className="flex flex-col gap-3">
          <p className="rounded-md bg-ok/10 px-3 py-2 text-sm text-ok">{ready.detail}</p>

          {/* Null means the gateway already pointed the webhook itself. */}
          {ready.webhookUrl ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-ink/80">
                <Rich text={t('chatwoot.oneStepLeft')} />
              </p>
              <code className="truncate rounded border border-line bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-ink">
                {ready.webhookUrl}
              </code>
            </div>
          ) : (
            <p className="text-sm text-muted">{t('chatwoot.webhookDone')}</p>
          )}

          <button
            type="button"
            onClick={() => {
              setReady(null)
              setStep(1)
            }}
            className="self-start rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
          >
            Conectar outra sessão
          </button>
        </div>
      </Card>
    )
  }

  return (
    <Card title={t('chatwoot.title')} hint={t('chatwoot.hint')} action={<Steps current={step} />}>
      {step === 1 && (
        <form onSubmit={discoverAccounts} className="flex flex-col gap-3">
          <Field
            label={t('chatwoot.address')}
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://app.chatwoot.com"
          />
          <Field
            label={t('chatwoot.token')}
            type="password"
            value={apiAccessToken}
            onChange={setToken}
            hint={t('chatwoot.tokenHint')}
          />

          <ErrorNote text={error} />
          <Action busy={busy} label={t('chatwoot.continue')} loading={t('chatwoot.talking')} />
        </form>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{t('chatwoot.whichAccount')}</p>
          <ul className="flex flex-col gap-2">
            {accounts.map((account) => (
              <li key={account.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => pickAccount(account.id))}
                  className="flex w-full items-center justify-between rounded-md border border-line bg-surface px-3 py-2.5 text-left text-sm text-ink hover:bg-surface-2 disabled:opacity-50"
                >
                  <span>{account.name}</span>
                  <span className="font-mono text-xs text-muted">{account.role}</span>
                </button>
              </li>
            ))}
          </ul>
          <ErrorNote text={error} />
        </div>
      )}

      {step === 3 && (
        <form onSubmit={connect} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">{t('wizard.pickSession')}</span>
            <select
              required
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
            >
              <option value="">{t('wizard.pickSessionPlaceholder')}</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {sessions.length === 0 && (
              <span className="text-xs text-warn">
                Nenhuma sessão ainda. Crie uma na aba Sessões primeiro.
              </span>
            )}
          </label>

          <fieldset className="flex flex-col gap-2">
            <span className="eyebrow">{t('chatwoot.inbox')}</span>

            <OptionRow
              selected={choice === 'nova'}
              aoEscolher={() => setChoice('nova')}
              title={t('chatwoot.newInbox')}
              detail={t('chatwoot.newInboxHint')}
            />

            {choice === 'nova' && (
              <input
                required
                value={inboxName}
                onChange={(e) => setInboxName(e.target.value)}
                className="ml-6 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
              />
            )}

            {/**
             * An inbox that is not API-type shows disabled instead of vanishing:
             * whoever is looking for the inbox they already use needs to see
             * why it will not do.
             */}
            {inboxes.map((inbox) => (
              <OptionRow
                key={inbox.id}
                selected={choice === inbox.id}
                aoEscolher={() => setChoice(inbox.id)}
                disabled={!inbox.usable}
                title={inbox.name}
                detail={
                  inbox.usable
                    ? t('chatwoot.existingInbox')
                    : `Tipo ${inbox.channelType} — tem transporte próprio e ignoraria o gateway.`
                }
              />
            ))}

            {inboxes.length === 0 && <Empty>{t('chatwoot.noInbox')}</Empty>}
          </fieldset>

          <ErrorNote text={error} />
          <Action busy={busy} label={t('chatwoot.connect')} loading={t('chatwoot.preparing')} />
        </form>
      )}
    </Card>
  )
}

function Steps({ current }: { current: number }) {
  const t = useT()

  return (
    <span className="flex items-center gap-1.5">
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          aria-hidden
          className={cx(
            'size-1.5 rounded-full',
            n === current ? 'bg-accent' : n < current ? 'bg-ok' : 'bg-line-strong',
          )}
        />
      ))}
      <span className="sr-only">{t('wizard.stepOf', { n: current, total: 3 })}</span>
    </span>
  )
}

function OptionRow({
  selected,
  aoEscolher,
  title,
  detail,
  disabled,
}: {
  selected: boolean
  aoEscolher: () => void
  title: string
  detail: string
  disabled?: boolean
}) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5',
        disabled && 'cursor-not-allowed opacity-50',
        selected ? 'border-accent bg-accent-soft' : 'border-line bg-surface',
      )}
    >
      <input
        type="radio"
        name="caixa"
        checked={selected}
        disabled={disabled}
        onChange={aoEscolher}
        className="mt-0.5 accent-[var(--accent)]"
      />
      <span className="min-w-0">
        <span className="block text-sm text-ink">{title}</span>
        <span className="block text-xs text-muted">{detail}</span>
      </span>
    </label>
  )
}

function Field({
  label,
  value,
  onChange,
  hint,
  ...resto
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <input
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
        {...resto}
      />
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  )
}

function ErrorNote({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
      {text}
    </p>
  )
}

function Action({ busy, label, loading }: { busy: boolean; label: string; loading: string }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="mt-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-fill transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {busy ? loading : label}
    </button>
  )
}
