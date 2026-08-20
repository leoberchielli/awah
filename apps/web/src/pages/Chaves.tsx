import { type FormEvent, useState } from 'react'
import { Shell } from '../components/Shell'
import { Card, Empty, Pill, Skeleton, type Tone } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import { type TranslationKey, useT } from '../i18n'
import type { SessionRow } from '../lib/api'
import { ApiError, type ApiKeyCreated, type ApiKeyRow, del, type Papel, post } from '../lib/api'
import { dataHora, desde, statusDeSessao } from '../lib/format'
import { papelAoMenos, useMe } from '../lib/sessao'

const PAPEIS: Array<{ valor: Papel; rotulo: TranslationKey; resumo: TranslationKey }> = [
  { valor: 'viewer', rotulo: 'keys.role.viewer', resumo: 'keys.role.viewerSummary' },
  { valor: 'operator', rotulo: 'keys.role.operator', resumo: 'keys.role.operatorSummary' },
  { valor: 'admin', rotulo: 'keys.role.admin', resumo: 'keys.role.adminSummary' },
  { valor: 'owner', rotulo: 'keys.role.owner', resumo: 'keys.role.ownerSummary' },
]

const VALIDADES: Array<{ valor: string; chave: TranslationKey; n?: number }> = [
  { valor: '', chave: 'keys.expiry.never' },
  { valor: '30', chave: 'keys.expiry.days', n: 30 },
  { valor: '90', chave: 'keys.expiry.days', n: 90 },
  { valor: '365', chave: 'keys.expiry.year' },
]

