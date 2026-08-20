import { type FormEvent, useState } from 'react'
import { Shell } from '../components/Shell'
import { Card, Empty, Pill, Skeleton } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import { type TranslationKey, useT } from '../i18n'
import { ApiError, del, type Member, patch, post, type Role } from '../lib/api'
import { dateTime } from '../lib/format'
import { roleAtLeast, useMe } from '../lib/session'

const PAPEIS: Array<{ value: Role; label: TranslationKey }> = [
  { value: 'viewer', label: 'keys.role.viewer' },
  { value: 'operator', label: 'keys.role.operator' },
  { value: 'admin', label: 'keys.role.admin' },
  { value: 'owner', label: 'keys.role.owner' },
]

export function Users() {
  const t = useT()
  const me = useMe()
  const canEdit = roleAtLeast(me.role, 'admin')

  const members = useQuery<{ members: Member[] }>('/v1/org/members')
  const list = members.data?.members ?? []
  const owners = list.filter((m) => m.role === 'owner').length

  return (
    <Shell>
      <div className="flex flex-col gap-4">
        {canEdit && <Convite viewerRole={me.role} aoConvidar={members.refetch} />}

        <Card title={t('users.list.title')} hint={t('users.list.hint')}>
          {!members.settled ? (
            <Skeleton className="h-24" />
          ) : list.length === 0 ? (
            <Empty>{t('users.list.empty')}</Empty>
          ) : (
            <ul className="flex flex-col">
              {list.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  souEu={member.userId === me.userId}
                  lastOwner={member.role === 'owner' && owners <= 1}
                  viewerRole={me.role}
                  canEdit={canEdit}
                  onChange={members.refetch}
                />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </Shell>
  )
}

function Convite({ viewerRole, aoConvidar }: { viewerRole: Role; aoConvidar: () => void }) {
  const t = useT()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('viewer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Nobody promotes above their own role — the server refuses either way. */
  const available = PAPEIS.filter((p) => roleAtLeast(viewerRole, p.value))
  const passwordTooShort = password.length > 0 && password.length < 12

  async function convidar(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)

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
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('users.addFailed'))
    } finally {
      setBusy(false)
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
            onChange={(e) => setRole(e.target.value as Role)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          >
            {available.map((p) => (
              <option key={p.value} value={p.value}>
                {t(p.label)}
              </option>
            ))}
          </select>
        </label>

        {passwordTooShort && (
          <p className="rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
            {t('setup.passwordShort')}
          </p>
        )}

        {error && (
          <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || passwordTooShort}
          className="mt-1 self-start rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-fill transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t('users.adding') : t('users.add.submit')}
        </button>
      </form>
    </Card>
  )
}

function MemberRow({
  member,
  souEu,
  lastOwner,
  viewerRole,
  canEdit,
  onChange,
}: {
  member: Member
  souEu: boolean
  /** The server refuses to demote or remove the last owner; the screen says so first. */
  lastOwner: boolean
  viewerRole: Role
  canEdit: boolean
  onChange: () => void
}) {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const available = PAPEIS.filter((p) => roleAtLeast(viewerRole, p.value))
  const locked = lastOwner || !canEdit

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      onChange()
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('users.changeFailed'))
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line/60 py-3 last:border-0">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">
          {member.name}
          {souEu && <span className="ml-1.5 text-xs font-normal text-muted">{t('users.you')}</span>}
        </span>
        <span className="block truncate text-xs text-muted">
          {member.email} · {t('users.joined', { when: dateTime(member.joinedAt) })}
        </span>
      </span>

      {lastOwner && <Pill tone="hold">{t('users.lastOwner')}</Pill>}

      {canEdit ? (
        <select
          value={member.role}
          disabled={busy || locked}
          onChange={(e) =>
            run(() => patch(`/v1/org/members/${member.userId}`, { role: e.target.value }))
          }
          className="rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink disabled:opacity-50"
        >
          {available.map((p) => (
            <option key={p.value} value={p.value}>
              {t(p.label)}
            </option>
          ))}
        </select>
      ) : (
        <Pill tone="ok">
          {t(PAPEIS.find((p) => p.value === member.role)?.label ?? 'keys.role.viewer')}
        </Pill>
      )}

      {canEdit &&
        !lastOwner &&
        (confirming ? (
          <span className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => del(`/v1/org/members/${member.userId}`))}
              className="rounded-md bg-crit px-2.5 py-1.5 text-xs font-medium text-on-fill disabled:opacity-50"
            >
              {busy ? t('users.removing') : t('common.confirm')}
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
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:text-crit"
          >
            {souEu ? t('users.leave') : t('users.remove')}
          </button>
        ))}

      {error && <p className="w-full text-xs text-crit">{error}</p>}
    </li>
  )
}
