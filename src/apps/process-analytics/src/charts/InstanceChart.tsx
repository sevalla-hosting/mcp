import { useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDateTime } from '../../../../shared/lib/formatters.ts'

type Props = {
  instanceCount: { time: string; value: string }[]
  hoursAgo: number
}

export const InstanceChart = ({ instanceCount, hoursAgo }: Props) => {
  const points = useMemo(
    () =>
      instanceCount.map((d) => ({
        time: Number(d.time),
        value: Number(d.value),
      })),
    [instanceCount],
  )

  return (
    <div className="chart-card">
      <h3>Instance count</h3>
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
            tickCount={5}
            domain={[0, (max: number) => Math.max(1, Math.ceil(max * 1.2))]}
            allowDecimals={false}
            style={{ fontSize: 11 }}
          />
          <Tooltip
            labelFormatter={(v) => new Date(v).toLocaleString()}
            formatter={(v: number | undefined) => [Math.round(v ?? 0), 'Instances']}
            contentStyle={{
              background: 'var(--color-bg-card)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              fontSize: 12,
            }}
          />
          <Area
            dataKey="value"
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
