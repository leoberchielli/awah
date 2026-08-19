import { type FormEvent, useState } from 'react'
import { Card, cx, Empty } from '../../components/ui'
import type {
  CaixaChatwoot,
  ContaChatwoot,
  DescobertaChatwoot,
  IntegrationSaved,
  SessionRow,
} from '../../lib/api'
import { ApiError, post, put } from '../../lib/api'

/**
 * Conectar o Chatwoot sem sair desta tela.
 *
 * O manual desta integração tinha sete passos, e três deles eram os que faziam
 * a pessoa desistir: descobrir o `accountId` na URL, descobrir o `inboxId` na
 * URL, e voltar ao Chatwoot para colar a URL do webhook. O token já sabe as
 * duas primeiras respostas, e a API do Chatwoot aceita criar a caixa com o
 * webhook já apontado — então nenhum dos três precisa existir.
 */
export function AssistenteChatwoot({
  sessoes,
  aoSalvar,
}: {
  sessoes: SessionRow[]
  aoSalvar: () => void
}) {
  const [passo, setPasso] = useState<1 | 2 | 3>(1)
  const [baseUrl, setBaseUrl] = useState('https://app.chatwoot.com')
  const [apiAccessToken, setToken] = useState('')
  const [contas, setContas] = useState<ContaChatwoot[]>([])
  const [accountId, setAccountId] = useState<number | null>(null)
  const [caixas, setCaixas] = useState<CaixaChatwoot[]>([])
  const [escolha, setEscolha] = useState<'nova' | number>('nova')
  const [nomeDaCaixa, setNomeDaCaixa] = useState('WhatsApp (AWAH)')
  const [sessionId, setSessionId] = useState('')

  const [erro, setErro] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const [pronto, setPronto] = useState<IntegrationSaved | null>(null)

  async function executar(acao: () => Promise<void>) {
    setOcupado(true)
    setErro(null)
    try {
      await acao()
    } catch (falha) {
      setErro(
        falha instanceof ApiError ? falha.message : 'Não consegui falar com o servidor da API.',
      )
    } finally {
      setOcupado(false)
    }
  }

  const descobrirContas = (evento: FormEvent) => {
    evento.preventDefault()
    return executar(async () => {
      const resultado = await post<DescobertaChatwoot>('/v1/integrations/chatwoot/discover', {
        baseUrl,
        apiAccessToken,
      })

      if (resultado.accounts.length === 0) {
        throw new ApiError(400, 'sem_conta', 'Este token não alcança nenhuma conta do Chatwoot.')
      }

      setContas(resultado.accounts)
      // Conta única não merece uma pergunta: já avança e busca as caixas dela.
      const unica = resultado.accounts.length === 1 ? resultado.accounts[0] : null
      if (unica) {
        await escolherConta(unica.id)
        return
      }
      setPasso(2)
    })
  }

  async function escolherConta(id: number) {
    const resultado = await post<DescobertaChatwoot>('/v1/integrations/chatwoot/discover', {
      baseUrl,
      apiAccessToken,
      accountId: id,
    })

    setAccountId(id)
    setCaixas(resultado.inboxes ?? [])
    setPasso(3)
  }

  const conectar = (evento: FormEvent) => {
    evento.preventDefault()
    return executar(async () => {
      setPronto(
        await put<IntegrationSaved>(`/v1/sessions/${sessionId}/integrations/chatwoot`, {
          baseUrl,
          apiAccessToken,
          accountId,
          ...(escolha === 'nova' ? { createInbox: nomeDaCaixa } : { inboxId: escolha }),
        }),
      )
      aoSalvar()
    })
  }

  if (pronto) {
    return (
      <Card title="Chatwoot conectado">
        <div className="flex flex-col gap-3">
          <p className="rounded-md bg-ok/10 px-3 py-2 text-sm text-ok">{pronto.detail}</p>

          {/* Nulo significa que o gateway já apontou o webhook sozinho. */}
          {pronto.webhookUrl ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-ink/80">
                Falta um passo: cole esta URL no campo <strong>Webhook URL</strong> da sua caixa
                API, no Chatwoot.
              </p>
              <code className="truncate rounded border border-line bg-surface-2 px-2 py-1.5 font-mono text-[11px] text-ink">
                {pronto.webhookUrl}
              </code>
            </div>
          ) : (
            <p className="text-sm text-muted">
              O webhook já foi apontado para o gateway — não há nada para fazer no Chatwoot. Mande
              uma mensagem para o número e ela aparece na caixa de entrada.
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              setPronto(null)
              setPasso(1)
            }}
            className="self-start rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface-2"
          >
            Conectar outra sessão
          </button>
        </div>
      </Card>
    )
  }

  return (
    <Card
      title="Conectar o Chatwoot"
      hint="Atendimento humano. A conversa aparece na caixa de entrada e a resposta do agente volta pelo gateway."
      action={<Passos atual={passo} />}
    >
      {passo === 1 && (
        <form onSubmit={descobrirContas} className="flex flex-col gap-3">
          <Campo
            rotulo="Endereço do Chatwoot"
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://app.chatwoot.com"
          />
          <Campo
            rotulo="Token de acesso"
            type="password"
            value={apiAccessToken}
            onChange={setToken}
            dica="No Chatwoot: seu avatar → Perfil → Token de acesso. Use um token de administrador para o gateway conseguir criar a caixa sozinho."
          />

          <Erro texto={erro} />
          <Acao ocupado={ocupado} rotulo="Continuar" carregando="Falando com o Chatwoot…" />
        </form>
      )}

      {passo === 2 && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">Este token alcança mais de uma conta. Qual delas?</p>
          <ul className="flex flex-col gap-2">
            {contas.map((conta) => (
              <li key={conta.id}>
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() => executar(() => escolherConta(conta.id))}
                  className="flex w-full items-center justify-between rounded-md border border-line bg-surface px-3 py-2.5 text-left text-sm text-ink hover:bg-surface-2 disabled:opacity-50"
                >
                  <span>{conta.name}</span>
                  <span className="font-mono text-xs text-muted">{conta.role}</span>
                </button>
              </li>
            ))}
          </ul>
          <Erro texto={erro} />
        </div>
      )}

      {passo === 3 && (
        <form onSubmit={conectar} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">Sessão do WhatsApp</span>
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
            {sessoes.length === 0 && (
              <span className="text-xs text-warn">
                Nenhuma sessão ainda. Crie uma na aba Sessões primeiro.
              </span>
            )}
          </label>

          <fieldset className="flex flex-col gap-2">
            <span className="eyebrow">Caixa de entrada</span>

            <Opcao
              selecionada={escolha === 'nova'}
              aoEscolher={() => setEscolha('nova')}
              titulo="Criar uma caixa nova"
              detalhe="O gateway cria a caixa API e já aponta o webhook. Recomendado."
            />

            {escolha === 'nova' && (
              <input
                required
                value={nomeDaCaixa}
                onChange={(e) => setNomeDaCaixa(e.target.value)}
                className="ml-6 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink"
              />
            )}

            {/**
             * Caixa que não é do tipo API aparece desabilitada em vez de sumir:
             * quem procura a caixa que já usa precisa ver por que ela não serve.
             */}
            {caixas.map((caixa) => (
              <Opcao
                key={caixa.id}
                selecionada={escolha === caixa.id}
                aoEscolher={() => setEscolha(caixa.id)}
                desabilitada={!caixa.usable}
                titulo={caixa.name}
                detalhe={
                  caixa.usable
                    ? 'Caixa API existente. O webhook dela será apontado para o gateway.'
                    : `Tipo ${caixa.channelType} — tem transporte próprio e ignoraria o gateway.`
                }
              />
            ))}

            {caixas.length === 0 && (
              <Empty>Nenhuma caixa nesta conta ainda. A nova será a primeira.</Empty>
            )}
          </fieldset>

          <Erro texto={erro} />
          <Acao ocupado={ocupado} rotulo="Conectar" carregando="Preparando a caixa…" />
        </form>
      )}
    </Card>
  )
}

