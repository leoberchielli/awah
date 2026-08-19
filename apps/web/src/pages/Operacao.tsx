import { AreaSerie, BarrasHorizontais, Funil, LinhaSerie } from '../components/charts'
import { FiltroDeSessao, Shell, useFiltro } from '../components/Shell'
import { Card, Empty, Pill, Skeleton, Stat, type Tone } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import type { KpiDelivery, KpiRisk, KpiSessions, SessionRow } from '../lib/api'
import { desde, duracao, minutos, num, pct } from '../lib/format'

/** Cinco segundos: rápido o bastante para acompanhar um incidente, leve o bastante para deixar ligado. */
const POLL_MS = 5000

export function Operacao() {
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
          <Card
            title="Funil de entrega"
            hint="Onde a mensagem para de avançar."
            className="lg:col-span-1"
          >
            {entrega.data ? (
              <Funil
                etapas={[
                  { rotulo: 'Enviadas', valor: entrega.data.funnel.sent, cor: 'var(--accent)' },
                  {
                    rotulo: 'Entregues',
                    valor: entrega.data.funnel.delivered,
                    cor: 'var(--ok)',
                  },
                  { rotulo: 'Lidas', valor: entrega.data.funnel.read, cor: 'var(--ok)' },
                  {
                    rotulo: 'Falhas',
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

          <Card title="Vazão" hint="Enviadas e recebidas por hora." className="lg:col-span-2">
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
          <Card title="Fila e reentregas" hint="Estado do momento, não do período.">
            {entrega.data ? (
              <div className="grid grid-cols-2 gap-4">
                <Stat
                  label="Aguardando"
                  value={num(entrega.data.queue.queued)}
                  tone={entrega.data.queue.queued > 500 ? 'warn' : 'neutral'}
                />
                <Stat label="Em envio" value={num(entrega.data.queue.sending)} />
                <Stat
                  label="Descartadas"
                  value={num(entrega.data.queue.dead)}
                  tone={entrega.data.queue.dead > 0 ? 'crit' : 'neutral'}
                  hint="Esgotaram as tentativas."
                />
                <Stat
                  label="Webhooks mortos"
                  value={num(entrega.data.webhooks.dead)}
                  tone={entrega.data.webhooks.dead > 0 ? 'warn' : 'neutral'}
                  hint={`${num(entrega.data.webhooks.delivered)} entregues`}
                />
              </div>
            ) : (
              <Skeleton className="h-28" />
            )}
          </Card>

          <Card
            title="Decisões do motor de risco"
            hint="Nada é descartado; o que não passa, espera."
          >
            {risco.data ? (
              <BarrasHorizontais
                altura={180}
                dados={[
                  { rotulo: 'Liberadas', valor: risco.data.decisions.allowed, cor: 'var(--ok)' },
                  {
                    rotulo: 'Com atraso',
                    valor: risco.data.decisions.delayed,
                    cor: 'var(--accent)',
                  },
                  {
                    rotulo: 'Reguladas',
                    valor: risco.data.decisions.throttled,
                    cor: 'var(--warn)',
                  },
                  { rotulo: 'Seguradas', valor: risco.data.decisions.held, cor: 'var(--crit)' },
                ]}
              />
            ) : (
              <Skeleton className="h-44" />
            )}
          </Card>

          <Card title="Score de risco" hint="0 é tranquilo, 100 é beira do bloqueio.">
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

        <Card
          title="Saúde das sessões"
          hint="MTBF vem dos eventos de conexão gravados, não de um heartbeat."
        >
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
          label="Sessões conectadas"
          value={`${conectadas}/${querRodar}`}
          tone={conectadas === querRodar ? 'ok' : conectadas === 0 ? 'crit' : 'warn'}
          hint={querRodar === 0 ? 'Nenhuma sessão em execução' : 'Do que deveria estar rodando'}
        />
      </div>
      <div className="card p-4">
        <Stat
          label="Taxa de entrega"
          value={pct(taxa)}
          tone={taxa >= 0.95 ? 'ok' : taxa >= 0.85 ? 'warn' : 'crit'}
          hint={`${num(entrega?.funnel.delivered ?? 0)} de ${num(entrega?.funnel.sent ?? 0)}`}
        />
      </div>
      <div className="card p-4">
        <Stat
          label="Latência p95"
          value={duracao(p95)}
          tone={p95 === null ? 'neutral' : p95 < 5000 ? 'ok' : p95 < 20000 ? 'warn' : 'crit'}
          hint="Do envio ao ACK de entrega"
        />
      </div>
      <div className="card p-4">
        <Stat
          label="Na fila"
          value={num(entrega?.queue.queued ?? 0)}
          tone={(entrega?.queue.queued ?? 0) > 500 ? 'warn' : 'neutral'}
          hint={`${num(entrega?.queue.sending ?? 0)} em envio`}
        />
      </div>
      <div className="card p-4">
        <Stat
          label="Seguradas pelo risco"
          value={num(segurado)}
          tone={segurado > 0 ? 'warn' : 'ok'}
          hint={`${num(risco?.newContacts ?? 0)} contatos novos`}
        />
      </div>
    </div>
  )
}

const TOM_POR_STATUS: Record<string, Tone> = {
  connected: 'ok',
  connecting: 'warn',
  pairing: 'warn',
  created: 'hold',
  disconnected: 'crit',
  logged_out: 'crit',
  banned: 'crit',
}

const ROTULO_POR_STATUS: Record<string, string> = {
  connected: 'Conectada',
  connecting: 'Conectando',
  pairing: 'Pareando',
  created: 'Criada',
  disconnected: 'Desconectada',
  logged_out: 'Deslogada',
  banned: 'Banida',
}

function TabelaDeSaude({ linhas }: { linhas: KpiSessions['sessions'] }) {
  if (linhas.length === 0) {
    return <Empty>Nenhuma sessão nesta organização ainda.</Empty>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <Th>Sessão</Th>
            <Th>Estado</Th>
            <Th alinhamento="right">Quedas</Th>
            <Th alinhamento="right">Reconexões</Th>
            <Th alinhamento="right">MTBF</Th>
            <Th>Última causa</Th>
          </tr>
        </thead>
        <tbody>
          {linhas.map((linha) => (
            <tr key={linha.sessionId} className="border-b border-line/60 last:border-0">
              <td className="py-2.5 pr-3 font-medium text-ink">{linha.name}</td>
              <td className="py-2.5 pr-3">
                <Pill tone={TOM_POR_STATUS[linha.status] ?? 'hold'}>
                  {ROTULO_POR_STATUS[linha.status] ?? linha.status}
                </Pill>
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
