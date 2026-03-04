import type { App as McpApp } from '@modelcontextprotocol/ext-apps'
import { useApp } from '@modelcontextprotocol/ext-apps/react'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { useCallback, useEffect, useState } from 'react'
import { timeframes, getTimeRange } from '../../../shared/lib/timeframes.ts'
import type { Timeframe } from '../../../shared/lib/timeframes.ts'
import { RequestsPerMinuteChart } from '../../../shared/components/RequestsPerMinuteChart.tsx'
import { ResponseTimeChart } from '../../../shared/components/ResponseTimeChart.tsx'
import { StatusCodesChart } from '../../../shared/components/StatusCodesChart.tsx'
import { TopCountriesTable } from '../../../shared/components/TopCountriesTable.tsx'
import { TopPathsTable } from '../../../shared/components/TopPathsTable.tsx'
import { SlowestRequestsTable } from '../../../shared/components/SlowestRequestsTable.tsx'
import './styles.css'

type MetricsData = {
  rpm: { time: string; value: string }[]
  responseTime: {
    avg: { time: string; value: string }[]
    p90: { time: string; value: string }[]
    p95: { time: string; value: string }[]
    p99: { time: string; value: string }[]
  }
  statusCodes: { time: string; value: Record<string, number> }[]
  topCountries: { country: string; total: number; response_time: number }[]
  topPages: { page: string; total: number }[]
  slowestRequests: {
    client_request_method: string
    client_request_path: string
    average_response_time_ms: number
    count_of_requests: number
  }[]
}

const extractText = (result: CallToolResult): string => {
  const item = result.content?.find((c) => c.type === 'text')
  return item && 'text' in item ? item.text : ''
}

const AppAnalyticsApp = () => {
  const [applicationId, setApplicationId] = useState<string | null>(null)
  const [selectedTimeframe, setSelectedTimeframe] = useState<Timeframe>(timeframes[0])
  const [metrics, setMetrics] = useState<MetricsData | null>(null)
  const [loading, setLoading] = useState(false)

  const { app, error } = useApp({
    appInfo: { name: 'App Analytics', version: '1.0.0' },
    capabilities: {},
    onAppCreated: (mcpApp: McpApp) => {
      mcpApp.ontoolresult = async (result) => {
        const data = JSON.parse(extractText(result))
        setApplicationId(data.application_id)
      }
      mcpApp.onerror = console.error
    },
  })

  const fetchMetrics = useCallback(async () => {
    if (!app || !applicationId) {
      return
    }
    setLoading(true)
    try {
      const { start, end } = getTimeRange(selectedTimeframe)
      const result = await app.callServerTool({
        name: 'get-app-http-metrics',
        arguments: {
          application_id: applicationId,
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
  }, [app, applicationId, selectedTimeframe])

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
          <RequestsPerMinuteChart data={metrics.rpm} hoursAgo={selectedTimeframe.hoursAgo} />
          <ResponseTimeChart
            avg={metrics.responseTime.avg}
            p90={metrics.responseTime.p90}
            p95={metrics.responseTime.p95}
            p99={metrics.responseTime.p99}
            hoursAgo={selectedTimeframe.hoursAgo}
          />
          <StatusCodesChart data={metrics.statusCodes} hoursAgo={selectedTimeframe.hoursAgo} />
          <TopCountriesTable data={metrics.topCountries} />
          <TopPathsTable data={metrics.topPages} />
          <SlowestRequestsTable data={metrics.slowestRequests} />
        </div>
      ) : (
        <div className="loading">No data</div>
      )}
    </div>
  )
}

export default AppAnalyticsApp
