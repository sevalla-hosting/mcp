import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDateTime } from '../lib/formatters.ts'

type Props = {
  data: { time: string; value: string }[]
  hoursAgo: number
}

export const RequestsPerMinuteChart = ({ data, hoursAgo }: Props) => {
  const points = useMemo(() => data.map((d) => ({ time: Number(d.time), value: Number(d.value) })), [data])

  return (
    <div className="chart-card">
      <h3>Requests per minute</h3>
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
            tickFormatter={(v) => `${v.toFixed(1)} rpm`}
            domain={[0, (max: number) => max * 1.2]}
            style={{ fontSize: 11 }}
          />
          <Tooltip
            labelFormatter={(v) => new Date(v).toLocaleString()}
            formatter={(v: number | undefined) => [`${(v ?? 0).toFixed(1)} rpm`, 'Requests']}
            contentStyle={{
              background: 'var(--color-bg-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              fontSize: 12,
            }}
          />
          <Area
            dataKey="value"
            type="linear"
            fill="var(--chart-2)"
            fillOpacity={0.1}
            stroke="var(--chart-2)"
            strokeWidth={1}
            connectNulls={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
