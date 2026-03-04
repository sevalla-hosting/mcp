import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDateTime } from '../lib/formatters.ts'

type Props = {
  avg: { time: string; value: string }[]
  p90: { time: string; value: string }[]
  p95: { time: string; value: string }[]
  p99: { time: string; value: string }[]
  hoursAgo: number
}

export const ResponseTimeChart = ({ avg, p90, p95, p99, hoursAgo }: Props) => {
  const points = useMemo(() => {
    const map = new Map<number, { time: number; avg: number; p90: number; p95: number; p99: number }>()

    const merge = (series: { time: string; value: string }[], key: string) => {
      for (const p of series) {
        const time = Number(p.time)
        const existing = map.get(time) ?? { time, avg: 0, p90: 0, p95: 0, p99: 0 }
        ;(existing as Record<string, number>)[key] = Number(p.value)
        map.set(time, existing)
      }
    }

    merge(avg, 'avg')
    merge(p90, 'p90')
    merge(p95, 'p95')
    merge(p99, 'p99')

    return Array.from(map.values()).sort((a, b) => a.time - b.time)
  }, [avg, p90, p95, p99])

  return (
    <div className="chart-card">
      <h3>Response time</h3>
      <div className="subtitle">&nbsp;</div>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={points} margin={{ left: 12, right: 12 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis
            dataKey="time"
            scale="time"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(v) => formatDateTime(v, hoursAgo)}
            style={{ fontSize: 11 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(v) => `${Math.round(v)} ms`}
            domain={[0, (max: number) => max * 1.2]}
            style={{ fontSize: 11 }}
          />
          <Tooltip
            labelFormatter={(v) => new Date(v).toLocaleString()}
            formatter={(v: number | undefined, name: string | undefined) => [`${Math.round(v ?? 0)} ms`, name ?? '']}
            contentStyle={{
              background: 'var(--color-bg-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              fontSize: 12,
            }}
          />
          <Area dataKey="p99" type="step" fill="none" stroke="var(--chart-4)" strokeWidth={1} connectNulls={false} />
          <Area dataKey="p95" type="step" fill="none" stroke="var(--chart-3)" strokeWidth={1} connectNulls={false} />
          <Area dataKey="p90" type="step" fill="none" stroke="var(--chart-2)" strokeWidth={1} connectNulls={false} />
          <Area
            dataKey="avg"
            type="step"
            fill="var(--chart-1)"
            fillOpacity={0.1}
            stroke="var(--chart-1)"
            strokeWidth={1}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
