import type { ReactNode } from 'react'
import { NavLink, useLocation, useSearchParams } from 'react-router-dom'
import { useTheme } from '../hooks/useTheme'
import { type TranslationKey, useT } from '../i18n'
import { post } from '../lib/api'
import { papelAoMenos, useMe } from '../lib/sessao'
import {
  IconeChave,
  IconeLigacao,
  IconeLua,
  IconeMonitor,
  IconeNegocio,
  IconePessoas,
  IconePulso,
  IconeSair,
  IconeSessao,
  IconeSol,
} from './icons'
import { LanguagePicker } from './LanguagePicker'
import { cx } from './ui'

/** Janelas oferecidas. Mais que isso vira menu; menos, vira limitação. */
export const JANELAS = [
  { horas: 1, valor: 1, unidade: 'window.hours' },
  { horas: 6, valor: 6, unidade: 'window.hours' },
  { horas: 24, valor: 24, unidade: 'window.hours' },
  { horas: 168, valor: 7, unidade: 'window.days' },
  { horas: 720, valor: 30, unidade: 'window.days' },
] as const satisfies ReadonlyArray<{ horas: number; valor: number; unidade: TranslationKey }>

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

interface Aba {
  para: string
  chave: TranslationKey
  Icone: (props: { width?: number; height?: number }) => ReactNode
  /** Papel mínimo para a aba existir. Ausente, ela vale para todo mundo. */
  minimo?: 'admin'
}

const ABAS: Aba[] = [
  { para: '/operations', chave: 'nav.operation', Icone: IconePulso },
  { para: '/business', chave: 'nav.business', Icone: IconeNegocio },
  { para: '/sessions', chave: 'nav.sessions', Icone: IconeSessao },
  { para: '/integrations', chave: 'nav.integrations', Icone: IconeLigacao },
  { para: '/keys', chave: 'nav.keys', Icone: IconeChave, minimo: 'admin' },
  { para: '/users', chave: 'nav.users', Icone: IconePessoas },
]

/**
 * Abas que este papel alcança.
 *
 * Mostrar a aba de chaves para quem vai levar 403 ao abrir não é transparência,
 * é uma porta pintada na parede. A autorização continua sendo do servidor.
 */
function useAbas() {
  const me = useMe()
  return ABAS.filter((aba) => !aba.minimo || papelAoMenos(me.role, aba.minimo))
}

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
  const abas = useAbas()
  const t = useT()

  return (
    <div className="chrome sticky top-0 z-20 -mx-3 mb-3 flex flex-col gap-3 px-3 py-3 sm:hidden">
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
          {t('common.signOut')}
        </button>
      </div>

      <nav aria-label={t('common.sections')} className="flex gap-1 overflow-x-auto">
        {abas.map(({ para, chave, Icone }) => (
          <NavLink
            key={para}
            to={{ pathname: para, search }}
            className={({ isActive }) =>
              cx(
                'flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors',
                isActive
                  ? 'border border-accent/30 bg-accent-soft font-medium text-accent shadow-sm'
                  : 'border border-line/70 bg-surface/60 text-muted backdrop-blur-sm',
              )
            }
          >
            <Icone width={15} height={15} />
            {t(chave)}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

function Rail() {
  const { search } = useLocation()
  const abas = useAbas()
  const t = useT()

  return (
    <nav
      aria-label={t('common.sections')}
      className="chrome sticky top-0 z-20 hidden h-dvh w-48 shrink-0 flex-col gap-1 border-e border-line/70 py-5 pe-4 sm:flex"
    >
      <div className="mb-5 px-2">
        <Marca />
      </div>

      {abas.map(({ para, chave, Icone }) => (
        <NavLink
          key={para}
          to={{ pathname: para, search }}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
              isActive
                ? 'bg-accent-soft font-medium text-accent shadow-[inset_0_0_0_1px_rgb(var(--glass-edge))]'
                : 'text-muted hover:bg-surface-2/70 hover:text-ink',
            )
          }
        >
          <Icone />
          {t(chave)}
        </NavLink>
      ))}

      <div className="mt-auto flex flex-col items-start gap-1 px-2.5">
        <a href="/docs" className="py-1.5 text-xs text-muted hover:text-ink">
          {t('common.apiDocs')}
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
          {t('common.signOut')}
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
        className="grid size-7 place-items-center rounded-lg bg-accent font-mono text-[13px] font-medium text-on-fill"
      >
        A
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">AWAH</span>
    </span>
  )
}

function TopBar({ acoes }: { acoes?: ReactNode }) {
  const { horas, definirHoras } = useFiltro()
  const t = useT()

  /*
   * On a phone the header is what sticks, because it carries the navigation.
   * If this bar stuck to the top as well it would land behind the header and
   * the filter would vanish on scroll. From `sm` up the header is gone and the
   * spot is free.
   */
  return (
    <div className="chrome -mx-3 flex flex-wrap items-center justify-between gap-3 border-b border-line/70 px-3 py-3 sm:sticky sm:top-0 sm:z-10 sm:-mx-5 sm:px-5">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {/* biome-ignore lint/a11y/useSemanticElements: fieldset exige legend visível e traz layout próprio; aqui são botões de alternância, não campos de formulário */}
        <div
          role="group"
          aria-label={t('common.timeWindow')}
          className="flex overflow-hidden rounded-lg border border-line/70 bg-surface/60 backdrop-blur-sm"
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
              {t(janela.unidade, { n: janela.valor })}
            </button>
          ))}
        </div>
        {acoes}
      </div>

      <div className="flex items-center gap-2">
        <LanguagePicker />
        <AlternadorDeTema />
      </div>
    </div>
  )
}

function AlternadorDeTema() {
  const [tema, setTema] = useTheme()
  const t = useT()

  const opcoes = [
    { valor: 'light' as const, Icone: IconeSol, chave: 'common.themeLight' as const },
    { valor: 'system' as const, Icone: IconeMonitor, chave: 'common.themeSystem' as const },
    { valor: 'dark' as const, Icone: IconeLua, chave: 'common.themeDark' as const },
  ]

  return (
    // biome-ignore lint/a11y/useSemanticElements: mesma razão do seletor de janela
    <div
      role="group"
      aria-label={t('common.theme')}
      className="flex overflow-hidden rounded-lg border border-line/70 bg-surface/60 backdrop-blur-sm"
    >
      {opcoes.map(({ valor, Icone, chave }) => (
        <button
          key={valor}
          type="button"
          title={t(chave)}
          aria-label={t(chave)}
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
  const t = useT()

  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="sr-only">{t('common.filterBySession')}</span>
      <select
        value={sessao ?? ''}
        onChange={(evento) => definirSessao(evento.target.value || null)}
        className="rounded-lg border border-line/70 bg-surface/60 px-2 py-[7px] text-xs text-ink backdrop-blur-sm"
      >
        <option value="">{t('common.allSessions')}</option>
        {sessoes.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  )
}
