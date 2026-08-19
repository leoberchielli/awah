import { useState } from 'react'
import { Shell } from '../components/Shell'
import { Card, Empty, Pill, Skeleton } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import type { Integration, SessionRow } from '../lib/api'
import { del } from '../lib/api'
import { dataHora } from '../lib/format'
import { AssistenteChatwoot } from './integracoes/AssistenteChatwoot'
import { AssistenteTypebot } from './integracoes/AssistenteTypebot'

const NOMES = { chatwoot: 'Chatwoot', typebot: 'Typebot' } as const

export function Integracoes() {
  const sessoes = useQuery<{ sessions: SessionRow[] }>('/v1/sessions', 0)
  const integracoes = useQuery<{ integrations: Integration[] }>('/v1/integrations', 10_000)

  const lista = sessoes.data?.sessions ?? []

  return (
    <Shell>
      <div className="flex flex-col gap-4">
        <Card
          title="Ferramentas ligadas"
          hint="O AWAH é o transporte: o Chatwoot cuida do atendimento humano, o Typebot cuida do fluxo, e a fila durável, a ordem por conversa e o motor de risco ficam embaixo dos dois."
        >
          {!integracoes.settled ? (
            <Skeleton className="h-24" />
          ) : (integracoes.data?.integrations.length ?? 0) === 0 ? (
            <Empty>Nenhuma ferramenta ligada ainda. Configure uma abaixo.</Empty>
          ) : (
            <ul className="flex flex-col">
              {integracoes.data?.integrations.map((item) => (
                <LinhaDeIntegracao
                  key={item.id}
                  integracao={item}
                  sessao={lista.find((s) => s.id === item.sessionId)}
                  aoMudar={integracoes.refetch}
                />
              ))}
            </ul>
          )}
        </Card>

        <div className="grid items-start gap-4 lg:grid-cols-2">
          <AssistenteChatwoot sessoes={lista} aoSalvar={integracoes.refetch} />
          <AssistenteTypebot sessoes={lista} aoSalvar={integracoes.refetch} />
        </div>
      </div>
    </Shell>
  )
}

function LinhaDeIntegracao({
  integracao,
  sessao,
  aoMudar,
}: {
  integracao: Integration
  sessao?: SessionRow
  aoMudar: () => void
}) {
  const [removendo, setRemovendo] = useState(false)

  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-line/60 py-3 last:border-0">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{NOMES[integracao.kind]}</span>
        <span className="block truncate text-xs text-muted">
          {sessao?.name ?? integracao.sessionId} · desde {dataHora(integracao.createdAt)}
        </span>
      </span>

      {/* Silêncio na ferramenta tem explicação, e ela fica aqui. */}
      {integracao.lastError ? (
        <Pill tone="crit">Com erro</Pill>
      ) : (
        <Pill tone={integracao.active ? 'ok' : 'hold'}>
          {integracao.active ? 'Ativa' : 'Pausada'}
        </Pill>
      )}

      <button
        type="button"
        disabled={removendo}
        onClick={async () => {
          setRemovendo(true)
          await del(`/v1/integrations/${integracao.id}`).catch(() => undefined)
          aoMudar()
        }}
        className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-crit hover:bg-surface-2 disabled:opacity-50"
      >
        Desligar
      </button>

      {integracao.lastError && (
        <p className="w-full rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
          {integracao.lastError}
          {integracao.lastErrorAt && (
            <span className="ml-1.5 opacity-70">({dataHora(integracao.lastErrorAt)})</span>
          )}
        </p>
      )}
    </li>
  )
}
