import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDateTime } from '../lib/formatters.ts'

type StatusCodeEntry = { time: string; value: Record<string, number> }

type Props = {
  data: StatusCodeEntry[]
  hoursAgo: number
}

const STATUS_COLORS: Record<string, string> = {
  '1xx': 'oklch(0.7 0.1 250)',
  '2xx': 'oklch(0.7 0.15 145)',
  '3xx': 'oklch(0.7 0.12 80)',
  '4xx': 'oklch(0.7 0.15 55)',
  '5xx': 'oklch(0.65 0.2 25)',
}

export const StatusCodesChart = ({ data, hoursAgo }: Props) => {
  const points = useMemo(() => {
    return data.map((d) => {
      const buckets: Record<string, number> = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }
      if (d.value && typeof d.value === 'object') {
        for (const [code, count] of Object.entries(d.value)) {
          const num = Number(code)
          if (num >= 100 && num < 200) {
            buckets['1xx'] += count
          } else if (num < 300) {
            buckets['2xx'] += count
          } else if (num < 400) {
            buckets['3xx'] += count
          } else if (num < 500) {
            buckets['4xx'] += count
          } else {
            buckets['5xx'] += count
          }
        }
      }
      return { time: Number(d.time), ...buckets }
    })
  }, [data])

  return (
    <div className="chart-card">
      <h3>Status codes</h3>
      <div className="subtitle">&nbsp;</div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={points} margin={{ left: 12, right: 12 }}>
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
            tickFormatter={(v) => `${Math.round(v)}`}
            style={{ fontSize: 11 }}
          />
          <Tooltip
            labelFormatter={(v) => new Date(v).toLocaleString()}
            formatter={(v: number | undefined, name: string | undefined) => [Math.round(v ?? 0), name ?? '']}
            contentStyle={{
              background: 'var(--color-bg-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              fontSize: 12,
            }}
          />
          {Object.entries(STATUS_COLORS).map(([key, color]) => (
            <Bar key={key} dataKey={key} stackId="a" fill={color} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
