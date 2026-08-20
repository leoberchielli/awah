import { AreaSeries, BarrasHorizontais, Funnel, SeriesPoint } from '../components/charts'
import { SessionFilter, Shell, useFilter } from '../components/Shell'
import { Card, Empty, Pill, Skeleton, Stat } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import { useT } from '../i18n'
import type { KpiDelivery, KpiRisk, KpiSessions, SessionRow } from '../lib/api'
import { duration, minutes, num, pct, since } from '../lib/format'
import { statusLabel, statusTone } from '../lib/sessionStatus'

/** Five seconds: fast enough to follow an incident, light enough to leave running. */
const POLL_MS = 5000

export function Operations() {
  const t = useT()
  const { query } = useFilter()

  const sessions = useQuery<{ sessions: SessionRow[] }>('/v1/sessions', POLL_MS)
  const delivery = useQuery<KpiDelivery>(`/v1/kpi/delivery?${query}`, POLL_MS)
  const risk = useQuery<KpiRisk>(`/v1/kpi/risk?${query}`, POLL_MS)
  const health = useQuery<KpiSessions>(`/v1/kpi/sessions?${query}`, POLL_MS)

  const list = sessions.data?.sessions ?? []
  const connected = list.filter((s) => s.status === 'connected').length
  const wantsToRun = list.filter((s) => s.desiredState === 'running').length

  return (
    <Shell actions={<SessionFilter sessions={list} />}>
      <div className="flex flex-col gap-4">
        <SummaryStrip
          connected={connected}
          wantsToRun={wantsToRun}
          delivery={delivery.data}
          risk={risk.data}
          loading={!delivery.settled}
        />

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t('ops.funnel')} hint={t('ops.funnelHint')} className="lg:col-span-1">
            {delivery.data ? (
              <Funnel
                steps={[
                  {
                    label: t('ops.funnel.sent'),
                    value: delivery.data.funnel.sent,
                    color: 'var(--accent)',
                  },
                  {
                    label: t('ops.funnel.delivered'),
                    value: delivery.data.funnel.delivered,
                    color: 'var(--ok)',
                  },
                  {
                    label: t('ops.funnel.read'),
                    value: delivery.data.funnel.read,
                    color: 'var(--ok)',
                  },
                  {
                    label: t('ops.funnel.failed'),
                    value: delivery.data.funnel.failed,
                    color: 'var(--crit)',
                    // Failed is measured against what was sent, not against what was read.
                    base: delivery.data.funnel.sent,
                  },
                ]}
              />
            ) : (
              <Skeleton className="h-36" />
            )}
          </Card>

          <Card
            title={t('ops.throughput')}
            hint={t('ops.throughputHint')}
            className="lg:col-span-2"
          >
            {delivery.data ? (
              <AreaSeries
                series={delivery.data.throughput}
                styles={[
                  { key: 'messages.outbound', label: 'Enviadas', color: 'var(--accent)' },
                  { key: 'messages.inbound', label: 'Recebidas', color: 'var(--ok)' },
                ]}
                height={210}
              />
            ) : (
              <Skeleton className="h-52" />
            )}
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t('ops.queue')} hint={t('ops.queueHint')}>
            {delivery.data ? (
              <div className="grid grid-cols-2 gap-4">
                <Stat
                  label={t('ops.queued')}
                  value={num(delivery.data.queue.queued)}
                  tone={delivery.data.queue.queued > 500 ? 'warn' : 'neutral'}
                />
                <Stat label={t('ops.sending')} value={num(delivery.data.queue.sending)} />
                <Stat
                  label={t('ops.dead')}
                  value={num(delivery.data.queue.dead)}
                  tone={delivery.data.queue.dead > 0 ? 'crit' : 'neutral'}
                  hint={t('ops.deadHint')}
                />
                <Stat
                  label={t('ops.deadWebhooks')}
                  value={num(delivery.data.webhooks.dead)}
                  tone={delivery.data.webhooks.dead > 0 ? 'warn' : 'neutral'}
                  hint={t('ops.webhooksDelivered', { n: num(delivery.data.webhooks.delivered) })}
                />
              </div>
            ) : (
              <Skeleton className="h-28" />
            )}
          </Card>

          <Card title={t('ops.riskDecisions')} hint={t('ops.riskDecisionsHint')}>
            {risk.data ? (
              <BarrasHorizontais
                height={180}
                data={[
                  {
                    label: t('ops.decision.allowed'),
                    value: risk.data.decisions.allowed,
                    color: 'var(--ok)',
                  },
                  {
                    label: t('ops.decision.delayed'),
                    value: risk.data.decisions.delayed,
                    color: 'var(--accent)',
                  },
                  {
                    label: t('ops.decision.throttled'),
                    value: risk.data.decisions.throttled,
                    color: 'var(--warn)',
                  },
                  {
                    label: t('ops.decision.held'),
                    value: risk.data.decisions.held,
                    color: 'var(--crit)',
                  },
                ]}
              />
            ) : (
              <Skeleton className="h-44" />
            )}
          </Card>

          <Card title={t('ops.riskScore')} hint={t('ops.riskScoreHint')}>
            {risk.data ? (
              <SeriesPoint
                series={risk.data.scoreSeries}
                styles={[{ key: 'risk.score.avg', label: 'Average score', color: 'var(--warn)' }]}
                height={180}
                domain={[0, 100]}
              />
            ) : (
              <Skeleton className="h-44" />
            )}
          </Card>
        </div>

        <Card title={t('ops.sessionHealth')} hint={t('ops.sessionHealthHint')}>
          {health.data ? (
            <HealthTable rows={health.data.sessions} />
          ) : (
            <Skeleton className="h-40" />
          )}
        </Card>
      </div>
    </Shell>
  )
}

