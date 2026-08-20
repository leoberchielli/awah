import { type FormEvent, useState } from 'react'
import { Shell } from '../components/Shell'
import { Card, cx, Empty, Pill, Skeleton, Stat, type Tone } from '../components/ui'
import { useQuery } from '../hooks/useQuery'
import { Rich, type TranslationKey, useT } from '../i18n'
import type { QrResponse, RiskSnapshot, SessionEvent, SessionRow } from '../lib/api'
import { ApiError, post } from '../lib/api'
import { dataHora, desde, num, pct, telefone } from '../lib/format'
import { statusLabel, statusTone } from '../lib/sessionStatus'

const ENGINES: Array<{ valor: string; rotulo: TranslationKey }> = [
  { valor: 'baileys', rotulo: 'engine.baileys' },
  { valor: 'cloud_api', rotulo: 'engine.cloudApi' },
]

const PAREANDO = ['pairing', 'connecting']

export function Sessoes() {
  const t = useT()
  const [selecionada, setSelecionada] = useState<string | null>(null)
  const sessoes = useQuery<{ sessions: SessionRow[] }>('/v1/sessions', 4000)
  const lista = sessoes.data?.sessions ?? []

  const alvo = lista.find((s) => s.id === selecionada) ?? null

  /**
   * Sessão esperando um QR ganha a tela inteira, sem ninguém precisar clicar
   * nela.
   *
   * O código expira em segundos e o aparelho está na mão do operador: é o único
   * momento em que a tela tem uma coisa só a fazer. Deixar o QR escondido atrás
   * de uma seleção — como estava — torna o passo mais importante do produto
   * invisível para quem acabou de apertar "Iniciar".
   */
  const pareando = lista.find((s) => PAREANDO.includes(s.status)) ?? null

  return (
    <Shell>
      <div className="flex flex-col gap-4">
        {pareando && <Pareamento sessao={pareando} aoMudar={sessoes.refetch} />}

        <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="flex min-w-0 flex-col gap-4">
            <Card
              title={t('sessions.title')}
              hint={t('sessions.hint')}
              action={<NovaSessao aoCriar={sessoes.refetch} />}
            >
              {!sessoes.settled ? (
                <Skeleton className="h-32" />
              ) : lista.length === 0 ? (
                <Empty>
                  <Rich text={t('sessions.empty')} />
                </Empty>
              ) : (
                <ul className="flex flex-col">
                  {lista.map((sessao) => (
                    <LinhaDeSessao
                      key={sessao.id}
                      sessao={sessao}
                      selecionada={sessao.id === selecionada}
                      aoSelecionar={() =>
                        setSelecionada(sessao.id === selecionada ? null : sessao.id)
                      }
                      aoIniciar={() => setSelecionada(sessao.id)}
                      aoMudar={sessoes.refetch}
                    />
                  ))}
                </ul>
              )}
            </Card>

            {alvo && <Timeline sessionId={alvo.id} />}
          </div>

          <div className="flex flex-col gap-4">
            {alvo ? (
              <PainelDeRisco sessionId={alvo.id} />
            ) : (
              <Card title={t('sessions.detail')}>
                <Empty>{t('sessions.detailEmpty')}</Empty>
              </Card>
            )}
          </div>
        </div>
      </div>
    </Shell>
  )
}

/** O passo do pareamento, com o QR e o que fazer no aparelho lado a lado. */
function Pareamento({ sessao, aoMudar }: { sessao: SessionRow; aoMudar: () => void }) {
  const t = useT()

  return (
    <Card
      title={t('pairing.title', { name: sessao.name })}
      hint={t('pairing.hint')}
      action={<Pill tone="warn">{statusLabel(t, sessao.status)}</Pill>}
    >
      <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
        <PainelDeQr sessionId={sessao.id} />

        <ol className="flex flex-1 flex-col gap-3 text-sm text-muted">
          <Passo n={1} texto={t('pairing.step1')} />
          <Passo n={2} texto={t('pairing.step2')} />
          <Passo n={3} texto={t('pairing.step3')} />
          <Passo n={4} texto={t('pairing.step4')} />

          <li className="mt-1">
            <CancelarPareamento sessionId={sessao.id} aoMudar={aoMudar} />
          </li>
        </ol>
      </div>
    </Card>
  )
}

