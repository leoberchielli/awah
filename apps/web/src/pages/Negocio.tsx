import { AreaSerie, BarrasHorizontais } from '../components/charts'
import { FiltroDeSessao, Shell, useFiltro } from '../components/Shell'
import { Card, Empty, Skeleton, Stat } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import type { KpiBusiness, SessionRow } from '../lib/api'
import { chat, dataHora, num, pct } from '../lib/format'

/** Negócio muda em minutos, não em segundos. Meio minuto basta e pesa menos. */
const POLL_MS = 30_000

const ROTULO_POR_TIPO: Record<string, string> = {
  text: 'Texto',
  image: 'Imagem',
  video: 'Vídeo',
  audio: 'Áudio',
  document: 'Documento',
  sticker: 'Figurinha',
  location: 'Localização',
  contact: 'Contato',
  reaction: 'Reação',
  system: 'Sistema',
}

export function Negocio() {
  const { query } = useFiltro()

  const sessoes = useQuery<{ sessions: SessionRow[] }>('/v1/sessions', 0)
  const negocio = useQuery<KpiBusiness>(`/v1/kpi/business?${query}`, POLL_MS)

  return (
    <Shell acoes={<FiltroDeSessao sessoes={sessoes.data?.sessions ?? []} />}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="card p-4">
            <Stat
              label="Conversas ativas"
              value={negocio.data ? num(negocio.data.activeChats) : '—'}
              hint="Com pelo menos uma mensagem na janela"
            />
          </div>
          <div className="card p-4">
            <Stat
              label="Taxa de resposta"
              value={negocio.data ? pct(negocio.data.responseRate) : '—'}
              tone={
                !negocio.data
                  ? 'neutral'
                  : negocio.data.responseRate >= 0.9
                    ? 'ok'
                    : negocio.data.responseRate >= 0.7
                      ? 'warn'
                      : 'crit'
              }
              hint="Conversas recebidas que tiveram resposta"
            />
          </div>
          <div className="card p-4">
            <Stat
              label="1ª resposta · mediana"
              value={segundos(negocio.data?.firstResponseSeconds.p50 ?? null)}
              hint="Quanto o cliente esperou até alguém falar"
            />
          </div>
          <div className="card p-4">
            <Stat
              label="1ª resposta · p95"
              value={segundos(negocio.data?.firstResponseSeconds.p95 ?? null)}
              tone={(negocio.data?.firstResponseSeconds.p95 ?? 0) > 3600 ? 'warn' : 'neutral'}
              hint="O pior caso que ainda é comum"
            />
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card
            title="Volume de conversa"
            hint="Entrada e saída lado a lado — desequilíbrio persistente é disparo em massa ou fila parada."
            className="lg:col-span-2"
          >
            {negocio.data ? (
              <AreaSerie
                series={negocio.data.volume}
                visuais={[
                  { key: 'messages.inbound', label: 'Recebidas', color: 'var(--ok)' },
                  { key: 'messages.outbound', label: 'Enviadas', color: 'var(--accent)' },
                ]}
                altura={240}
              />
            ) : (
              <Skeleton className="h-60" />
            )}
          </Card>

          <Card title="Tipos de mensagem" hint="O que trafega de verdade.">
            {negocio.data ? (
              <BarrasHorizontais
                altura={240}
                dados={negocio.data.byType.slice(0, 8).map((item) => ({
                  rotulo: ROTULO_POR_TIPO[item.type] ?? item.type,
                  valor: item.count,
                }))}
              />
            ) : (
              <Skeleton className="h-60" />
            )}
          </Card>
        </div>

        <Card title="Conversas mais movimentadas" hint="Volume por contato na janela escolhida.">
          {negocio.data ? (
            <TabelaDeChats linhas={negocio.data.topChats} />
          ) : (
            <Skeleton className="h-40" />
          )}
        </Card>
      </div>
    </Shell>
  )
}

function TabelaDeChats({ linhas }: { linhas: KpiBusiness['topChats'] }) {
  if (linhas.length === 0) {
    return <Empty>Nenhuma conversa registrada nesta janela.</Empty>
  }

  const maior = Math.max(...linhas.map((l) => l.messages), 1)

  return (
    <ul className="flex flex-col">
      {linhas.map((linha) => (
        <li
          key={linha.chatId}
          className="flex items-center gap-3 border-b border-line/60 py-2.5 last:border-0"
        >
          <span className="w-40 shrink-0 truncate font-mono text-xs text-ink" title={linha.chatId}>
            {chat(linha.chatId)}
          </span>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${(linha.messages / maior) * 100}%` }}
            />
          </span>
          <span className="w-14 shrink-0 text-right font-mono text-sm text-ink tnum">
            {num(linha.messages)}
          </span>
          <span className="w-28 shrink-0 text-right text-xs text-muted">
            {dataHora(linha.lastAt)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** O p50 vem em segundos e quase nunca é legível assim. */
function segundos(valor: number | null): string {
  if (valor === null) return '—'
  if (valor < 60) return `${Math.round(valor)} s`
  if (valor < 3600) return `${(valor / 60).toFixed(1)} min`
  if (valor < 86_400) return `${(valor / 3600).toFixed(1)} h`
  return `${(valor / 86_400).toFixed(1)} d`
}
