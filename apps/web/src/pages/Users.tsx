import { type FormEvent, useState } from 'react'
import { Shell } from '../components/Shell'
import { Card, Empty, Pill, Skeleton } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import { type TranslationKey, useT } from '../i18n'
import { ApiError, del, type Member, type Papel, patch, post } from '../lib/api'
import { dataHora } from '../lib/format'
import { papelAoMenos, useMe } from '../lib/sessao'

const PAPEIS: Array<{ valor: Papel; rotulo: TranslationKey }> = [
  { valor: 'viewer', rotulo: 'keys.role.viewer' },
  { valor: 'operator', rotulo: 'keys.role.operator' },
  { valor: 'admin', rotulo: 'keys.role.admin' },
  { valor: 'owner', rotulo: 'keys.role.owner' },
]

export function Users() {
  const t = useT()
  const me = useMe()
  const podeEditar = papelAoMenos(me.role, 'admin')

  const membros = useQuery<{ members: Member[] }>('/v1/org/members')
  const lista = membros.data?.members ?? []
  const donos = lista.filter((m) => m.role === 'owner').length

  return (
    <Shell>
      <div className="flex flex-col gap-4">
        {podeEditar && <Convite papelDoUsuario={me.role} aoConvidar={membros.refetch} />}

        <Card title={t('users.list.title')} hint={t('users.list.hint')}>
          {!membros.settled ? (
            <Skeleton className="h-24" />
          ) : lista.length === 0 ? (
            <Empty>{t('users.list.empty')}</Empty>
          ) : (
            <ul className="flex flex-col">
              {lista.map((membro) => (
                <LinhaDeMembro
                  key={membro.userId}
                  membro={membro}
                  souEu={membro.userId === me.userId}
                  ultimoDono={membro.role === 'owner' && donos <= 1}
                  papelDoUsuario={me.role}
                  podeEditar={podeEditar}
                  aoMudar={membros.refetch}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Shell>
  )
}

function Convite({
  papelDoUsuario,
  aoConvidar,
}: {
  papelDoUsuario: Papel
  aoConvidar: () => void
}) {
  const t = useT()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Papel>('viewer')
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  /** Nobody promotes above their own role — the server refuses either way. */
  const disponiveis = PAPEIS.filter((p) => papelAoMenos(papelDoUsuario, p.valor))
  const senhaCurta = password.length > 0 && password.length < 12

  async function convidar(evento: FormEvent) {
    evento.preventDefault()
    setOcupado(true)
    setErro(null)

    try {
      await post('/v1/org/members', {
        email: email.trim(),
        role,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(password ? { password } : {}),
      })
      setEmail('')
      setName('')
      setPassword('')
      setRole('viewer')
      aoConvidar()
    } catch (falha) {
      setErro(falha instanceof ApiError ? falha.message : t('users.addFailed'))
    } finally {
      setOcupado(false)
    }
  }

  return (
    <Card title={t('users.add.title')} hint={t('users.add.hint')}>
      <form onSubmit={convidar} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('login.email')}</span>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">{t('setup.yourName')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">{t('login.password')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
            />
          </label>
        </div>

        {/*
          Name and password only come into play when the email does not yet
          exist on this instance. Saying so here heads off the reading that they
          are required, and that inviting someone who already has an account
          means inventing a password for them.
        */}
        <p className="text-xs text-muted">{t('users.add.credentialsHint')}</p>

        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">{t('keys.field.role')}</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Papel)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          >
            {disponiveis.map((p) => (
              <option key={p.valor} value={p.valor}>
                {t(p.rotulo)}
              </option>
            ))}
          </select>
        </label>

        {senhaCurta && (
          <p className="rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
            {t('setup.passwordShort')}
          </p>
        )}

        {erro && (
          <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
            {erro}
          </p>
        )}

        <button
          type="submit"
          disabled={ocupado || senhaCurta}
          className="mt-1 self-start rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-fill transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {ocupado ? t('users.adding') : t('users.add.submit')}
        </button>
      </form>
    </Card>
  )
}

function LinhaDeMembro({
  membro,
  souEu,
  ultimoDono,
  papelDoUsuario,
  podeEditar,
  aoMudar,
}: {
  membro: Member
  souEu: boolean
  /** The server refuses to demote or remove the last owner; the screen says so first. */
  ultimoDono: boolean
  papelDoUsuario: Papel
  podeEditar: boolean
  aoMudar: () => void
}) {
  const t = useT()
  const [confirmando, setConfirmando] = useState(false)
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const disponiveis = PAPEIS.filter((p) => papelAoMenos(papelDoUsuario, p.valor))
  const travado = ultimoDono || !podeEditar

  async function agir(acao: () => Promise<unknown>) {
    setOcupado(true)
    setErro(null)
    try {
      await acao()
      aoMudar()
    } catch (falha) {
      setErro(falha instanceof ApiError ? falha.message : t('users.changeFailed'))
    } finally {
      setOcupado(false)
      setConfirmando(false)
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line/60 py-3 last:border-0">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">
          {membro.name}
          {souEu && <span className="ml-1.5 text-xs font-normal text-muted">{t('users.you')}</span>}
        </span>
        <span className="block truncate text-xs text-muted">
          {membro.email} · {t('users.joined', { when: dataHora(membro.joinedAt) })}
        </span>
      </span>

      {ultimoDono && <Pill tone="hold">{t('users.lastOwner')}</Pill>}

      {podeEditar ? (
        <select
          value={membro.role}
          disabled={ocupado || travado}
          onChange={(e) =>
            agir(() => patch(`/v1/org/members/${membro.userId}`, { role: e.target.value }))
          }
          className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink disabled:opacity-50"
        >
          {disponiveis.map((p) => (
            <option key={p.valor} value={p.valor}>
              {t(p.rotulo)}
            </option>
          ))}
        </select>
      ) : (
        <Pill tone="ok">
          {t(PAPEIS.find((p) => p.valor === membro.role)?.rotulo ?? 'keys.role.viewer')}
        </Pill>
      )}

      {podeEditar &&
        !ultimoDono &&
        (confirmando ? (
          <span className="flex items-center gap-2">
            <button
              type="button"
              disabled={ocupado}
              onClick={() => agir(() => del(`/v1/org/members/${membro.userId}`))}
              className="rounded-md bg-crit px-2.5 py-1.5 text-xs font-medium text-on-fill disabled:opacity-50"
            >
              {ocupado ? t('users.removing') : t('common.confirm')}
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
          <button
            type="button"
            onClick={() => setConfirmando(true)}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-crit"
          >
            {souEu ? t('users.leave') : t('users.remove')}
          </button>
        ))}

      {erro && <p className="w-full text-xs text-crit">{erro}</p>}
    </li>
  )
}