export function Chaves() {
  const t = useT()
  const me = useMe()
  const podeAdministrar = papelAoMenos(me.role, 'admin')

  const chaves = useQuery<{ keys: ApiKeyRow[] }>(podeAdministrar ? '/v1/keys' : null)
  const sessoes = useQuery<{ sessions: SessionRow[] }>(podeAdministrar ? '/v1/sessions' : null)

  if (!podeAdministrar) {
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
          sessoes={sessoes.data?.sessions ?? []}
          papelDoUsuario={me.role}
          aoEmitir={chaves.refetch}
        />

        <Card title={t('keys.list.title')} hint={t('keys.list.hint')}>
          {!chaves.settled ? (
            <Skeleton className="h-24" />
          ) : (chaves.data?.keys.length ?? 0) === 0 ? (
            <Empty>{t('keys.list.empty')}</Empty>
          ) : (
            <ul className="flex flex-col">
              {chaves.data?.keys.map((chave) => (
                <LinhaDeChave
                  key={chave.id}
                  chave={chave}
                  sessoes={sessoes.data?.sessions ?? []}
                  aoRevogar={chaves.refetch}
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
  sessoes,
  papelDoUsuario,
  aoEmitir,
}: {
  sessoes: SessionRow[]
  papelDoUsuario: Papel
  aoEmitir: () => void
}) {
  const t = useT()
  const [nome, setNome] = useState('')
  const [papel, setPapel] = useState<Papel>('operator')
  const [limitarSessoes, setLimitarSessoes] = useState(false)
  const [escolhidas, setEscolhidas] = useState<string[]>([])
  const [validade, setValidade] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [emitida, setEmitida] = useState<ApiKeyCreated | null>(null)

  /** Ninguém emite chave mais poderosa que o próprio papel — o servidor recusa. */
  const disponiveis = PAPEIS.filter((p) => papelAoMenos(papelDoUsuario, p.valor))
  const escopoVazio = limitarSessoes && escolhidas.length === 0

  function alternar(id: string) {
    setEscolhidas((atual) => (atual.includes(id) ? atual.filter((x) => x !== id) : [...atual, id]))
  }

  async function emitir(evento: FormEvent) {
    evento.preventDefault()
    setOcupado(true)
    setErro(null)

    try {
      const resposta = await post<ApiKeyCreated>('/v1/keys', {
        name: nome.trim(),
        role: papel,
        // Omitido de propósito quando a chave vale para a organização inteira:
        // lista vazia significaria "não alcança nada", que é outra coisa.
        ...(limitarSessoes ? { sessionScope: escolhidas } : {}),
        ...(validade ? { expiresInDays: Number(validade) } : {}),
      })

      setEmitida(resposta)
      setNome('')
      setEscolhidas([])
      setLimitarSessoes(false)
      setValidade('')
      aoEmitir()
    } catch (falha) {
      setErro(falha instanceof ApiError ? falha.message : t('keys.failed'))
    } finally {
      setOcupado(false)
    }
  }

  if (emitida) {
    return <TokenRecemNascido emitida={emitida} aoFechar={() => setEmitida(null)} />
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
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder={t('keys.field.namePlaceholder')}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
          />
          <span className="text-xs text-muted">{t('keys.field.nameHint')}</span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('keys.field.role')}</span>
          <select
            value={papel}
            onChange={(e) => setPapel(e.target.value as Papel)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          >
            {disponiveis.map((p) => (
              <option key={p.valor} value={p.valor}>
                {t(p.rotulo)} — {t(p.resumo)}
              </option>
            ))}
          </select>
          {/* O limite é a razão de existir da separação de credenciais. */}
          <span className="text-xs text-muted">{t('keys.field.roleHint')}</span>
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="eyebrow mb-1.5">{t('keys.field.scope')}</legend>

          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="radio"
              name="alcance"
              checked={!limitarSessoes}
              onChange={() => setLimitarSessoes(false)}
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
              checked={limitarSessoes}
              onChange={() => setLimitarSessoes(true)}
              className="mt-0.5"
            />
            <span>
              {t('keys.scope.picked')}
              <span className="block text-xs text-muted">{t('keys.scope.pickedHint')}</span>
            </span>
          </label>

          {limitarSessoes && (
            <div className="ml-6 flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 p-3">
              {sessoes.length === 0 ? (
                <span className="text-xs text-warn">{t('keys.scope.noSessions')}</span>
              ) : (
                sessoes.map((sessao) => (
                  <label key={sessao.id} className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={escolhidas.includes(sessao.id)}
                      onChange={() => alternar(sessao.id)}
                    />
                    <span>{sessao.name}</span>
                    <span className="text-xs text-muted">{statusDeSessao(sessao.status)}</span>
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
              <option key={v.valor} value={v.valor}>
                {t(v.chave, v.n ? { n: v.n } : undefined)}
              </option>
            ))}
          </select>
        </label>

        {escopoVazio && (
          <p className="rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
            {t('keys.scope.empty')}
          </p>
        )}

        {erro && (
          <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
            {erro}
          </p>
        )}

        <button
          type="submit"
          disabled={ocupado || escopoVazio}
          className="mt-1 self-start rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {ocupado ? t('keys.submitting') : t('keys.submit')}
        </button>
      </form>
    </Card>
  )
}

/**
 * O token completo, uma vez só.
 *
 * O servidor guarda apenas o hash: fechar esta tela sem copiar significa emitir
 * outra chave. Por isso ela ocupa o lugar do formulário em vez de virar um
 * aviso discreto no canto — e não some sozinha.
 */
function TokenRecemNascido({
  emitida,
  aoFechar,
}: {
  emitida: ApiKeyCreated
  aoFechar: () => void
}) {
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
                // Área de transferência exige contexto seguro e permissão; sem
                // ela o texto acima continua selecionável, que é a saída.
                setCopia('falhou')
              }
            }}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            {copia === 'copiado' ? t('keys.created.copied') : t('keys.created.copy')}
          </button>

          <button
            type="button"
            onClick={aoFechar}
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

function LinhaDeChave({
  chave,
  sessoes,
  aoRevogar,
}: {
  chave: ApiKeyRow
  sessoes: SessionRow[]
  aoRevogar: () => void
}) {
  const t = useT()
  const [confirmando, setConfirmando] = useState(false)
  const [ocupado, setOcupado] = useState(false)

  const expirada = Boolean(chave.expiresAt && new Date(chave.expiresAt) < new Date())
  const morta = Boolean(chave.revokedAt) || expirada

  const estado: { tone: Tone; chave: TranslationKey } = chave.revokedAt
    ? { tone: 'hold', chave: 'keys.state.revoked' }
    : expirada
      ? { tone: 'warn', chave: 'keys.state.expired' }
      : { tone: 'ok', chave: 'keys.state.active' }

  const alcance = chave.sessionScope
    ? chave.sessionScope.map((id) => sessoes.find((s) => s.id === id)?.name ?? id).join(', ')
    : t('keys.scope.whole')

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line/60 py-3 last:border-0">
      <span className="min-w-0 flex-1">
        <span
          className={
            morta ? 'block text-sm text-muted line-through' : 'block text-sm font-medium text-ink'
          }
        >
          {chave.name}
        </span>
        <span className="block truncate text-xs text-muted">
          <code className="font-mono">{chave.prefix}</code> · {alcance} ·{' '}
          {chave.lastUsedAt
            ? t('keys.usedAgo', { when: desde(chave.lastUsedAt) })
            : t('keys.neverUsed')}
          {chave.expiresAt &&
            !chave.revokedAt &&
            ` · ${t('keys.expiresOn', { when: dataHora(chave.expiresAt) })}`}
        </span>
      </span>

      <Pill tone={estado.tone}>{t(estado.chave)}</Pill>

      {!chave.revokedAt &&
        (confirmando ? (
          <span className="flex items-center gap-2">
            <button
              type="button"
              disabled={ocupado}
              onClick={async () => {
                setOcupado(true)
                await del(`/v1/keys/${chave.id}`).catch(() => undefined)
                aoRevogar()
              }}
              className="rounded-md bg-crit px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {ocupado ? t('keys.revoking') : t('common.confirm')}
            </button>
            <button
              type="button"
              onClick={() => setConfirmando(false)}
              className="text-xs text-muted hover:text-ink"
            >
              {t('common.cancel')}
            </button>
          </span>
        ) : (
          /* Revogar não tem volta, e a próxima requisição com ela leva 401 na hora. */
          <button
            type="button"
            onClick={() => setConfirmando(true)}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-crit"
          >
            {t('keys.revoke')}
          </button>
        ))}
    </li>
  )
}
