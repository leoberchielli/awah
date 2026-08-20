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
import type { Series } from '../lib/api'
import { num, timeOfDay } from '../lib/format'
import { Empty } from './ui'

/**
 * The series arrive from the server one per metric; the chart needs one row per
 * instant with every metric together. The pivot happens here rather than in
 * SQL, because the same endpoint feeds both the chart and the export.
 */
export function pivot(series: Series[]): Array<Record<string, number | string>> {
  const byBucket = new Map<string, Record<string, number | string>>()

  for (const metricSeries of series) {
    for (const point of metricSeries.points) {
      const key = new Date(point.bucket).toISOString()
      const row = byBucket.get(key) ?? { bucket: key }
      row[metricSeries.metric] = point.value
      byBucket.set(key, row)
    }
  }

  return [...byBucket.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)))
}

const axis = {
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

export interface SeriesStyle {
  key: string
  label: string
  color: string
}

export function AreaSeries({
  series,
  styles,
  height = 200,
  stacked = false,
}: {
  series: Series[]
  styles: SeriesStyle[]
  height?: number
  stacked?: boolean
}) {
  const data = pivot(series)
  if (data.length === 0) return <NoData height={height} />

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <defs>
          {styles.map((v) => (
            <linearGradient key={v.key} id={`grad-${v.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={v.color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={v.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="bucket" tickFormatter={timeOfDay} minTickGap={28} {...axis} />
        <YAxis width={48} tickFormatter={num} {...axis} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(value) => timeOfDay(String(value))}
          formatter={(value, name) => [
            num(Number(value)),
            styles.find((v) => v.key === name)?.label ?? name,
          ]}
        />
        {styles.map((v) => (
          <Area
            key={v.key}
            type="monotone"
            dataKey={v.key}
            name={v.key}
            stroke={v.color}
            strokeWidth={1.75}
            fill={`url(#grad-${v.key})`}
            stackId={stacked ? 'total' : undefined}
            isAnimationActive={false}
            dot={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function SeriesPoint({
  series,
  styles,
  height = 200,
  domain,
}: {
  series: Series[]
  styles: SeriesStyle[]
  height?: number
  domain?: [number, number]
}) {
  const data = pivot(series)
  if (data.length === 0) return <NoData height={height} />

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey="bucket" tickFormatter={timeOfDay} minTickGap={28} {...axis} />
        <YAxis width={44} domain={domain} tickFormatter={num} {...axis} />
        <Tooltip
          {...tooltipStyle}
          labelFormatter={(value) => timeOfDay(String(value))}
          formatter={(value, name) => [
            num(Number(value)),
            styles.find((v) => v.key === name)?.label ?? name,
          ]}
        />
        {styles.map((v) => (
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
  data,
  height = 200,
}: {
  data: Array<{ label: string; value: number; color?: string }>
  height?: number
}) {
  if (data.length === 0) return <NoData height={height} />

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" horizontal={false} />
        <XAxis type="number" tickFormatter={num} {...axis} />
        <YAxis type="category" dataKey="rotulo" width={92} {...axis} />
        <Tooltip
          {...tooltipStyle}
          cursor={{ fill: 'var(--surface-2)' }}
          formatter={(v) => num(Number(v))}
        />
        <Bar dataKey="valor" radius={[0, 4, 4, 0]} isAnimationActive={false} barSize={16}>
          {data.map((entry) => (
            <Cell key={entry.label} fill={entry.color ?? 'var(--accent)'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/**
 * Delivery funnel as proportional bars.
 *
 * Not a library chart, because what matters here is the **drop between
 * stages**, and no off-the-shelf type shows that better than bars aligned on
 * the same baseline.
 */
export interface FunnelStep {
  label: string
  value: number
  color: string
  /**
   * What this stage is measured against. By default the stage before it —
   * which is what "funnel" means. Failed is not the stage after read: comparing
   * the two would produce a percentage that means nothing, which is why
   * whoever builds the list can point at another base.
   */
  base?: number
}

export function Funnel({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((e) => e.value), 1)

  return (
    <ul className="flex flex-col gap-3">
      {steps.map((step, index) => {
        const base = step.base ?? steps[index - 1]?.value
        const share = base && base > 0 ? step.value / base : null

        return (
          <li key={step.label} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted">{step.label}</span>
              <span className="flex items-baseline gap-2">
                {share !== null && (
                  <span className="font-mono text-[11px] text-muted tnum">
                    {(share * 100).toFixed(0)}%
                  </span>
                )}
                <span className="font-mono text-sm font-medium text-ink tnum">
                  {num(step.value)}
                </span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${Math.max((step.value / max) * 100, step.value > 0 ? 2 : 0)}%`,
                  background: step.color,
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

function NoData({ height }: { height: number }) {
  const t = useT()
  return (
    <div style={{ height: height }} className="flex items-center">
      <Empty>{t('common.noDataInWindow')}</Empty>
    </div>
  )
}
