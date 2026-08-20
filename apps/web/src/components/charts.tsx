import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useT } from '../i18n'
import type { Serie } from '../lib/api'
import { horario, num } from '../lib/format'
import { Empty } from './ui'

/**
 * As séries chegam do servidor uma por métrica; o gráfico precisa de uma linha
 * por instante com todas as métricas juntas. A pivotagem acontece aqui, e não no
 * SQL, porque o mesmo endpoint alimenta gráfico e exportação.
 */
export function pivotar(series: Serie[]): Array<Record<string, number | string>> {
  const porBucket = new Map<string, Record<string, number | string>>()

  for (const serie of series) {
    for (const ponto of serie.points) {
      const chave = new Date(ponto.bucket).toISOString()
      const linha = porBucket.get(chave) ?? { bucket: chave }
      linha[serie.metric] = ponto.value
      porBucket.set(chave, linha)
    }
  }

  return [...porBucket.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)))
}

const eixo = {
  stroke: 'var(--muted)',
  fontSize: 11,
  tickLine: false,
  axisLine: false,
}

const tooltipStyle = {
  contentStyle: {
    background: 'var(--surface)',
    border: '1px solid var(--line-strong)',
    borderRadius: 8,
    fontSize: 12,
    boxShadow: 'var(--shadow)',
    color: 'var(--ink)',
  },
  labelStyle: { color: 'var(--muted)', fontSize: 11, marginBottom: 4 },
  itemStyle: { color: 'var(--ink)' },
} as const

export interface SerieVisual {
  key: string
  label: string
  color: string
}

export function AreaSerie({
  series,
  visuais,
  altura = 200,
  empilhado = false,
}: {
  series: Serie[]
  visuais: SerieVisual[]
  altura?: number
  empilhado?: boolean
}) {
  const dados = pivotar(series)
  if (dados.length === 0) return <SemDados altura={altura} />

  return (
    <ResponsiveContainer width="100%" height={altura}>
      <AreaChart data={dados} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <defs>
          {visuais.map((v) => (
            <linearGradient key={v.key} id={`grad-${v.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={v.color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={v.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="bucket" tickFormatter={horario} minTickGap={28} {...eixo} />
        <YAxis width={48} tickFormatter={num} {...eixo} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(valor) => horario(String(valor))}
          formatter={(valor, nome) => [
            num(Number(valor)),
            visuais.find((v) => v.key === nome)?.label ?? nome,
          ]}
        />
        {visuais.map((v) => (
          <Area
            key={v.key}
            type="monotone"
            dataKey={v.key}
            name={v.key}
            stroke={v.color}
            strokeWidth={1.75}
            fill={`url(#grad-${v.key})`}
            stackId={empilhado ? 'total' : undefined}
            isAnimationActive={false}
            dot={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function LinhaSerie({
  series,
  visuais,
  altura = 200,
  dominio,
}: {
  series: Serie[]
  visuais: SerieVisual[]
  altura?: number
  dominio?: [number, number]
}) {
  const dados = pivotar(series)
  if (dados.length === 0) return <SemDados altura={altura} />

  return (
    <ResponsiveContainer width="100%" height={altura}>
      <LineChart data={dados} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="bucket" tickFormatter={horario} minTickGap={28} {...eixo} />
        <YAxis width={44} domain={dominio} tickFormatter={num} {...eixo} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(valor) => horario(String(valor))}
          formatter={(valor, nome) => [
            num(Number(valor)),
            visuais.find((v) => v.key === nome)?.label ?? nome,
          ]}
        />
        {visuais.map((v) => (
          <Line
            key={v.key}
            type="monotone"
            dataKey={v.key}
            name={v.key}
            stroke={v.color}
            strokeWidth={2}
            isAnimationActive={false}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

export function BarrasHorizontais({
  dados,
  altura = 200,
}: {
  dados: Array<{ rotulo: string; valor: number; cor?: string }>
  altura?: number
}) {
  if (dados.length === 0) return <SemDados altura={altura} />

  return (
    <ResponsiveContainer width="100%" height={altura}>
      <BarChart data={dados} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" horizontal={false} />
        <XAxis type="number" tickFormatter={num} {...eixo} />
        <YAxis type="category" dataKey="rotulo" width={92} {...eixo} />
        <Tooltip
          {...tooltipStyle}
          cursor={{ fill: 'var(--surface-2)' }}
          formatter={(v) => num(Number(v))}
        />
        <Bar dataKey="valor" radius={[0, 4, 4, 0]} isAnimationActive={false} barSize={16}>
          {dados.map((item) => (
            <Cell key={item.rotulo} fill={item.cor ?? 'var(--accent)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/**
 * Funil de entrega em barras proporcionais.
 *
 * Não é um gráfico de biblioteca porque o que importa aqui é a **queda entre
 * etapas**, e nenhum tipo pronto mostra isso melhor que barras alinhadas na
 * mesma base.
 */
export interface EtapaDoFunil {
  rotulo: string
  valor: number
  cor: string
  /**
   * Contra quem esta etapa é comparada. Por padrão, a etapa anterior — que é o
   * que "funil" significa. Falha não é etapa seguinte de leitura: comparar as
   * duas produziria uma porcentagem que não quer dizer nada, e por isso quem
   * monta a lista pode apontar outra base.
   */
  base?: number
}

export function Funil({ etapas }: { etapas: EtapaDoFunil[] }) {
  const topo = Math.max(...etapas.map((e) => e.valor), 1)

  return (
    <ul className="flex flex-col gap-3">
      {etapas.map((etapa, indice) => {
        const base = etapa.base ?? etapas[indice - 1]?.valor
        const proporcao = base && base > 0 ? etapa.valor / base : null

        return (
          <li key={etapa.rotulo} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted">{etapa.rotulo}</span>
              <span className="flex items-baseline gap-2">
                {proporcao !== null && (
                  <span className="font-mono text-[11px] text-muted tnum">
                    {(proporcao * 100).toFixed(0)}%
                  </span>
                )}
                <span className="font-mono text-sm font-medium text-ink tnum">
                  {num(etapa.valor)}
                </span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${Math.max((etapa.valor / topo) * 100, etapa.valor > 0 ? 2 : 0)}%`,
                  background: etapa.cor,
                }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export { Legend }

function SemDados({ altura }: { altura: number }) {
  const t = useT()
  return (
    <div style={{ height: altura }} className="flex items-center">
      <Empty>{t('common.noDataInWindow')}</Empty>
    </div>
  )
}
