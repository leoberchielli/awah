import { type FormEvent, useState } from 'react'
import { Card } from '../../components/ui'
import { Rich, useT } from '../../i18n'
import type { IntegrationSaved, SessionRow } from '../../lib/api'
import { ApiError, put } from '../../lib/api'

/**
 * Connect Typebot with the link the person already has in hand.
 *
 * The previous version asked for "address" and "flow id" in separate fields,
 * which forces whoever is integrating to know what a `publicId` is and where to
 * look for it. The share link carries both, and it is exactly what is on the
 * clipboard of someone who has just published a flow.
 */
export function AssistenteTypebot({
  sessions,
  onSave,
}: {
  sessions: SessionRow[]
  onSave: () => void
}) {
  const t = useT()
  const [sessionId, setSessionId] = useState('')
  const [shareUrl, setShareUrl] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [humanHandoffKeyword, setPalavra] = useState('agent')
  const [humanHandoffReply, setResposta] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pronto, setPronto] = useState<IntegrationSaved | null>(null)

  async function connect(evento: FormEvent) {
    evento.preventDefault()
    setBusy(true)
    setError(null)

    try {
      setPronto(
        await put<IntegrationSaved>(`/v1/sessions/${sessionId}/integrations/typebot`, {
          shareUrl,
          ...(apiToken.trim() ? { apiToken: apiToken.trim() } : {}),
          humanHandoffKeyword,
          ...(humanHandoffReply.trim() ? { humanHandoffReply } : {}),
        }),
      )
      onSave()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('wizard.apiUnreachable'))
    } finally {
      setBusy(false)
    }
  }

  if (pronto) {
    return (
      <Card title={t('typebot.connected')}>
        <div className="flex flex-col gap-3">
          <p className="rounded-md bg-ok/10 px-3 py-2 text-sm text-ok">{pronto.detail}</p>
          <p className="text-sm text-muted">{t('typebot.connectedHint')}</p>
          <button
            type="button"
            onClick={() => setPronto(null)}
            className="self-start rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
          >
            {t('wizard.connectAnother')}
          </button>
        </div>
      </Card>
    )
  }

  return (
    <Card title={t('typebot.title')} hint={t('typebot.hint')}>
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
            <span className="text-xs text-warn">{t('wizard.noSessions')}</span>
          )}
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('typebot.flowLink')}</span>
          <input
            required
            type="url"
            value={shareUrl}
            onChange={(e) => setShareUrl(e.target.value)}
            placeholder="https://typebot.io/my-flow"
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
          />
          <span className="text-xs text-muted">
            <Rich text={t('typebot.flowLinkHint')} />
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">
            {t('typebot.apiToken')}{' '}
            <span className="normal-case tracking-normal opacity-70">{t('wizard.optional')}</span>
          </span>
          <input
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          />
          <span className="text-xs text-muted">{t('typebot.apiTokenHint')}</span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('typebot.escapeWord')}</span>
          <input
            value={humanHandoffKeyword}
            onChange={(e) => setPalavra(e.target.value)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          />
          {/* Whoever types this has given up on the bot: the message never reaches the flow. */}
          <span className="text-xs text-muted">{t('typebot.escapeWordHint')}</span>
        </label>

        {/*
          This goes out to the end customer, and it is the only message in the
          flow the gateway writes on its own. Leaving it at the default would
          mean sending English to someone who has just asked for a human in
          Portuguese.
        */}
        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('typebot.handoffReply')}</span>
          <input
            value={humanHandoffReply}
            onChange={(e) => setResposta(e.target.value)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          />
          <span className="text-xs text-muted">{t('typebot.handoffReplyHint')}</span>
        </label>

        {error && (
          <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-fill transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t('typebot.submitting') : t('typebot.submit')}
        </button>
      </form>
    </Card>
  )
}