function SummaryStrip({
  connected,
  wantsToRun,
  delivery,
  risk,
  loading,
}: {
  connected: number
  wantsToRun: number
  delivery: KpiDelivery | null
  risk: KpiRisk | null
  loading: boolean
}) {
  const t = useT()
  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="card p-4">
            <Skeleton className="h-12" />
          </div>
        ))}
      </div>
    )
  }

  const deliveryRate = delivery?.funnel.deliveryRate ?? 0
  const p95 = delivery?.latencyMs.p95 ?? null
  const held = risk?.decisions.held ?? 0

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <div className="card p-4">
        <Stat
          label={t('ops.connectedSessions')}
          value={`${connected}/${wantsToRun}`}
          tone={connected === wantsToRun ? 'ok' : connected === 0 ? 'crit' : 'warn'}
          hint={wantsToRun === 0 ? t('ops.noneRunning') : t('ops.ofWhatShouldRun')}
        />
      </div>
      <div className="card p-4">
        <Stat
          label={t('ops.deliveryRate')}
          value={pct(deliveryRate)}
          tone={deliveryRate >= 0.95 ? 'ok' : deliveryRate >= 0.85 ? 'warn' : 'crit'}
          hint={t('ops.ofTotal', {
            delivered: num(delivery?.funnel.delivered ?? 0),
            sent: num(delivery?.funnel.sent ?? 0),
          })}
        />
      </div>
      <div className="card p-4">
        <Stat
          label={t('ops.latencyP95')}
          value={duration(p95)}
          tone={p95 === null ? 'neutral' : p95 < 5000 ? 'ok' : p95 < 20000 ? 'warn' : 'crit'}
          hint={t('ops.latencyHint')}
        />
      </div>
      <div className="card p-4">
        <Stat
          label={t('ops.inQueue')}
          value={num(delivery?.queue.queued ?? 0)}
          tone={(delivery?.queue.queued ?? 0) > 500 ? 'warn' : 'neutral'}
          hint={t('ops.sendingNow', { n: num(delivery?.queue.sending ?? 0) })}
        />
      </div>
      <div className="card p-4">
        <Stat
          label={t('ops.heldByRisk')}
          value={num(held)}
          tone={held > 0 ? 'warn' : 'ok'}
          hint={t('ops.newContacts', { n: num(risk?.newContacts ?? 0) })}
        />
      </div>
    </div>
  )
}

function HealthTable({ rows }: { rows: KpiSessions['sessions'] }) {
  const t = useT()

  if (rows.length === 0) {
    return <Empty>{t('ops.noSessions')}</Empty>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <Th>{t('ops.col.session')}</Th>
            <Th>{t('ops.col.state')}</Th>
            <Th align="right">{t('ops.col.drops')}</Th>
            <Th align="right">{t('ops.col.reconnects')}</Th>
            <Th align="right">{t('ops.col.mtbf')}</Th>
            <Th>{t('ops.col.lastCause')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sessionId} className="border-b border-line/60 last:border-0">
              <td className="py-2.5 pr-3 font-medium text-ink">{row.name}</td>
              <td className="py-2.5 pr-3">
                <Pill tone={statusTone(row.status)}>{statusLabel(t, row.status)}</Pill>
              </td>
              <td
                className={`py-2.5 pr-3 text-right font-mono tnum ${
                  row.disconnects > 0 ? 'text-crit' : 'text-muted'
                }`}
              >
                {num(row.disconnects)}
              </td>
              <td className="py-2.5 pr-3 text-right font-mono text-muted tnum">
                {num(row.reconnects)}
              </td>
              <td className="py-2.5 pr-3 text-right font-mono text-ink tnum">
                {minutes(row.mtbfMinutes)}
              </td>
              <td className="py-2.5 text-xs text-muted">
                {row.lastCause ? (
                  <span title={row.lastDisconnectAt ?? undefined}>
                    {row.lastCause}
                    <span className="ml-1.5 opacity-70">{since(row.lastDisconnectAt)}</span>
                  </span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={`pb-2 pr-3 text-[11px] font-medium tracking-wide text-muted uppercase ${
        align === 'right' ? 'text-right' : ''
      }`}
    >
      {children}
    </th>
  )
}