function Passo({ n, texto }: { n: number; texto: string }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="grid size-5 shrink-0 place-items-center rounded-full bg-accent-soft font-mono text-[11px] font-medium text-accent"
      >
        {n}
      </span>
      <span className="text-ink/80">
        <Rich text={texto} />
      </span>
    </li>
  )
}

function CancelarPareamento({ sessionId, aoMudar }: { sessionId: string; aoMudar: () => void }) {
  const t = useT()
  const [ocupado, setOcupado] = useState(false)

  return (
    <Botao
      tom="neutro"
      disabled={ocupado}
      onClick={async () => {
        setOcupado(true)
        await post(`/v1/sessions/${sessionId}/stop`).catch(() => undefined)
        aoMudar()
        setOcupado(false)
      }}
    >
      {t('pairing.cancel')}
    </Botao>
  )
}

function LinhaDeSessao({
  sessao,
  selecionada,
  aoSelecionar,
  aoIniciar,
  aoMudar,
}: {
  sessao: SessionRow
  selecionada: boolean
  aoSelecionar: () => void
  aoIniciar: () => void
  aoMudar: () => void
}) {
  const t = useT()
  const [ocupado, setOcupado] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  async function comandar(acao: 'start' | 'stop' | 'logout') {
    setOcupado(true)
    setErro(null)
    try {
      await post(`/v1/sessions/${sessao.id}/${acao}`)
      // Quem apertou Iniciar quer ver o que aconteceu com esta sessão.
      if (acao === 'start') aoIniciar()
      aoMudar()
    } catch (falha) {
      setErro(falha instanceof ApiError ? falha.message : t('sessions.commandFailed'))
    } finally {
      setOcupado(false)
    }
  }

  /**
   * Divergência entre intenção e realidade.
   *
   * "Deveria rodar, mas não está" é o estado que custa dinheiro em silêncio: a
   * fila continua aceitando mensagens e nada sai. Ele ganha destaque próprio.
   */
  const divergente = sessao.desiredState === 'running' && !sessao.running

  return (
    <li className="border-b border-line/60 last:border-0">
      <div className="flex flex-wrap items-center gap-3 py-3">
        <button
          type="button"
          onClick={aoSelecionar}
          className={cx(
            'flex min-w-0 flex-1 items-center gap-3 text-left',
            selecionada && 'text-accent',
          )}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{sessao.name}</span>
            <span className="block truncate font-mono text-xs text-muted">
              {telefone(sessao.phoneNumber)} · {sessao.engine}
              {sessao.ownerNodeId && ` · nó ${sessao.ownerNodeId.slice(0, 8)}`}
            </span>
          </span>
        </button>

        <div className="flex items-center gap-2">
          <Pill tone={statusTone(sessao.status)}>{statusLabel(t, sessao.status)}</Pill>

          {divergente && <Pill tone="crit">{t('sessions.shouldBeRunning')}</Pill>}

          {sessao.running ? (
            <>
              <Botao onClick={() => comandar('stop')} disabled={ocupado}>
                {t('sessions.stop')}
              </Botao>
              <Botao onClick={() => comandar('logout')} disabled={ocupado} tom="perigo">
                {t('sessions.logout')}
              </Botao>
            </>
          ) : (
            <Botao onClick={() => comandar('start')} disabled={ocupado} tom="primario">
              {t('sessions.start')}
            </Botao>
          )}
        </div>
      </div>

      {erro && (
        <p role="alert" className="pb-2 text-xs text-crit">
          {erro}
        </p>
      )}
    </li>
  )
}

