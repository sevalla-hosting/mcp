import type { App as McpApp } from '@modelcontextprotocol/ext-apps'
import { useApp } from '@modelcontextprotocol/ext-apps/react'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { useCallback, useEffect, useState } from 'react'
import { timeframes, getTimeRange } from '../../../shared/lib/timeframes.ts'
import type { Timeframe } from '../../../shared/lib/timeframes.ts'
import { CpuChart } from './charts/CpuChart.tsx'
import { MemoryChart } from './charts/MemoryChart.tsx'
import { InstanceChart } from './charts/InstanceChart.tsx'
import './styles.css'

type Process = { id: string; display_name: string; key: string }

type MetricsData = {
  cpuUsage: { time: string; value: string }[]
  cpuLimit: { time: string; value: string }[]
  memoryUsage: { time: string; value: string }[]
  memoryLimit: { time: string; value: string }[]
  instanceCount: { time: string; value: string }[]
}

const extractText = (result: CallToolResult): string => {
  const item = result.content?.find((c) => c.type === 'text')
  return item && 'text' in item ? item.text : ''
}

const ProcessAnalyticsApp = () => {
  const [applicationId, setApplicationId] = useState<string | null>(null)
  const [processes, setProcesses] = useState<Process[]>([])
  const [selectedProcess, setSelectedProcess] = useState<string | null>(null)
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>(timeframes[0])
  const [metrics, setMetrics] = useState<MetricsData | null>(null)
  const [loading, setLoading] = useState(false)

  const { app, error } = useApp({
    appInfo: { name: 'Process Analytics', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (mcpApp: McpApp) => {
      mcpApp.ontoolresult = async (result) => {
        const data = JSON.parse(extractText(result))
        setApplicationId(data.application_id)
        if (data.processes?.items) {
          setProcesses(data.processes.items)
          if (data.processes.items.length > 0) {
            setSelectedProcess(data.processes.items[0].id)
          }
        }
      }
      mcpApp.onerror = console.error
    },
  })

  const fetchMetrics = useCallback(async () => {
    if (!app || !applicationId || !selectedProcess) {
      return
    }
    setLoading(true)
    try {
      const { start, end } = getTimeRange(selectedTimeframe)
      const result = await app.callServerTool({
        name: 'get-process-metrics',
        arguments: {
          application_id: applicationId,
          process_id: selectedProcess,
          start,
          end,
          interval_in_seconds: selectedTimeframe.intervalInSeconds,
        },
      })
      setMetrics(JSON.parse(extractText(result)))
    } catch (e) {
      console.error('Failed to fetch metrics:', e)
    } finally {
      setLoading(false)
    }
  }, [app, applicationId, selectedProcess, selectedTimeframe])

  useEffect(() => {
    fetchMetrics()
  }, [fetchMetrics])

  if (error) {
    return <div className="loading">Error: {error.message}</div>
  }
  if (!app) {
    return <div className="loading">Connecting...</div>
  }
  if (!applicationId) {
    return <div className="loading">Waiting for application data...</div>
  }

  return (
    <div className="app">
      <div className="toolbar">
        <select value={selectedProcess ?? ''} onChange={(e) => setSelectedProcess(e.target.value)}>
          {processes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.display_name || p.key}
            </option>
          ))}
        </select>
        <div className="time-range">
          {timeframes.map((tf) => (
            <button
              key={tf.key}
              className={selectedTimeframe.key === tf.key ? 'active' : ''}
              onClick={() => setSelectedTimeframe(tf)}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>
      {loading && !metrics ? (
        <div className="loading">Loading metrics...</div>
      ) : metrics ? (
        <div className="charts-grid">
          <CpuChart cpuUsage={metrics.cpuUsage} cpuLimit={metrics.cpuLimit} hoursAgo={selectedTimeframe.hoursAgo} />
          <MemoryChart
            memoryUsage={metrics.memoryUsage}
            memoryLimit={metrics.memoryLimit}
            hoursAgo={selectedTimeframe.hoursAgo}
          />
          <InstanceChart instanceCount={metrics.instanceCount} hoursAgo={selectedTimeframe.hoursAgo} />
        </div>
      ) : (
        <div className="loading">No data</div>
      )}
    </div>
  )
}

export default ProcessAnalyticsApp
