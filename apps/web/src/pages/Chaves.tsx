import { type FormEvent, useState } from 'react'
import { Shell } from '../components/Shell'
import { Card, Empty, Pill, Skeleton, type Tone } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import { type TranslationKey, useT } from '../i18n'
import type { SessionRow } from '../lib/api'
import { ApiError, type ApiKeyCreated, type ApiKeyRow, del, post, type Role } from '../lib/api'
import { dateTime, since } from '../lib/format'
import { roleAtLeast, useMe } from '../lib/sessao'
import { statusLabel } from '../lib/sessionStatus'

const PAPEIS: Array<{ value: Role; label: TranslationKey; resumo: TranslationKey }> = [
  { value: 'viewer', label: 'keys.role.viewer', resumo: 'keys.role.viewerSummary' },
  { value: 'operator', label: 'keys.role.operator', resumo: 'keys.role.operatorSummary' },
  { value: 'admin', label: 'keys.role.admin', resumo: 'keys.role.adminSummary' },
  { value: 'owner', label: 'keys.role.owner', resumo: 'keys.role.ownerSummary' },
]

const VALIDADES: Array<{ value: string; key: TranslationKey; n?: number }> = [
  { value: '', key: 'keys.expiry.never' },
  { value: '30', key: 'keys.expiry.days', n: 30 },
  { value: '90', key: 'keys.expiry.days', n: 90 },
  { value: '365', key: 'keys.expiry.year' },
]

