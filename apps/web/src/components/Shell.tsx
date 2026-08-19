import type { ReactNode } from 'react'
import { NavLink, useLocation, useSearchParams } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { post } from '../lib/api'
import {
  IconeLigacao,
  IconeLua,
  IconeMonitor,
  IconeNegocio,
  IconePulso,
  IconeSair,
  IconeSessao,
  IconeSol,
} from './icons'
import { cx } from './ui'

/** Janelas oferecidas. Mais que isso vira menu; menos, vira limitação. */
export const JANELAS = [
  { horas: 1, rotulo: '1 h' },
  { horas: 6, rotulo: '6 h' },
  { horas: 24, rotulo: '24 h' },
  { horas: 168, rotulo: '7 d' },
  { horas: 720, rotulo: '30 d' },
] as const

/**
 * A janela e o filtro de sessão moram na URL.
 *
 * Um operador que vê algo estranho manda o link para o colega, e o colega abre
 * exatamente a mesma tela. Guardar isso em estado de componente transformaria
 * toda conversa sobre um incidente em "clica em 7 dias, depois filtra por...".
 */
export function useFiltro() {
  const [params, setParams] = useSearchParams()
  const bruto = Number(params.get('horas') ?? 24)
  const horas = JANELAS.some((j) => j.horas === bruto) ? bruto : 24
  const sessao = params.get('sessao')

  return {
    horas,
    sessao,
    definirHoras: (valor: number) => {
      const proximo = new URLSearchParams(params)
      proximo.set('horas', String(valor))
      setParams(proximo, { replace: true })
    },
    definirSessao: (valor: string | null) => {
      const proximo = new URLSearchParams(params)
      if (valor) proximo.set('sessao', valor)
      else proximo.delete('sessao')
      setParams(proximo, { replace: true })
    },
    /** Sufixo pronto para concatenar na URL do endpoint. */
    query: `hours=${horas}${sessao ? `&sessionId=${sessao}` : ''}`,
  }
}

const ABAS = [
  { para: '/operacao', rotulo: 'Operação', Icone: IconePulso },
  { para: '/negocio', rotulo: 'Negócio', Icone: IconeNegocio },
  { para: '/sessoes', rotulo: 'Sessões', Icone: IconeSessao },
  { para: '/integracoes', rotulo: 'Integrações', Icone: IconeLigacao },
]

export function Shell({ children, acoes }: { children: ReactNode; acoes?: ReactNode }) {
  return (
    <div className="min-h-dvh bg-ground">
      <div className="mx-auto flex w-full max-w-[1400px] px-3 sm:px-5">
        <Rail />
        <div className="min-w-0 flex-1 py-4 sm:pl-5">
          <CabecalhoMovel />
          <TopBar acoes={acoes} />
          <main className="mt-4 pb-12">{children}</main>
        </div>
      </div>
    </div>
  )
}

/**
 * Navegação no celular.
 *
 * O rail lateral não cabe em tela estreita, e escondê-lo sem substituto deixaria
 * as outras duas abas inalcançáveis — o painel viraria uma tela só para quem
 * abre do telefone, que é justamente quem está fora do escritório com um
 * incidente na mão.
 */
