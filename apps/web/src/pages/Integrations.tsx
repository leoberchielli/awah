import { useState } from 'react'
import { Shell } from '../components/Shell'
import { Card, Empty, Pill, Skeleton } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import { type TranslationKey, useT } from '../i18n'
import type { Integration, SessionRow } from '../lib/api'
import { del } from '../lib/api'
import { dateTime } from '../lib/format'
import { ChatwootWizard } from './integrations/ChatwootWizard'
import { HttpWizard } from './integrations/HttpWizard'
import { TypebotWizard } from './integrations/TypebotWizard'

const NAMES: Record<Integration['kind'], TranslationKey> = {
  chatwoot: 'integrations.kind.chatwoot',
  typebot: 'integrations.kind.typebot',
  http: 'integrations.kind.http',
}

export function Integrations() {
  const t = useT()
  const sessions = useQuery<{ sessions: SessionRow[] }>('/v1/sessions', 0)
  const integrations = useQuery<{ integrations: Integration[] }>('/v1/integrations', 10_000)

  const list = sessions.data?.sessions ?? []

  return (
    <Shell>
      <div className="flex flex-col gap-4">
        <Card title={t('integrations.list.title')} hint={t('integrations.list.hint')}>
          {!integrations.settled ? (
            <Skeleton className="h-24" />
          ) : (integrations.data?.integrations.length ?? 0) === 0 ? (
            <Empty>{t('integrations.list.empty')}</Empty>
          ) : (
            <ul className="flex flex-col">
              {integrations.data?.integrations.map((entry) => (
                <IntegrationRow
                  key={entry.id}
                  integration={entry}
                  session={list.find((s) => s.id === entry.sessionId)}
                  onChange={integrations.refetch}
                />
              ))}
            </ul>
          )}
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-2">
          <ChatwootWizard sessions={list} onSave={integrations.refetch} />
          <TypebotWizard sessions={list} onSave={integrations.refetch} />
          <HttpWizard sessions={list} onSave={integrations.refetch} />
        </div>
      </div>
    </Shell>
  )
}

function IntegrationRow({
  integration,
  session,
  onChange,
}: {
  integration: Integration
  session?: SessionRow
  onChange: () => void
}) {
  const t = useT()
  const [removing, setRemoving] = useState(false)

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line py-3 last:border-0">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{t(NAMES[integration.kind])}</span>
        <span className="block truncate text-xs text-muted">
          {session?.name ?? integration.sessionId} ·{' '}
          {t('integrations.since', { when: dateTime(integration.createdAt) })}
        </span>
      </span>

      {/* Silence on the tool's side has an explanation, and it lives here. */}
      {integration.lastError ? (
        <Pill tone="crit">{t('integrations.state.error')}</Pill>
      ) : (
        <Pill tone={integration.active ? 'ok' : 'hold'}>
          {integration.active ? t('integrations.state.active') : t('integrations.state.paused')}
        </Pill>
      )}

      <button
        type="button"
        disabled={removing}
        onClick={async () => {
          setRemoving(true)
          await del(`/v1/integrations/${integration.id}`).catch(() => undefined)
          onChange()
        }}
        className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-crit hover:bg-surface-2 disabled:opacity-50"
      >
        {t('integrations.disconnect')}
      </button>

      {integration.lastError && (
        <p className="w-full rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
          {integration.lastError}
          {integration.lastErrorAt && (
            <span className="ml-1.5 opacity-70">({dateTime(integration.lastErrorAt)})</span>
          )}
        </p>
      )}
    </li>
  )
}
