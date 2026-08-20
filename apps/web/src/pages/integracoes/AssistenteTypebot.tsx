import { type FormEvent, useState } from 'react'
import { Card } from '../../components/ui'
import { Rich, useT } from '../../i18n'
import type { IntegrationSaved, SessionRow } from '../../lib/api'
import { ApiError, put } from '../../lib/api'

/**
 * Conectar o Typebot com o link que a pessoa já tem na mão.
 *
 * A versão anterior pedia "endereço" e "id do fluxo" em campos separados, o que
 * obriga quem integra a saber o que é `publicId` e onde procurá-lo. O link de
 * compartilhamento traz os dois, e é exatamente o que está na área de
 * transferência de quem acabou de publicar um fluxo.
 */
export function AssistenteTypebot({
  sessoes,
  aoSalvar,
}: {
  sessoes: SessionRow[]
  aoSalvar: () => void
}) {
  const t = useT()
  const [sessionId, setSessionId] = useState('')
  const [shareUrl, setShareUrl] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [humanHandoffKeyword, setPalavra] = useState('agent')
  const [humanHandoffReply, setResposta] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [pronto, setPronto] = useState<IntegrationSaved | null>(null)

  async function conectar(evento: FormEvent) {
    evento.preventDefault()
    setOcupado(true)
    setErro(null)

    try {
      setPronto(
        await put<IntegrationSaved>(`/v1/sessions/${sessionId}/integrations/typebot`, {
          shareUrl,
          ...(apiToken.trim() ? { apiToken: apiToken.trim() } : {}),
          humanHandoffKeyword,
          ...(humanHandoffReply.trim() ? { humanHandoffReply } : {}),
        }),
      )
      aoSalvar()
    } catch (falha) {
      setErro(falha instanceof ApiError ? falha.message : t('wizard.apiUnreachable'))
    } finally {
      setOcupado(false)
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
      <form onSubmit={conectar} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('wizard.pickSession')}</span>
          <select
            required
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          >
            <option value="">{t('wizard.pickSessionPlaceholder')}</option>
            {sessoes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {sessoes.length === 0 && (
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
          {/* Quem digita isso já desistiu do robô: a mensagem nem chega ao fluxo. */}
          <span className="text-xs text-muted">{t('typebot.escapeWordHint')}</span>
        </label>

        {/*
          Sai para o cliente final, e é a única mensagem do fluxo que o gateway
          escreve sozinho. Deixá-la só no default significaria mandar inglês a
          quem acabou de pedir um humano em português.
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

        {erro && (
          <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
            {erro}
          </p>
        )}

        <button
          type="submit"
          disabled={ocupado}
          className="mt-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-fill transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {ocupado ? t('typebot.submitting') : t('typebot.submit')}
        </button>
      </form>
    </Card>
  )
}