function CabecalhoMovel() {
  const { search } = useLocation()

  return (
    <div className="mb-3 flex flex-col gap-3 sm:hidden">
      <div className="flex items-center justify-between">
        <Marca />
        <button
          type="button"
          onClick={async () => {
            await post('/v1/auth/logout').catch(() => undefined)
            window.location.assign('/entrar')
          }}
          className="flex items-center gap-1.5 text-xs text-muted"
        >
          <IconeSair width={14} height={14} />
          Sair
        </button>
      </div>

      <nav aria-label="Seções" className="flex gap-1 overflow-x-auto">
        {ABAS.map(({ para, rotulo, Icone }) => (
          <NavLink
            key={para}
            to={{ pathname: para, search }}
            className={({ isActive }) =>
              cx(
                'flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
                isActive
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'border border-line bg-surface text-muted',
              )
            }
          >
            <Icone width={15} height={15} />
            {rotulo}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

function Rail() {
  const { search } = useLocation()

  return (
    <nav
      aria-label="Seções"
      className="sticky top-0 hidden h-dvh w-48 shrink-0 flex-col gap-1 border-r border-line py-5 pr-4 sm:flex"
    >
      <div className="mb-5 px-2">
        <Marca />
      </div>

      {ABAS.map(({ para, rotulo, Icone }) => (
        <NavLink
          key={para}
          to={{ pathname: para, search }}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
              isActive
                ? 'bg-accent-soft font-medium text-accent'
                : 'text-muted hover:bg-surface-2 hover:text-ink',
            )
          }
        >
          <Icone />
          {rotulo}
        </NavLink>
      ))}

      <div className="mt-auto flex flex-col items-start gap-1 px-2.5">
        <a href="/docs" className="py-1.5 text-xs text-muted hover:text-ink">
          Documentação da API
        </a>
        <button
          type="button"
          onClick={async () => {
            await post('/v1/auth/logout').catch(() => undefined)
            window.location.assign('/entrar')
          }}
          className="flex items-center gap-2 py-1.5 text-xs text-muted hover:text-ink"
        >
          <IconeSair width={14} height={14} />
          Sair
        </button>
      </div>
    </nav>
  )
}

export function Marca() {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-lg bg-accent font-mono text-[13px] font-medium text-white"
      >
        A
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">AWAH</span>
    </span>
  )
}

function TopBar({ acoes }: { acoes?: ReactNode }) {
  const { horas, definirHoras } = useFiltro()

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {/* biome-ignore lint/a11y/useSemanticElements: fieldset exige legend visível e traz layout próprio; aqui são botões de alternância, não campos de formulário */}
        <div
          role="group"
          aria-label="Janela de tempo"
          className="flex overflow-hidden rounded-md border border-line bg-surface"
        >
          {JANELAS.map((janela) => (
            <button
              key={janela.horas}
              type="button"
              onClick={() => definirHoras(janela.horas)}
              aria-pressed={horas === janela.horas}
              className={cx(
                'px-2.5 py-1.5 font-mono text-xs transition-colors',
                horas === janela.horas
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'text-muted hover:text-ink',
              )}
            >
              {janela.rotulo}
            </button>
          ))}
        </div>
        {acoes}
      </div>

      <AlternadorDeTema />
    </div>
  )
}

function AlternadorDeTema() {
  const [tema, setTema] = useTheme()

  const opcoes = [
    { valor: 'light' as const, Icone: IconeSol, rotulo: 'Claro' },
    { valor: 'system' as const, Icone: IconeMonitor, rotulo: 'Do sistema' },
    { valor: 'dark' as const, Icone: IconeLua, rotulo: 'Escuro' },
  ]

  return (
    // biome-ignore lint/a11y/useSemanticElements: mesma razão do seletor de janela
    <div
      role="group"
      aria-label="Tema"
      className="flex overflow-hidden rounded-md border border-line bg-surface"
    >
      {opcoes.map(({ valor, Icone, rotulo }) => (
        <button
          key={valor}
          type="button"
          title={rotulo}
          aria-label={rotulo}
          aria-pressed={tema === valor}
          onClick={() => setTema(valor)}
          className={cx(
            'px-2 py-1.5 transition-colors',
            tema === valor ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink',
          )}
        >
          <Icone width={15} height={15} />
        </button>
      ))}
    </div>
  )
}

/** Seletor de sessão, montado pelas telas que já têm a lista carregada. */
export function FiltroDeSessao({ sessoes }: { sessoes: Array<{ id: string; name: string }> }) {
  const { sessao, definirSessao } = useFiltro()

  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="sr-only">Filtrar por sessão</span>
      <select
        value={sessao ?? ''}
        onChange={(evento) => definirSessao(evento.target.value || null)}
        className="rounded-md border border-line bg-surface px-2 py-[7px] text-xs text-ink"
      >
        <option value="">Todas as sessões</option>
        {sessoes.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  )
}