export function Keys() {
  const t = useT()
  const me = useMe()
  const canAdminister = roleAtLeast(me.role, 'admin')

  const keys = useQuery<{ keys: ApiKeyRow[] }>(canAdminister ? '/v1/keys' : null)
  const sessions = useQuery<{ sessions: SessionRow[] }>(canAdminister ? '/v1/sessions' : null)

  if (!canAdminister) {
    return (
      <Shell>
        <Card title={t('nav.keys')}>
          <Empty>{t('keys.gate')}</Empty>
        </Card>
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="flex flex-col gap-4">
        <Emissor
          sessions={sessions.data?.sessions ?? []}
          viewerRole={me.role}
          aoEmitir={keys.refetch}
        />

        <Card title={t('keys.list.title')} hint={t('keys.list.hint')}>
          {!keys.settled ? (
            <Skeleton className="h-24" />
          ) : (keys.data?.keys.length ?? 0) === 0 ? (
            <Empty>{t('keys.list.empty')}</Empty>
          ) : (
            <ul className="flex flex-col">
              {keys.data?.keys.map((apiKey) => (
                <KeyRow
                  key={apiKey.id}
                  apiKey={apiKey}
                  sessions={sessions.data?.sessions ?? []}
                  aoRevogar={keys.refetch}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Shell>
  )
}

function Emissor({
  sessions,
  viewerRole,
  aoEmitir,
}: {
  sessions: SessionRow[]
  viewerRole: Role
  aoEmitir: () => void
}) {
  const t = useT()
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('operator')
  const [limitToSessions, setLimitToSessions] = useState(false)
  const [escolhidas, setEscolhidas] = useState<string[]>([])
  const [validade, setValidade] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [emitida, setIssued] = useState<ApiKeyCreated | null>(null)

  /** Nobody issues a key more powerful than their own role — the server refuses. */
  const disponiveis = PAPEIS.filter((p) => roleAtLeast(viewerRole, p.value))
  const emptyScope = limitToSessions && escolhidas.length === 0

  function alternar(id: string) {
    setEscolhidas((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    )
  }

  async function emitir(evento: FormEvent) {
    evento.preventDefault()
    setBusy(true)
    setError(null)

    try {
      const resposta = await post<ApiKeyCreated>('/v1/keys', {
        name: name.trim(),
        role: role,
        // Left out on purpose when the key covers the whole organization: an
        // empty list would mean "reaches nothing", which is a different thing.
        ...(limitToSessions ? { sessionScope: escolhidas } : {}),
        ...(validade ? { expiresInDays: Number(validade) } : {}),
      })

      setIssued(resposta)
      setName('')
      setEscolhidas([])
      setLimitToSessions(false)
      setValidade('')
      aoEmitir()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('keys.failed'))
    } finally {
      setBusy(false)
    }
  }

  if (emitida) {
    return <TokenRecemNascido emitida={emitida} onClose={() => setIssued(null)} />
  }

  return (
    <Card title={t('keys.issue.title')} hint={t('keys.issue.hint')}>
      <form onSubmit={emitir} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('keys.field.name')}</span>
          <input
            required
            minLength={2}
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('keys.field.namePlaceholder')}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
          />
          <span className="text-xs text-muted">{t('keys.field.nameHint')}</span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('keys.field.role')}</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          >
            {disponiveis.map((p) => (
              <option key={p.value} value={p.value}>
                {t(p.label)} — {t(p.resumo)}
              </option>
            ))}
          </select>
          {/* The limit is the whole reason separate credentials exist. */}
          <span className="text-xs text-muted">{t('keys.field.roleHint')}</span>
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="eyebrow mb-1.5">{t('keys.field.scope')}</legend>

          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="radio"
              name="alcance"
              checked={!limitToSessions}
              onChange={() => setLimitToSessions(false)}
              className="mt-0.5"
            />
            <span>
              {t('keys.scope.whole')}
              <span className="block text-xs text-muted">{t('keys.scope.wholeHint')}</span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="radio"
              name="alcance"
              checked={limitToSessions}
              onChange={() => setLimitToSessions(true)}
              className="mt-0.5"
            />
            <span>
              {t('keys.scope.picked')}
              <span className="block text-xs text-muted">{t('keys.scope.pickedHint')}</span>
            </span>
          </label>

          {limitToSessions && (
            <div className="ml-6 flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 p-3">
              {sessions.length === 0 ? (
                <span className="text-xs text-warn">{t('keys.scope.noSessions')}</span>
              ) : (
                sessions.map((session) => (
                  <label key={session.id} className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={escolhidas.includes(session.id)}
                      onChange={() => alternar(session.id)}
                    />
                    <span>{session.name}</span>
                    <span className="text-xs text-muted">{statusLabel(t, session.status)}</span>
                  </label>
                ))
              )}
            </div>
          )}
        </fieldset>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('keys.field.expiry')}</span>
          <select
            value={validade}
            onChange={(e) => setValidade(e.target.value)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          >
            {VALIDADES.map((v) => (
              <option key={v.value} value={v.value}>
                {t(v.key, v.n ? { n: v.n } : undefined)}
              </option>
            ))}
          </select>
        </label>

        {emptyScope && (
          <p className="rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
            {t('keys.scope.empty')}
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || emptyScope}
          className="mt-1 self-start rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-fill transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t('keys.submitting') : t('keys.submit')}
        </button>
      </form>
    </Card>
  )
}

/**
 * The full token, once only.
 *
 * The server keeps just the hash: closing this screen without copying means
 * issuing another key. That is why it takes the form's place instead of
 * becoming a discreet notice in the corner — and why it does not disappear on
 * its own.
 */
function TokenRecemNascido({ emitida, onClose }: { emitida: ApiKeyCreated; onClose: () => void }) {
  const t = useT()
  const [copia, setCopia] = useState<'parado' | 'copiado' | 'falhou'>('parado')

  return (
    <Card title={t('keys.created.title', { name: emitida.key.name })}>
      <div className="flex flex-col gap-3">
        <p className="rounded-md bg-warn/10 px-3 py-2 text-sm text-warn">
          {t('keys.created.warning')}
        </p>

        <code className="block overflow-x-auto rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-xs break-all text-ink">
          {emitida.token}
        </code>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(emitida.token)
                setCopia('copiado')
              } catch {
                // The clipboard needs a secure context and permission; without
                // it the text above stays selectable, which is the way out.
                setCopia('falhou')
              }
            }}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-fill transition-opacity hover:opacity-90"
          >
            {copia === 'copiado' ? t('keys.created.copied') : t('keys.created.copy')}
          </button>

          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2"
          >
            {t('keys.created.done')}
          </button>

          {copia === 'falhou' && (
            <span className="text-xs text-muted">{t('keys.created.copyFailed')}</span>
          )}
        </div>

        <p className="text-xs text-muted">
          {t('keys.created.storage', { header: 'Authorization: Bearer …' })}
        </p>
      </div>
    </Card>
  )
}

function KeyRow({
  apiKey,
  sessions,
  aoRevogar,
}: {
  apiKey: ApiKeyRow
  sessions: SessionRow[]
  aoRevogar: () => void
}) {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const expirada = Boolean(apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date())
  const morta = Boolean(apiKey.revokedAt) || expirada

  const estado: { tone: Tone; key: TranslationKey } = apiKey.revokedAt
    ? { tone: 'hold', key: 'keys.state.revoked' }
    : expirada
      ? { tone: 'warn', key: 'keys.state.expired' }
      : { tone: 'ok', key: 'keys.state.active' }

  const alcance = apiKey.sessionScope
    ? apiKey.sessionScope.map((id) => sessions.find((s) => s.id === id)?.name ?? id).join(', ')
    : t('keys.scope.whole')

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line/60 py-3 last:border-0">
      <span className="min-w-0 flex-1">
        <span
          className={
            morta ? 'block text-sm text-muted line-through' : 'block text-sm font-medium text-ink'
          }
        >
          {apiKey.name}
        </span>
        <span className="block truncate text-xs text-muted">
          <code className="font-mono">{apiKey.prefix}</code> · {alcance} ·{' '}
          {apiKey.lastUsedAt
            ? t('keys.usedAgo', { when: since(apiKey.lastUsedAt) })
            : t('keys.neverUsed')}
          {apiKey.expiresAt &&
            !apiKey.revokedAt &&
            ` · ${t('keys.expiresOn', { when: dateTime(apiKey.expiresAt) })}`}
        </span>
      </span>

      <Pill tone={estado.tone}>{t(estado.key)}</Pill>

      {!apiKey.revokedAt &&
        (confirming ? (
          <span className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                await del(`/v1/keys/${apiKey.id}`).catch(() => undefined)
                aoRevogar()
              }}
              className="rounded-md bg-crit px-2.5 py-1.5 text-xs font-medium text-on-fill disabled:opacity-50"
            >
              {busy ? t('keys.revoking') : t('common.confirm')}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-xs text-muted hover:text-ink"
            >
              {t('common.cancel')}
            </button>
          </span>
        ) : (
          /* Revoking has no undo, and the next request with it takes a 401 on the spot. */
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-crit"
          >
            {t('keys.revoke')}
          </button>
        ))}
    </li>
  )
}