function Passos({ atual }: { atual: number }) {
  return (
    <span className="flex items-center gap-1.5">
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          aria-hidden
          className={cx(
            'size-1.5 rounded-full',
            n === atual ? 'bg-accent' : n < atual ? 'bg-ok' : 'bg-line-strong',
          )}
        />
      ))}
      <span className="sr-only">Passo {atual} de 3</span>
    </span>
  )
}

function Opcao({
  selecionada,
  aoEscolher,
  titulo,
  detalhe,
  desabilitada,
}: {
  selecionada: boolean
  aoEscolher: () => void
  titulo: string
  detalhe: string
  desabilitada?: boolean
}) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5',
        desabilitada && 'cursor-not-allowed opacity-50',
        selecionada ? 'border-accent bg-accent-soft' : 'border-line bg-surface',
      )}
    >
      <input
        type="radio"
        name="caixa"
        checked={selecionada}
        disabled={desabilitada}
        onChange={aoEscolher}
        className="mt-0.5 accent-[var(--accent)]"
      />
      <span className="min-w-0">
        <span className="block text-sm text-ink">{titulo}</span>
        <span className="block text-xs text-muted">{detalhe}</span>
      </span>
    </label>
  )
}

function Campo({
  rotulo,
  value,
  onChange,
  dica,
  ...resto
}: {
  rotulo: string
  value: string
  onChange: (valor: string) => void
  dica?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="eyebrow">{rotulo}</span>
      <input
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-muted"
        {...resto}
      />
      {dica && <span className="text-xs text-muted">{dica}</span>}
    </label>
  )
}

function Erro({ texto }: { texto: string | null }) {
  if (!texto) return null
  return (
    <p role="alert" className="rounded-md bg-crit/10 px-3 py-2 text-xs text-crit">
      {texto}
    </p>
  )
}

function Acao({
  ocupado,
  rotulo,
  carregando,
}: {
  ocupado: boolean
  rotulo: string
  carregando: string
}) {
  return (
    <button
      type="submit"
      disabled={ocupado}
      className="mt-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {ocupado ? carregando : rotulo}
    </button>
  )
}
