import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDateTime } from '../lib/formatters.ts'

type Props = {
  cpuUsage: { time: string; value: string }[]
  cpuLimit: { time: string; value: string }[]
  hoursAgo: number
}

export const CpuChart = ({ cpuUsage, cpuLimit, hoursAgo }: Props) => {
  const points = useMemo(() => {
    const usageMap = new Map<number, { time: number; usage: number; limit: number }>()

    for (const p of cpuUsage) {
      const time = Number(p.time)
      usageMap.set(time, { time, usage: Number(p.value) * 100, limit: 0 })
    }

    for (const p of cpuLimit) {
      const time = Number(p.time)
      const existing = usageMap.get(time)
      if (existing) {
        existing.limit = Number(p.value) * 100
      } else {
        usageMap.set(time, { time, usage: 0, limit: Number(p.value) * 100 })
      }
    }

    return Array.from(usageMap.values()).sort((a, b) => a.time - b.time)
  }, [cpuUsage, cpuLimit])

  return (
    <div className="chart-card">
      <h3>CPU usage</h3>
      <div className="subtitle">
        {points.length > 0 && points[0].limit > 0
          ? `Limit: ${(points[0].limit / 100).toFixed(1)} core / ${points[0].limit.toFixed(0)}%`
          : ''}
      </div>
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
            tickFormatter={(v) => `${v.toFixed(0)}%`}
            domain={[0, (max: number) => Math.max(max, points[0]?.limit ?? 0) * 1.2]}
            style={{ fontSize: 11 }}
          />
          <Tooltip
            labelFormatter={(v) => new Date(v).toLocaleString()}
            formatter={(v: number | undefined, name: string | undefined) => [
              `${(v ?? 0).toFixed(2)}%`,
              name === 'usage' ? 'Usage' : 'Limit',
            ]}
            contentStyle={{
              background: 'var(--color-bg-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              fontSize: 12,
            }}
          />
          <Area
            dataKey="limit"
            type="linear"
            fill="none"
            stroke="var(--color-failed)"
            strokeDasharray="5 5"
            strokeWidth={1}
            connectNulls={false}
          />
          <Area
            dataKey="usage"
            type="linear"
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