function Botao({
  children,
  onClick,
  disabled,
  tom = 'neutro',
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  tom?: 'neutro' | 'primario' | 'perigo'
  type?: 'button' | 'submit'
}) {
  const estilo = {
    neutro: 'border-line bg-surface text-ink hover:bg-surface-2',
    primario: 'border-transparent bg-accent text-on-fill hover:opacity-90',
    perigo: 'border-line bg-surface text-crit hover:bg-surface-2',
  }[tom]

  return (
    <button
      type={type === 'submit' ? 'submit' : 'button'}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
        estilo,
      )}
    >
      {children}
    </button>
  )
}

function NovaSessao({ aoCriar }: { aoCriar: () => void }) {
  const t = useT()
  const [aberto, setAberto] = useState(false)
  const [nome, setNome] = useState('')
  const [engine, setEngine] = useState('baileys')
  const [erro, setErro] = useState<string | null>(null)

  async function criar(evento: FormEvent) {
    evento.preventDefault()
    setErro(null)
    try {
      await post('/v1/sessions', { name: nome, engine })
      setNome('')
      setAberto(false)
      aoCriar()
    } catch (falha) {
      setErro(falha instanceof ApiError ? falha.message : t('sessions.createFailed'))
    }
  }

  if (!aberto) {
    return (
      <Botao onClick={() => setAberto(true)} tom="primario">
        {t('sessions.new')}
      </Botao>
    )
  }

  return (
    <form onSubmit={criar} className="flex flex-wrap items-center gap-2">
      <input
        // biome-ignore lint/a11y/noAutofocus: o formulário só existe depois do clique explícito
        autoFocus
        required
        value={nome}
        onChange={(e) => setNome(e.target.value)}
        placeholder={t('sessions.namePlaceholder')}
        className="w-40 rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink"
      />
      <select
        value={engine}
        onChange={(e) => setEngine(e.target.value)}
        className="rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink"
      >
        {ENGINES.map((item) => (
          <option key={item.valor} value={item.valor}>
            {t(item.rotulo)}
          </option>
        ))}
      </select>
      <Botao type="submit" tom="primario">
        {t('sessions.create')}
      </Botao>
      <Botao onClick={() => setAberto(false)}>{t('common.cancel')}</Botao>
      {erro && (
        <span role="alert" className="w-full text-xs text-crit">
          {erro}
        </span>
      )}
    </form>
  )
}

/**
 * O QR expira em segundos e é regerado pela engine.
 *
 * Buscar a cada dois segundos é o que faz a imagem na tela ser a mesma que o
 * WhatsApp aceita — um QR de dez segundos atrás já falhou.
 */
function PainelDeQr({ sessionId }: { sessionId: string }) {
  const t = useT()
  const qr = useQuery<QrResponse>(`/v1/sessions/${sessionId}/qr`, 2000)

  /**
   * Fundo branco sempre, inclusive no tema escuro.
   *
   * Leitor de QR precisa de contraste entre módulo e fundo; inverter as cores
   * junto com o resto da interface faria a câmera do celular simplesmente não
   * enxergar o código.
   */
  if (!qr.data) {
    return (
      <div className="grid size-[248px] shrink-0 place-items-center rounded-lg border border-dashed border-line text-center text-sm text-muted">
        Aguardando a engine
        <br />
        gerar o código…
      </div>
    )
  }

  return (
    <img
      src={qr.data.image}
      alt={t('pairing.qrAlt')}
      width={248}
      height={248}
      className="size-[248px] shrink-0 rounded-lg border border-line bg-white p-2"
    />
  )
}

