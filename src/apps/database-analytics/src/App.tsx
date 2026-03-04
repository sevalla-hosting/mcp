import type { App as McpApp } from '@modelcontextprotocol/ext-apps'
import { useApp } from '@modelcontextprotocol/ext-apps/react'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { useCallback, useEffect, useState } from 'react'
import { timeframes, getTimeRange } from '../../../shared/lib/timeframes.ts'
import type { Timeframe } from '../../../shared/lib/timeframes.ts'
import { CpuChart } from '../../../shared/components/CpuChart.tsx'
import { MemoryChart } from '../../../shared/components/MemoryChart.tsx'
import { StorageChart } from '../../../shared/components/StorageChart.tsx'
import './styles.css'

type MetricsData = {
  metrics: {
    'cpu-usage': { time: string; value: string }[]
    'cpu-limit': { time: string; value: string }[]
    'memory-usage': { time: string; value: string }[]
    'memory-limit': { time: string; value: string }[]
    'storage-usage': { time: string; value: string }[]
    'storage-limit': { time: string; value: string }[]
  }
}

const extractText = (result: CallToolResult): string => {
  const item = result.content?.find((c) => c.type === 'text')
  return item && 'text' in item ? item.text : ''
}

const DatabaseAnalyticsApp = () => {
  const [databaseId, setDatabaseId] = useState<string | null>(null)
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>(timeframes[0])
  const [metrics, setMetrics] = useState<MetricsData | null>(null)
  const [loading, setLoading] = useState(false)

  const { app, error } = useApp({
    appInfo: { name: 'Database Analytics', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (mcpApp: McpApp) => {
      mcpApp.ontoolresult = async (result) => {
        const data = JSON.parse(extractText(result))
        setDatabaseId(data.database_id)
      }
      mcpApp.onerror = console.error
    },
  })

  const fetchMetrics = useCallback(async () => {
    if (!app || !databaseId) {
      return
    }
    setLoading(true)
    try {
      const { from, to } = getTimeRange(selectedTimeframe)
      const result = await app.callServerTool({
        name: 'get-database-metrics',
        arguments: { database_id: databaseId, from, to, interval_in_seconds: selectedTimeframe.intervalInSeconds },
      })
      setMetrics(JSON.parse(extractText(result)))
    } catch (e) {
      console.error('Failed to fetch metrics:', e)
    } finally {
      setLoading(false)
    }
  }, [app, databaseId, selectedTimeframe])

  useEffect(() => {
    fetchMetrics()
  }, [fetchMetrics])

  if (error) {
    return <div className="loading">Error: {error.message}</div>
  }
  if (!app) {
    return <div className="loading">Connecting...</div>
  }
  if (!databaseId) {
    return <div className="loading">Waiting for database data...</div>
  }

  const m = metrics?.metrics

  return (
    <div className="app">
      <div className="toolbar">
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
      ) : m ? (
        <div className="charts-grid">
          <CpuChart cpuUsage={m['cpu-usage']} cpuLimit={m['cpu-limit']} hoursAgo={selectedTimeframe.hoursAgo} />
          <MemoryChart
            memoryUsage={m['memory-usage']}
            memoryLimit={m['memory-limit']}
            hoursAgo={selectedTimeframe.hoursAgo}
          />
          <StorageChart
            storageUsage={m['storage-usage']}
            storageLimit={m['storage-limit']}
            hoursAgo={selectedTimeframe.hoursAgo}
          />
        </div>
      ) : (
        <div className="loading">No data</div>
      )}
    </div>
  )
}

export default DatabaseAnalyticsApp
