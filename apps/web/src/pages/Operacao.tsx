import { AreaSerie, BarrasHorizontais, Funil, LinhaSerie } from '../components/charts'
import { FiltroDeSessao, Shell, useFiltro } from '../components/Shell'
import { Card, Empty, Pill, Skeleton, Stat } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import { useT } from '../i18n'
import type { KpiDelivery, KpiRisk, KpiSessions, SessionRow } from '../lib/api'
import { desde, duracao, minutos, num, pct } from '../lib/format'
import { statusLabel, statusTone } from '../lib/sessionStatus'

/** Cinco segundos: rápido o bastante para acompanhar um incidente, leve o bastante para deixar ligado. */
const POLL_MS = 5000

export function Operacao() {
  const t = useT()
  const { query } = useFiltro()

  const sessoes = useQuery<{ sessions: SessionRow[] }>('/v1/sessions', POLL_MS)
  const entrega = useQuery<KpiDelivery>(`/v1/kpi/delivery?${query}`, POLL_MS)
  const risco = useQuery<KpiRisk>(`/v1/kpi/risk?${query}`, POLL_MS)
  const saude = useQuery<KpiSessions>(`/v1/kpi/sessions?${query}`, POLL_MS)

  const lista = sessoes.data?.sessions ?? []
  const conectadas = lista.filter((s) => s.status === 'connected').length
  const querRodar = lista.filter((s) => s.desiredState === 'running').length

  return (
    <Shell acoes={<FiltroDeSessao sessoes={lista} />}>
      <div className="flex flex-col gap-4">
        <FaixaDeResumo
          conectadas={conectadas}
          querRodar={querRodar}
          entrega={entrega.data}
          risco={risco.data}
          carregando={!entrega.settled}
        />

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t('ops.funnel')} hint={t('ops.funnelHint')} className="lg:col-span-1">
            {entrega.data ? (
              <Funil
                etapas={[
                  {
                    rotulo: t('ops.funnel.sent'),
                    valor: entrega.data.funnel.sent,
                    cor: 'var(--accent)',
                  },
                  {
                    rotulo: t('ops.funnel.delivered'),
                    valor: entrega.data.funnel.delivered,
                    cor: 'var(--ok)',
                  },
                  {
                    rotulo: t('ops.funnel.read'),
                    valor: entrega.data.funnel.read,
                    cor: 'var(--ok)',
                  },
                  {
                    rotulo: t('ops.funnel.failed'),
                    valor: entrega.data.funnel.failed,
                    cor: 'var(--crit)',
                    // Falha se mede contra o que foi enviado, não contra o que foi lido.
                    base: entrega.data.funnel.sent,
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
            {entrega.data ? (
              <AreaSerie
                series={entrega.data.throughput}
                visuais={[
                  { key: 'messages.outbound', label: 'Enviadas', color: 'var(--accent)' },
                  { key: 'messages.inbound', label: 'Recebidas', color: 'var(--ok)' },
                ]}
                altura={210}
              />
            ) : (
              <Skeleton className="h-52" />
            )}
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={t('ops.queue')} hint={t('ops.queueHint')}>
            {entrega.data ? (
              <div className="grid grid-cols-2 gap-4">
                <Stat
                  label={t('ops.queued')}
                  value={num(entrega.data.queue.queued)}
                  tone={entrega.data.queue.queued > 500 ? 'warn' : 'neutral'}
                />
                <Stat label={t('ops.sending')} value={num(entrega.data.queue.sending)} />
                <Stat
                  label={t('ops.dead')}
                  value={num(entrega.data.queue.dead)}
                  tone={entrega.data.queue.dead > 0 ? 'crit' : 'neutral'}
                  hint={t('ops.deadHint')}
                />
                <Stat
                  label={t('ops.deadWebhooks')}
                  value={num(entrega.data.webhooks.dead)}
                  tone={entrega.data.webhooks.dead > 0 ? 'warn' : 'neutral'}
                  hint={t('ops.webhooksDelivered', { n: num(entrega.data.webhooks.delivered) })}
                />
              </div>
            ) : (
              <Skeleton className="h-28" />
            )}
          </Card>

          <Card title={t('ops.riskDecisions')} hint={t('ops.riskDecisionsHint')}>
            {risco.data ? (
              <BarrasHorizontais
                altura={180}
                dados={[
                  {
                    rotulo: t('ops.decision.allowed'),
                    valor: risco.data.decisions.allowed,
                    cor: 'var(--ok)',
                  },
                  {
                    rotulo: t('ops.decision.delayed'),
                    valor: risco.data.decisions.delayed,
                    cor: 'var(--accent)',
                  },
                  {
                    rotulo: t('ops.decision.throttled'),
                    valor: risco.data.decisions.throttled,
                    cor: 'var(--warn)',
                  },
                  {
                    rotulo: t('ops.decision.held'),
                    valor: risco.data.decisions.held,
                    cor: 'var(--crit)',
                  },
                ]}
              />
            ) : (
              <Skeleton className="h-44" />
            )}
          </Card>

          <Card title={t('ops.riskScore')} hint={t('ops.riskScoreHint')}>
            {risco.data ? (
              <LinhaSerie
                series={risco.data.scoreSeries}
                visuais={[{ key: 'risk.score.avg', label: 'Score médio', color: 'var(--warn)' }]}
                altura={180}
                dominio={[0, 100]}
              />
            ) : (
              <Skeleton className="h-44" />
            )}
          </Card>
        </div>

        <Card title={t('ops.sessionHealth')} hint={t('ops.sessionHealthHint')}>
          {saude.data ? (
            <TabelaDeSaude linhas={saude.data.sessions} />
          ) : (
            <Skeleton className="h-40" />
          )}
        </Card>
      </div>
    </Shell>
  )
}

function FaixaDeResumo({
  conectadas,
  querRodar,
  entrega,
  risco,
  carregando,
}: {
  conectadas: number
  querRodar: number
  entrega: KpiDelivery | null
  risco: KpiRisk | null
  carregando: boolean
}) {
  const t = useT()
  if (carregando) {
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

  const taxa = entrega?.funnel.deliveryRate ?? 0
  const p95 = entrega?.latencyMs.p95 ?? null
  const segurado = risco?.decisions.held ?? 0

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <div className="card p-4">
        <Stat
          label={t('ops.connectedSessions')}
          value={`${conectadas}/${querRodar}`}
          tone={conectadas === querRodar ? 'ok' : conectadas === 0 ? 'crit' : 'warn'}
          hint={querRodar === 0 ? t('ops.noneRunning') : t('ops.ofWhatShouldRun')}
        />
      </div>
      <div className="card p-4">
        <Stat
          label={t('ops.deliveryRate')}
          value={pct(taxa)}
          tone={taxa >= 0.95 ? 'ok' : taxa >= 0.85 ? 'warn' : 'crit'}
          hint={t('ops.ofTotal', {
            delivered: num(entrega?.funnel.delivered ?? 0),
            sent: num(entrega?.funnel.sent ?? 0),
          })}
        />
      </div>
      <div className="card p-4">
        <Stat
          label={t('ops.latencyP95')}
          value={duracao(p95)}
          tone={p95 === null ? 'neutral' : p95 < 5000 ? 'ok' : p95 < 20000 ? 'warn' : 'crit'}
          hint={t('ops.latencyHint')}
        />
      </div>
      <div className="card p-4">
        <Stat
          label={t('ops.inQueue')}
          value={num(entrega?.queue.queued ?? 0)}
          tone={(entrega?.queue.queued ?? 0) > 500 ? 'warn' : 'neutral'}
          hint={t('ops.sendingNow', { n: num(entrega?.queue.sending ?? 0) })}
        />
      </div>
      <div className="card p-4">
        <Stat
          label={t('ops.heldByRisk')}
          value={num(segurado)}
          tone={segurado > 0 ? 'warn' : 'ok'}
          hint={t('ops.newContacts', { n: num(risco?.newContacts ?? 0) })}
        />
      </div>
    </div>
  )
}

function TabelaDeSaude({ linhas }: { linhas: KpiSessions['sessions'] }) {
  const t = useT()

  if (linhas.length === 0) {
    return <Empty>{t('ops.noSessions')}</Empty>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <Th>{t('ops.col.session')}</Th>
            <Th>{t('ops.col.state')}</Th>
            <Th alinhamento="right">{t('ops.col.drops')}</Th>
            <Th alinhamento="right">{t('ops.col.reconnects')}</Th>
            <Th alinhamento="right">{t('ops.col.mtbf')}</Th>
            <Th>{t('ops.col.lastCause')}</Th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((linha) => (
            <tr key={linha.sessionId} className="border-b border-line/60 last:border-0">
              <td className="py-2.5 pr-3 font-medium text-ink">{linha.name}</td>
              <td className="py-2.5 pr-3">
                <Pill tone={statusTone(linha.status)}>{statusLabel(t, linha.status)}</Pill>
              </td>
              <td
                className={`py-2.5 pr-3 text-right font-mono tnum ${
                  linha.disconnects > 0 ? 'text-crit' : 'text-muted'
                }`}
              >
                {num(linha.disconnects)}
              </td>
              <td className="py-2.5 pr-3 text-right font-mono text-muted tnum">
                {num(linha.reconnects)}
              </td>
              <td className="py-2.5 pr-3 text-right font-mono text-ink tnum">
                {minutos(linha.mtbfMinutes)}
              </td>
              <td className="py-2.5 text-xs text-muted">
                {linha.lastCause ? (
                  <span title={linha.lastDisconnectAt ?? undefined}>
                    {linha.lastCause}
                    <span className="ml-1.5 opacity-70">{desde(linha.lastDisconnectAt)}</span>
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

function Th({
  children,
  alinhamento = 'left',
}: {
  children: React.ReactNode
  alinhamento?: 'left' | 'right'
}) {
  return (
    <th
      scope="col"
      className={`pb-2 pr-3 text-[11px] font-medium tracking-wide text-muted uppercase ${
        alinhamento === 'right' ? 'text-right' : ''
      }`}
    >
      {children}
    </th>
  )
}
