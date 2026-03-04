import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatBytes, formatDateTime } from '../lib/formatters.ts'

type Props = {
  storageUsage: { time: string; value: string }[]
  storageLimit: { time: string; value: string }[]
  hoursAgo: number
}

export const StorageChart = ({ storageUsage, storageLimit, hoursAgo }: Props) => {
  const points = useMemo(() => {
    const map = new Map<number, { time: number; usage: number; limit: number }>()

    for (const p of storageUsage) {
      const time = Number(p.time)
      map.set(time, { time, usage: Number(p.value), limit: 0 })
    }

    for (const p of storageLimit) {
      const time = Number(p.time)
      const existing = map.get(time)
      if (existing) {
        existing.limit = Number(p.value)
      } else {
        map.set(time, { time, usage: 0, limit: Number(p.value) })
      }
    }

    return Array.from(map.values()).sort((a, b) => a.time - b.time)
  }, [storageUsage, storageLimit])

  return (
    <div className="chart-card">
      <h3>Storage usage</h3>
      <div className="subtitle">
        {points.length > 0 && points[0].limit > 0 ? `Limit: ${formatBytes(points[0].limit)}` : ''}
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
            tickFormatter={(v) => formatBytes(v)}
            domain={[0, (max: number) => Math.max(max, points[0]?.limit ?? 0) * 1.2]}
            style={{ fontSize: 11 }}
          />
          <Tooltip
            labelFormatter={(v) => new Date(v).toLocaleString()}
            formatter={(v: number | undefined, name: string | undefined) => [
              formatBytes(v ?? 0),
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
