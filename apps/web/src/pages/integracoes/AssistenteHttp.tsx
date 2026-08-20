import { type FormEvent, useState } from 'react'
import { Card, cx } from '../../components/ui'
import { useT } from '../../i18n'
import type { IntegrationSaved, SessionRow, TesteDoConector } from '../../lib/api'
import { ApiError, post, put } from '../../lib/api'

/**
 * Plugar qualquer plataforma.
 *
 * Chatwoot e Typebot têm conector dedicado porque são os dois casos mais
 * comuns. Este existe para todo o resto: n8n, Make, uma função serverless, o
 * sistema da casa. O gateway posta a mensagem recebida numa URL e envia de volta
 * o que a resposta trouxer — e essa resposta entra pela mesma fila de qualquer
 * envio, com ordem por conversa, motor de risco e reentrega.
 */
export function AssistenteHttp({
  sessoes,
  aoSalvar,
}: {
  sessoes: SessionRow[]
  aoSalvar: () => void
}) {
  const t = useT()
  const [sessionId, setSessionId] = useState('')
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [secret, setSecret] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [teste, setTeste] = useState<TesteDoConector | null>(null)
  const [ocupado, setOcupado] = useState<'teste' | 'salvar' | null>(null)
  const [pronto, setPronto] = useState<IntegrationSaved | null>(null)

  const corpo = () => ({
    url,
    ...(secret.trim() ? { secret: secret.trim() } : {}),
    ...(label.trim() ? { label: label.trim() } : {}),
  })

  async function testar() {
    setOcupado('teste')
    setErro(null)
    try {
      setTeste(await post<TesteDoConector>('/v1/integrations/http/test', corpo()))
    } catch (falha) {
      setErro(falha instanceof ApiError ? falha.message : t('http.apiUnreachable'))
    } finally {
      setOcupado(null)
    }
  }

  async function conectar(evento: FormEvent) {
    evento.preventDefault()
    setOcupado('salvar')
    setErro(null)
    try {
      setPronto(await put<IntegrationSaved>(`/v1/sessions/${sessionId}/integrations/http`, corpo()))
      aoSalvar()
    } catch (falha) {
      setErro(falha instanceof ApiError ? falha.message : t('http.apiUnreachable'))
    } finally {
      setOcupado(null)
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
          {/* Mesmo esquema dos webhooks: quem já valida um valida o outro. */}
          <span className="text-xs text-muted">{t('http.secretHint')}</span>
        </label>

        {erro && (
          <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
            {erro}
          </p>
        )}

        {teste && <Resultado teste={teste} />}

        <div className="mt-1 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!url || ocupado !== null}
            onClick={testar}
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
          >
            {ocupado === 'teste' ? t('http.testing') : t('http.test')}
          </button>
          <button
            type="submit"
            disabled={ocupado !== null}
            className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-fill transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {ocupado === 'salvar' ? t('http.connecting') : t('http.connect')}
          </button>
        </div>
      </form>
    </Card>
  )
}

/**
 * O que voltou, sem interpretação.
 *
 * Status, tempo, corpo cru e o diagnóstico. É o que substitui adivinhação
 * quando alguém acabou de plugar uma plataforma que ninguém aqui conhece.
 */
function Resultado({ teste }: { teste: TesteDoConector }) {
  const t = useT()
  const [mostrarEnviado, setMostrarEnviado] = useState(false)

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
          {teste.replies.map((texto) => (
            <li
              key={texto}
              className="rounded border border-line bg-surface px-2 py-1.5 text-xs text-ink"
            >
              {texto}
            </li>
          ))}
        </ul>
      )}

      {teste.diagnostico && <p className="text-xs text-warn">{teste.diagnostico}</p>}

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
        onClick={() => setMostrarEnviado((v) => !v)}
        className="self-start text-xs text-muted underline underline-offset-2 hover:text-ink"
      >
        {mostrarEnviado ? t('http.hidePayload') : t('http.showPayload')}
      </button>

      {mostrarEnviado && (
        <pre className="max-h-52 overflow-auto rounded border border-line bg-surface p-2 font-mono text-[11px] text-ink">
          {JSON.stringify(teste.sentPayload, null, 2)}
        </pre>
      )}
    </div>
  )
}