function PainelDeRisco({ sessionId }: { sessionId: string }) {
  const t = useT()
  const risco = useQuery<RiskSnapshot>(`/v1/sessions/${sessionId}/risk`, 5000)

  if (!risco.settled) {
    return (
      <Card title={t('risk.title')}>
        <Skeleton className="h-52" />
      </Card>
    )
  }

  if (!risco.data) {
    return (
      <Card title={t('risk.title')}>
        <Empty>{t('risk.none')}</Empty>
      </Card>
    )
  }

  const { score, usage, limits, warmup, throttleFactor } = risco.data
  const tom: Tone = score.value < 40 ? 'ok' : score.value < 70 ? 'warn' : 'crit'
  const pontuando = score.factors.filter((fator) => fator.points > 0)

  return (
    <Card title={t('risk.title')} hint={t('risk.hint')}>
      <div className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-3">
          <Stat
            label={t('risk.score')}
            value={score.value}
            unit="/100"
            tone={tom === 'ok' ? 'ok' : tom === 'warn' ? 'warn' : 'crit'}
          />
          <div className="text-right">
            <span className="eyebrow">{t('risk.warmup')}</span>
            <p className="font-mono text-sm text-ink tnum">{pct(warmup.factor)}</p>
            <p className="text-xs text-muted">
              {t('risk.ageDays', { n: warmup.ageInDays.toFixed(1) })}
            </p>
          </div>
        </div>

        {throttleFactor < 1 && (
          <p className="rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">
            {t('risk.throttled', { rate: pct(throttleFactor) })}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <span className="eyebrow">{t('risk.windows')}</span>
          <Barra rotulo={t('risk.perMinute')} usado={usage.minute} limite={limits.perMinute} />
          <Barra rotulo={t('risk.perHour')} usado={usage.hour} limite={limits.perHour} />
          <Barra rotulo={t('risk.perDay')} usado={usage.day} limite={limits.perDay} />
          <Barra
            rotulo={t('risk.newContactsToday')}
            usado={usage.newContactsToday}
            limite={limits.newContactsPerDay}
          />
        </div>

        {/* Fator que não pontuou não explica nada; o cabeçalho sozinho só ocupa espaço. */}
        {pontuando.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">{t('risk.factors')}</span>
            <ul className="flex flex-col gap-1">
              {pontuando.map((fator) => (
                <li key={fator.name} className="flex items-baseline justify-between gap-2">
                  <span className="text-xs text-muted">{fator.detail}</span>
                  <span className="shrink-0 font-mono text-xs text-ink tnum">
                    +{fator.points}
                    <span className="text-muted">/{fator.max}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}

function Barra({ rotulo, usado, limite }: { rotulo: string; usado: number; limite: number }) {
  const fracao = limite > 0 ? Math.min(usado / limite, 1) : 0
  const cor = fracao > 0.9 ? 'var(--crit)' : fracao > 0.7 ? 'var(--warn)' : 'var(--ok)'

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted">{rotulo}</span>
        <span className="font-mono text-ink tnum">
          {num(usado)}
          <span className="text-muted">/{num(limite)}</span>
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${fracao * 100}%`, background: cor }}
        />
      </div>
    </div>
  )
}

const TOM_POR_EVENTO: Record<string, Tone> = {
  connected: 'ok',
  paired: 'ok',
  connecting: 'warn',
  qr: 'warn',
  disconnected: 'crit',
  logged_out: 'crit',
  banned: 'crit',
}

function Timeline({ sessionId }: { sessionId: string }) {
  const t = useT()
  const eventos = useQuery<{ events: SessionEvent[] }>(
    `/v1/sessions/${sessionId}/events?limit=40`,
    10_000,
  )

  return (
    <Card title={t('events.title')} hint={t('events.hint')}>
      {!eventos.settled ? (
        <Skeleton className="h-32" />
      ) : (eventos.data?.events.length ?? 0) === 0 ? (
        <Empty>{t('events.empty')}</Empty>
      ) : (
        <ol className="flex flex-col">
          {eventos.data?.events.map((evento) => (
            <li
              key={evento.id}
              className="flex flex-wrap items-center gap-3 border-b border-line/60 py-2 last:border-0"
            >
              <Pill tone={TOM_POR_EVENTO[evento.type] ?? 'hold'}>{evento.type}</Pill>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">
                {evento.cause ?? '—'}
                {evento.rawCode !== null && (
                  <span className="ml-1.5 font-mono opacity-70">({evento.rawCode})</span>
                )}
              </span>
              <span
                className="font-mono text-xs text-muted tnum"
                title={dataHora(evento.createdAt)}
              >
                {desde(evento.createdAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}
