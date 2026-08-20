import { type FormEvent, useState } from 'react'
import { Card, cx } from '../../components/ui'
import { useT } from '../../i18n'
import type { IntegrationSaved, SessionRow, TesteDoConector } from '../../lib/api'
import { ApiError, post, put } from '../../lib/api'

/**
 * Plug in any platform.
 *
 * Chatwoot and Typebot get dedicated connectors because they are the two most
 * common cases. This one exists for everything else: n8n, Make, a serverless
 * function, the in-house system. The gateway posts the incoming message to a
 * URL and sends back whatever the response carries — and that response goes
 * through the same queue as any other send, with per-chat ordering, the risk
 * engine and redelivery.
 */
export function AssistenteHttp({
  sessions,
  onSave,
}: {
  sessions: SessionRow[]
  onSave: () => void
}) {
  const t = useT()
  const [sessionId, setSessionId] = useState('')
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [teste, setTeste] = useState<TesteDoConector | null>(null)
  const [busy, setBusy] = useState<'teste' | 'salvar' | null>(null)
  const [pronto, setPronto] = useState<IntegrationSaved | null>(null)

  const body = () => ({
    url,
    ...(secret.trim() ? { secret: secret.trim() } : {}),
    ...(label.trim() ? { label: label.trim() } : {}),
  })

  async function test() {
    setBusy('teste')
    setError(null)
    try {
      setTeste(await post<TesteDoConector>('/v1/integrations/http/test', body()))
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('http.apiUnreachable'))
    } finally {
      setBusy(null)
    }
  }

  async function connect(evento: FormEvent) {
    evento.preventDefault()
    setBusy('salvar')
    setError(null)
    try {
      setPronto(await put<IntegrationSaved>(`/v1/sessions/${sessionId}/integrations/http`, body()))
      onSave()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('http.apiUnreachable'))
    } finally {
      setBusy(null)
    }
  }

  if (pronto) {
    return (
      <Card title={t('http.connected')}>
        <div className="flex flex-col gap-3">
          <p className="rounded-md bg-ok/10 px-3 py-2 text-sm text-ok">{pronto.detail}</p>
          <button
            type="button"
            onClick={() => setPronto(null)}
            className="self-start rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
          >
            {t('http.connectAnother')}
          </button>
        </div>
      </Card>
    )
  }

  return (
    <Card title={t('http.title')} hint={t('http.hint')}>
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
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('http.url')}</span>
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://n8n.yourcompany.com/webhook/support"
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
          />
          <span className="text-xs text-muted">
            {t('http.urlHint', { example: '{"reply":"..."}' })}
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">
            {t('http.name')}{' '}
            <span className="normal-case tracking-normal opacity-70">{t('wizard.optional')}</span>
          </span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('http.namePlaceholder')}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">
            {t('http.secret')}{' '}
            <span className="normal-case tracking-normal opacity-70">{t('wizard.optional')}</span>
          </span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          />
          {/* Same scheme as the webhooks: whoever validates one validates the other. */}
          <span className="text-xs text-muted">{t('http.secretHint')}</span>
        </label>

        {error && (
          <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
            {error}
          </p>
        )}

        {teste && <Outcome teste={teste} />}

        <div className="mt-1 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!url || busy !== null}
            onClick={test}
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
          >
            {busy === 'teste' ? t('http.testing') : t('http.test')}
          </button>
          <button
            type="submit"
            disabled={busy !== null}
            className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-fill transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy === 'salvar' ? t('http.connecting') : t('http.connect')}
          </button>
        </div>
      </form>
    </Card>
  )
}

/**
 * What came back, uninterpreted.
 *
 * Status, timing, raw body and the diagnosis. This is what replaces guesswork
 * when someone has just plugged in a platform nobody here has heard of.
 */
function Outcome({ teste }: { teste: TesteDoConector }) {
  const t = useT()
  const [showSent, setShowSent] = useState(false)

  return (
    <div
      className={cx(
        'flex flex-col gap-2 rounded-md px-3 py-2.5',
        teste.ok ? 'bg-ok/10' : 'bg-warn/10',
      )}
    >
      <p className="flex flex-wrap items-baseline gap-2 text-xs">
        <span className={cx('font-medium', teste.ok ? 'text-ok' : 'text-warn')}>
          HTTP {teste.status || '—'}
        </span>
        <span className="font-mono text-muted tnum">{teste.durationMs} ms</span>
        {teste.replies.length > 0 && (
          <span className="text-ink/80">{teste.replies.length} mensagem(ns) seriam enviadas</span>
        )}
      </p>

      {teste.replies.length > 0 && (
        <ul className="flex flex-col gap-1">
          {teste.replies.map((text) => (
            <li
              key={text}
              className="rounded border border-line bg-surface px-2 py-1.5 text-xs text-ink"
            >
              {text}
            </li>
          ))}
        </ul>
      )}

      {teste.diagnosis && <p className="text-xs text-warn">{teste.diagnosis}</p>}

      {teste.ok && teste.replies.length === 0 && (
        <p className="text-xs text-muted">
          Nada seria enviado — válido para quem só quer registrar o que chega.
        </p>
      )}

      {teste.raw && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">{t('http.responseBody')}</summary>
          <pre className="mt-1.5 max-h-40 overflow-auto rounded border border-line bg-surface p-2 font-mono text-[11px] text-ink">
            {teste.raw}
          </pre>
        </details>
      )}

      <button
        type="button"
        onClick={() => setShowSent((v) => !v)}
        className="self-start text-xs text-muted underline underline-offset-2 hover:text-ink"
      >
        {showSent ? t('http.hidePayload') : t('http.showPayload')}
      </button>

      {showSent && (
        <pre className="max-h-52 overflow-auto rounded border border-line bg-surface p-2 font-mono text-[11px] text-ink">
          {JSON.stringify(teste.sentPayload, null, 2)}
        </pre>
      )}
    </div>
  )
}
