import { AreaSeries, BarrasHorizontais } from '../components/charts'
import { SessionFilter, Shell, useFilter } from '../components/Shell'
import { Card, Empty, Skeleton, Stat } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import { type Translate, type TranslationKey, useT } from '../i18n'
import type { KpiBusiness, SessionRow } from '../lib/api'
import { chat, dateTime, num, pct } from '../lib/format'

/** Business moves in minutes, not seconds. Half a minute is enough and costs less. */
const POLL_MS = 30_000

const KEY_BY_KIND: Record<string, TranslationKey> = {
  text: 'type.text',
  image: 'type.image',
  video: 'type.video',
  audio: 'type.audio',
  document: 'type.document',
  sticker: 'type.sticker',
  location: 'type.location',
  contact: 'type.contact',
  reaction: 'type.reaction',
  system: 'type.system',
}

/** An unknown type shows raw: better the protocol's name than a wrong label. */
function kindLabel(t: Translate, type: string): string {
  const key = KEY_BY_KIND[type]
  return key ? t(key) : type
}

export function Business() {
  const t = useT()
  const { query } = useFilter()

  const sessions = useQuery<{ sessions: SessionRow[] }>('/v1/sessions', 0)
  const business = useQuery<KpiBusiness>(`/v1/kpi/business?${query}`, POLL_MS)

  return (
    <Shell actions={<SessionFilter sessions={sessions.data?.sessions ?? []} />}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="card p-4">
            <Stat
              label={t('business.activeChats')}
              value={business.data ? num(business.data.activeChats) : '—'}
              hint={t('business.activeChatsHint')}
            />
          </div>
          <div className="card p-4">
            <Stat
              label={t('business.responseRate')}
              value={business.data ? pct(business.data.responseRate) : '—'}
              tone={
                !business.data
                  ? 'neutral'
                  : business.data.responseRate >= 0.9
                    ? 'ok'
                    : business.data.responseRate >= 0.7
                      ? 'warn'
                      : 'crit'
              }
              hint={t('business.responseRateHint')}
            />
          </div>
          <div className="card p-4">
            <Stat
              label={t('business.firstReplyMedian')}
              value={formatSeconds(business.data?.firstResponseSeconds.p50 ?? null)}
              hint={t('business.firstReplyMedianHint')}
            />
          </div>
          <div className="card p-4">
            <Stat
              label={t('business.firstReplyP95')}
              value={formatSeconds(business.data?.firstResponseSeconds.p95 ?? null)}
              tone={(business.data?.firstResponseSeconds.p95 ?? 0) > 3600 ? 'warn' : 'neutral'}
              hint={t('business.firstReplyP95Hint')}
            />
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card
            title={t('business.volume')}
            hint={t('business.volumeHint')}
            className="lg:col-span-2"
          >
            {business.data ? (
              <AreaSeries
                series={business.data.volume}
                styles={[
                  { key: 'messages.inbound', label: t('business.inbound'), color: 'var(--ok)' },
                  {
                    key: 'messages.outbound',
                    label: t('business.outbound'),
                    color: 'var(--accent)',
                  },
                ]}
                height={240}
              />
            ) : (
              <Skeleton className="h-60" />
            )}
          </Card>

          <Card title={t('business.messageTypes')} hint={t('business.messageTypesHint')}>
            {business.data ? (
              <BarrasHorizontais
                height={240}
                data={business.data.byType.slice(0, 8).map((entry) => ({
                  label: kindLabel(t, entry.type),
                  value: entry.count,
                }))}
              />
            ) : (
              <Skeleton className="h-60" />
            )}
          </Card>
        </div>

        <Card title={t('business.busiestChats')} hint={t('business.busiestChatsHint')}>
          {business.data ? (
            <ChatsTable rows={business.data.topChats} />
          ) : (
            <Skeleton className="h-40" />
          )}
        </Card>
      </div>
    </Shell>
  )
}

function ChatsTable({ rows }: { rows: KpiBusiness['topChats'] }) {
  const t = useT()

  if (rows.length === 0) {
    return <Empty>{t('business.noChats')}</Empty>
  }

  const max = Math.max(...rows.map((l) => l.messages), 1)

  return (
    <ul className="flex flex-col">
      {rows.map((row) => (
        <li
          key={row.chatId}
          className="flex items-center gap-3 border-b border-line/60 py-2.5 last:border-0"
        >
          <span className="w-40 shrink-0 truncate font-mono text-xs text-ink" title={row.chatId}>
            {chat(row.chatId, (id) => t('common.group', { id }))}
          </span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${(row.messages / max) * 100}%` }}
            />
          </span>
          <span className="w-14 shrink-0 text-right font-mono text-sm text-ink tnum">
            {num(row.messages)}
          </span>
          <span className="w-28 shrink-0 text-right text-xs text-muted">
            {dateTime(row.lastAt)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The p50 arrives in seconds and is almost never readable that way. */
function formatSeconds(value: number | null): string {
  if (value === null) return '—'
  if (value < 60) return `${Math.round(value)} s`
  if (value < 3600) return `${(value / 60).toFixed(1)} min`
  if (value < 86_400) return `${(value / 3600).toFixed(1)} h`
  return `${(value / 86_400).toFixed(1)} d`
}
