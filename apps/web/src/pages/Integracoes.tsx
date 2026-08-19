import { type FormEvent, useState } from 'react'
import { Shell } from '../components/Shell'
import { Card, cx, Empty, Pill, Skeleton } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import type { Integration, IntegrationSaved, SessionRow } from '../lib/api'
import { ApiError, del, put } from '../lib/api'
import { dataHora } from '../lib/format'

const FERRAMENTAS = {
  chatwoot: {
    nome: 'Chatwoot',
    resumo:
      'Atendimento humano. A conversa aparece na caixa de entrada e a resposta do agente volta pelo gateway.',
    campos: [
      { chave: 'baseUrl', rotulo: 'Endereço', dica: 'https://app.chatwoot.com', tipo: 'url' },
      { chave: 'accountId', rotulo: 'ID da conta', dica: '1', tipo: 'text' },
      { chave: 'inboxId', rotulo: 'ID da caixa', dica: 'Precisa ser do tipo API', tipo: 'text' },
      {
        chave: 'apiAccessToken',
        rotulo: 'Token de acesso',
        dica: 'Perfil → Configurações → Token',
        tipo: 'password',
      },
    ],
  },
  typebot: {
    nome: 'Typebot',
    resumo:
      'Fluxo automatizado. O que o cliente escreve entra no fluxo e a resposta sai pela fila do gateway.',
    campos: [
      { chave: 'baseUrl', rotulo: 'Endereço', dica: 'https://typebot.io', tipo: 'url' },
      {
        chave: 'typebotId',
        rotulo: 'ID do fluxo',
        dica: 'O mesmo que aparece na URL de compartilhamento',
        tipo: 'text',
      },
      {
        chave: 'apiToken',
        rotulo: 'Token da API',
        dica: 'Só para fluxo que não é público',
        tipo: 'password',
        opcional: true,
      },
      {
        chave: 'humanHandoffKeyword',
        rotulo: 'Palavra de escape',
        dica: 'atendente',
        tipo: 'text',
        opcional: true,
      },
    ],
  },
} as const

type Kind = keyof typeof FERRAMENTAS

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

        <div className="grid gap-4 lg:grid-cols-2">
          {(Object.keys(FERRAMENTAS) as Kind[]).map((kind) => (
            <Formulario key={kind} kind={kind} sessoes={lista} aoSalvar={integracoes.refetch} />
          ))}
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
        <span className="block text-sm font-medium text-ink">
          {FERRAMENTAS[integracao.kind].nome}
        </span>
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

function Formulario({
  kind,
  sessoes,
  aoSalvar,
}: {
  kind: Kind
  sessoes: SessionRow[]
  aoSalvar: () => void
}) {
  const ferramenta = FERRAMENTAS[kind]
  const [sessionId, setSessionId] = useState('')
  const [valores, setValores] = useState<Record<string, string>>({})
  const [erro, setErro] = useState<string | null>(null)
  const [resultado, setResultado] = useState<IntegrationSaved | null>(null)
  const [salvando, setSalvando] = useState(false)

  async function salvar(evento: FormEvent) {
    evento.preventDefault()
    setErro(null)
    setResultado(null)
    setSalvando(true)

    try {
      const corpo = Object.fromEntries(
        Object.entries(valores).filter(([, valor]) => valor.trim() !== ''),
      )

      setResultado(
        await put<IntegrationSaved>(`/v1/sessions/${sessionId}/integrations/${kind}`, corpo),
      )
      aoSalvar()
    } catch (falha) {
      setErro(
        falha instanceof ApiError ? falha.message : 'Não consegui falar com o servidor da API.',
      )
    } finally {
      setSalvando(false)
    }
  }

  return (
    <Card title={ferramenta.nome} hint={ferramenta.resumo}>
      <form onSubmit={salvar} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="eyebrow">Sessão</span>
          <select
            required
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
          >
            <option value="">Escolha a sessão</option>
            {sessoes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        {ferramenta.campos.map((campo) => (
          <label key={campo.chave} className="flex flex-col gap-1.5">
            <span className="eyebrow">
              {campo.rotulo}
              {'opcional' in campo && campo.opcional && (
                <span className="ml-1 normal-case tracking-normal opacity-70">(opcional)</span>
              )}
            </span>
            <input
              required={!('opcional' in campo && campo.opcional)}
              type={campo.tipo === 'password' ? 'password' : 'text'}
              placeholder={campo.dica}
              value={valores[campo.chave] ?? ''}
              onChange={(e) => setValores((v) => ({ ...v, [campo.chave]: e.target.value }))}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
            />
          </label>
        ))}

        <button
          type="submit"
          disabled={salvando}
          className={cx(
            'mt-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50',
          )}
        >
          {salvando ? 'Testando a conexão…' : 'Testar e ligar'}
        </button>

        {/* A conexão é testada antes de gravar: credencial errada não fica guardada em silêncio. */}
        {erro && (
          <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
            {erro}
          </p>
        )}

        {resultado && <Sucesso resultado={resultado} />}
      </form>
    </Card>
  )
}

function Sucesso({ resultado }: { resultado: IntegrationSaved }) {
  const [copiado, setCopiado] = useState(false)

  return (
    <div className="flex flex-col gap-2 rounded-md bg-ok/10 px-3 py-2.5">
      <p className="text-xs text-ok">{resultado.detail}</p>

      {resultado.webhookUrl && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-ink/80">
            Falta um passo: cadastre esta URL no Chatwoot, na sua caixa do tipo API.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink">
              {resultado.webhookUrl}
            </code>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(resultado.webhookUrl ?? '')
                setCopiado(true)
              }}
              className="shrink-0 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
            >
              {copiado ? 'Copiado' : 'Copiar'}
            </button>
          </div>
          {/* A URL é o segredo: o webhook do Chatwoot não assina o corpo. */}
          <p className="text-[11px] text-muted">
            Trate esta URL como senha — ela é o único segredo entre o Chatwoot e o gateway.
          </p>
        </div>
      )}
    </div>
  )
}
