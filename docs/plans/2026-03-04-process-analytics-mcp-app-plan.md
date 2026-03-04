# Process Analytics MCP App — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an MCP App that renders interactive process analytics charts (CPU, memory, instance count) inside MCP hosts, using React + Recharts to match the Sevalla frontend's visual style.

**Architecture:** A single tool (`process-analytics`) with `_meta.ui.resourceUri` renders a React app in a sandboxed iframe. Two helper tools (`list-processes`, `get-process-metrics`) are called from the app UI to fetch data. The React app is bundled into a single HTML file via Vite + `vite-plugin-singlefile` and served as a `ui://` resource.

**Tech Stack:** `@modelcontextprotocol/ext-apps`, React 19, Recharts, date-fns, Vite, `vite-plugin-singlefile`, `@vitejs/plugin-react`

---

### Task 1: Install dependencies and configure build tooling

**Files:**
- Modify: `package.json`
- Create: `vite.config.ts`
- Create: `tsconfig.app.json` (separate tsconfig for the React app, since main tsconfig excludes DOM libs)

**Step 1: Install dependencies**

Run:
```bash
pnpm add @modelcontextprotocol/ext-apps react react-dom recharts date-fns
pnpm add -D @vitejs/plugin-react @types/react @types/react-dom vite vite-plugin-singlefile cross-env
```

**Step 2: Create `vite.config.ts`**

```ts
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const INPUT = process.env.INPUT
if (!INPUT) {
  throw new Error('INPUT environment variable is not set')
}

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    rollupOptions: { input: INPUT },
    outDir: 'dist',
    emptyOutDir: false,
  },
})
```

**Step 3: Create `tsconfig.app.json`**

This is needed because the main `tsconfig.json` has `"noEmit": true` and doesn't include DOM libs. The app code needs DOM + JSX support.

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/apps", "src/shared"]
}
```

**Step 4: Add build scripts to `package.json`**

Add to `scripts`:
```json
"build:app": "cross-env INPUT=src/apps/process-analytics/index.html vite build",
"dev:app": "cross-env INPUT=src/apps/process-analytics/index.html vite"
```

**Step 5: Verify build tooling works**

Create a minimal placeholder `src/apps/process-analytics/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>Process Analytics</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./src/main.tsx"></script>
</body>
</html>
```

And a minimal `src/apps/process-analytics/src/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client'

createRoot(document.getElementById('root')!).render(<div>Process Analytics</div>)
```

Run:
```bash
pnpm build:app
```

Expected: `dist/index.html` is created with all JS/CSS inlined.

**Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml vite.config.ts tsconfig.app.json src/apps/process-analytics/index.html src/apps/process-analytics/src/main.tsx
git commit -m "feat: add build tooling for MCP Apps (Vite + React)"
```

---

### Task 2: Register MCP App tools on the server

**Files:**
- Create: `src/apps/process-analytics/tools.ts`
- Modify: `src/index.ts`

**Step 1: Create `src/apps/process-analytics/tools.ts`**

This file exports a function that registers the 3 tools + 1 resource on an `McpServer` instance.

```ts
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs/promises'
import path from 'node:path'

const DIST_DIR = path.join(import.meta.dirname, '../../../dist')

const resourceUri = 'ui://process-analytics/app.html'

export const registerProcessAnalyticsApp = (server: McpServer, apiFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) => {
  registerAppTool(
    server,
    'process-analytics',
    {
      title: 'Process Analytics',
      description: 'Shows interactive CPU, memory, and instance count charts for an application\'s processes. Use when the user asks about process metrics, resource usage, or performance monitoring.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          application_id: { type: 'string', description: 'The application UUID' },
        },
        required: ['application_id'],
      },
      _meta: { ui: { resourceUri } },
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const applicationId = args.application_id as string
      const res = await apiFetch(`https://api.sevalla.com/applications/${applicationId}/processes`)
      const processes = await res.json()
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ application_id: applicationId, processes }),
        }],
      }
    },
  )

  server.registerTool(
    'list-processes',
    {
      description: 'List processes for an application. Called by the process-analytics app UI.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          application_id: { type: 'string', description: 'The application UUID' },
        },
        required: ['application_id'],
      },
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const applicationId = args.application_id as string
      const res = await apiFetch(`https://api.sevalla.com/applications/${applicationId}/processes`)
      const data = await res.json()
      return { content: [{ type: 'text', text: JSON.stringify(data) }] }
    },
  )

  server.registerTool(
    'get-process-metrics',
    {
      description: 'Fetch CPU, memory, and instance count metrics for a process. Called by the process-analytics app UI.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          application_id: { type: 'string', description: 'The application UUID' },
          process_id: { type: 'string', description: 'The process UUID' },
          start: { type: 'string', description: 'ISO 8601 start time' },
          end: { type: 'string', description: 'ISO 8601 end time' },
          interval_in_seconds: { type: 'number', description: 'Aggregation interval in seconds' },
        },
        required: ['application_id', 'process_id', 'start', 'end', 'interval_in_seconds'],
      },
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const { application_id, process_id, start, end, interval_in_seconds } = args as {
        application_id: string
        process_id: string
        start: string
        end: string
        interval_in_seconds: number
      }
      const base = `https://api.sevalla.com/applications/${application_id}/processes/${process_id}/metrics`
      const qs = `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&interval_in_seconds=${interval_in_seconds}`

      const [cpuUsage, cpuLimit, memoryUsage, memoryLimit, instanceCount] = await Promise.all([
        apiFetch(`${base}/cpu-usage${qs}`).then((r) => r.json()),
        apiFetch(`${base}/cpu-limit${qs}`).then((r) => r.json()),
        apiFetch(`${base}/memory-usage${qs}`).then((r) => r.json()),
        apiFetch(`${base}/memory-limit${qs}`).then((r) => r.json()),
        apiFetch(`${base}/instance-count${qs}`).then((r) => r.json()),
      ])

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ cpuUsage, cpuLimit, memoryUsage, memoryLimit, instanceCount }),
        }],
      }
    },
  )

  registerAppResource(
    server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, 'index.html'), 'utf-8')
      return { contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }] }
    },
  )
}
```

**Step 2: Integrate into `src/index.ts`**

Add import at the top:
```ts
import { registerProcessAnalyticsApp } from './apps/process-analytics/tools.ts'
```

Inside `createMcpServer`, after the CodeMode tool registration loop, add:
```ts
registerProcessAnalyticsApp(server, createAuthenticatedFetch(token))
```

**Step 3: Verify server starts without errors**

Run:
```bash
pnpm build:app && pnpm start
```

Expected: Server starts on port 3000 without errors.

**Step 4: Commit**

```bash
git add src/apps/process-analytics/tools.ts src/index.ts
git commit -m "feat: register process-analytics MCP App tools and resource"
```

---

### Task 3: Create shared utilities (timeframes + formatters)

**Files:**
- Create: `src/shared/lib/timeframes.ts`
- Create: `src/shared/lib/formatters.ts`

**Step 1: Create `src/shared/lib/timeframes.ts`**

Matching the Sevalla frontend's timeframe config:

```ts
export type Timeframe = {
  label: string
  key: string
  intervalInSeconds: number
  hoursAgo: number
}

export const timeframes: Timeframe[] = [
  { label: '1h', key: '1h', hoursAgo: 1, intervalInSeconds: 60 },
  { label: '6h', key: '6h', hoursAgo: 6, intervalInSeconds: 60 },
  { label: '24h', key: '24h', hoursAgo: 24, intervalInSeconds: 600 },
  { label: '7d', key: '7d', hoursAgo: 168, intervalInSeconds: 1800 },
]

export const getTimeRange = (tf: Timeframe): { start: string; end: string } => {
  const end = new Date()
  const start = new Date(end.getTime() - tf.hoursAgo * 60 * 60 * 1000)
  return { start: start.toISOString(), end: end.toISOString() }
}

export const getXAxisDateFormat = (hoursAgo: number): string => {
  if (hoursAgo <= 24) return 'HH:mm'
  if (hoursAgo <= 168) return 'MMM dd HH:mm'
  return 'MMM dd'
}
```

**Step 2: Create `src/shared/lib/formatters.ts`**

```ts
export const formatCpuPercent = (value: number): string => `${(value * 100).toFixed(1)}%`

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`
}

export const formatDateTime = (timestamp: number, hoursAgo: number): string => {
  const date = new Date(timestamp)
  if (hoursAgo <= 24) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if (hoursAgo <= 168) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
```

**Step 3: Commit**

```bash
git add src/shared/lib/timeframes.ts src/shared/lib/formatters.ts
git commit -m "feat: add shared timeframe configs and formatting utilities"
```

---

### Task 4: Build the React app — main layout and data fetching

**Files:**
- Create: `src/apps/process-analytics/src/main.tsx` (replace placeholder)
- Create: `src/apps/process-analytics/src/App.tsx`
- Create: `src/apps/process-analytics/src/styles.css`

**Step 1: Create `src/apps/process-analytics/src/styles.css`**

Global styles with OKLCH colors matching Sevalla frontend:

```css
:root {
  color-scheme: light dark;

  --color-text-primary: light-dark(#1f2937, #f3f4f6);
  --color-bg: light-dark(#ffffff, #1a1a1a);
  --color-bg-card: light-dark(#ffffff, #262626);
  --color-border: light-dark(#e5e7eb, #374151);
  --color-text-muted: light-dark(#6b7280, #9ca3af);

  --chart-1: oklch(0.646 0.222 41.116);
  --chart-2: oklch(0.6 0.118 184.704);
  --color-failed: oklch(0.637 0.237 25.331);

  --font-sans: ui-sans-serif, system-ui, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --radius: 0.625rem;
}

.dark {
  --chart-1: oklch(0.735 0.179 55.934);
  --chart-2: oklch(0.696 0.108 186.813);
  --color-failed: oklch(0.704 0.191 22.216);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  font-family: var(--font-sans);
  color: var(--color-text-primary);
  background: var(--color-bg);
  font-size: 14px;
  line-height: 1.5;
}

.app {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar select {
  padding: 6px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
  background: var(--color-bg-card);
  color: var(--color-text-primary);
  font-size: 13px;
}

.time-range {
  display: flex;
  gap: 4px;
}

.time-range button {
  padding: 4px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
  background: var(--color-bg-card);
  color: var(--color-text-primary);
  cursor: pointer;
  font-size: 13px;
}

.time-range button.active {
  background: var(--chart-1);
  color: #fff;
  border-color: transparent;
}

.charts-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}

@media (min-width: 768px) {
  .charts-grid {
    grid-template-columns: 1fr 1fr;
  }
}

.chart-card {
  background: var(--color-bg-card);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 16px;
}

.chart-card h3 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.chart-card .subtitle {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 12px;
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--color-text-muted);
}
```

**Step 2: Create `src/apps/process-analytics/src/App.tsx`**

```tsx
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
    if (!app || !applicationId || !selectedProcess) return
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

  if (error) return <div className="loading">Error: {error.message}</div>
  if (!app) return <div className="loading">Connecting...</div>
  if (!applicationId) return <div className="loading">Waiting for application data...</div>

  return (
    <div className="app">
      <div className="toolbar">
        <select
          value={selectedProcess ?? ''}
          onChange={(e) => setSelectedProcess(e.target.value)}
        >
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
          <CpuChart
            cpuUsage={metrics.cpuUsage}
            cpuLimit={metrics.cpuLimit}
            hoursAgo={selectedTimeframe.hoursAgo}
          />
          <MemoryChart
            memoryUsage={metrics.memoryUsage}
            memoryLimit={metrics.memoryLimit}
            hoursAgo={selectedTimeframe.hoursAgo}
          />
          <InstanceChart
            instanceCount={metrics.instanceCount}
            hoursAgo={selectedTimeframe.hoursAgo}
          />
        </div>
      ) : (
        <div className="loading">No data</div>
      )}
    </div>
  )
}

export default ProcessAnalyticsApp
```

**Step 3: Update `src/apps/process-analytics/src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ProcessAnalyticsApp from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProcessAnalyticsApp />
  </StrictMode>,
)
```

**Step 4: Commit**

```bash
git add src/apps/process-analytics/src/
git commit -m "feat: add process analytics app layout with data fetching"
```

---

### Task 5: Build the CPU chart component

**Files:**
- Create: `src/apps/process-analytics/src/charts/CpuChart.tsx`

**Step 1: Create the CPU chart**

Matching the Sevalla frontend's `CpuChart` — area chart with usage fill + dashed limit line.

```tsx
import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatDateTime } from '../../../../shared/lib/formatters.ts'

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
            formatter={(v: number, name: string) => [
              `${v.toFixed(2)}%`,
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
```

**Step 2: Commit**

```bash
git add src/apps/process-analytics/src/charts/CpuChart.tsx
git commit -m "feat: add CPU usage chart component"
```

---

### Task 6: Build the Memory chart component

**Files:**
- Create: `src/apps/process-analytics/src/charts/MemoryChart.tsx`

**Step 1: Create the Memory chart**

Same visual pattern as CPU but with byte formatting on Y-axis.

```tsx
import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatBytes, formatDateTime } from '../../../../shared/lib/formatters.ts'

type Props = {
  memoryUsage: { time: string; value: string }[]
  memoryLimit: { time: string; value: string }[]
  hoursAgo: number
}

export const MemoryChart = ({ memoryUsage, memoryLimit, hoursAgo }: Props) => {
  const points = useMemo(() => {
    const map = new Map<number, { time: number; usage: number; limit: number }>()

    for (const p of memoryUsage) {
      const time = Number(p.time)
      map.set(time, { time, usage: Number(p.value), limit: 0 })
    }

    for (const p of memoryLimit) {
      const time = Number(p.time)
      const existing = map.get(time)
      if (existing) {
        existing.limit = Number(p.value)
      } else {
        map.set(time, { time, usage: 0, limit: Number(p.value) })
      }
    }

    return Array.from(map.values()).sort((a, b) => a.time - b.time)
  }, [memoryUsage, memoryLimit])

  return (
    <div className="chart-card">
      <h3>Memory usage</h3>
      <div className="subtitle">
        {points.length > 0 && points[0].limit > 0
          ? `Limit: ${formatBytes(points[0].limit)}`
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
            tickFormatter={(v) => formatBytes(v)}
            domain={[0, (max: number) => Math.max(max, points[0]?.limit ?? 0) * 1.2]}
            style={{ fontSize: 11 }}
          />
          <Tooltip
            labelFormatter={(v) => new Date(v).toLocaleString()}
            formatter={(v: number, name: string) => [
              formatBytes(v),
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
```

**Step 2: Commit**

```bash
git add src/apps/process-analytics/src/charts/MemoryChart.tsx
git commit -m "feat: add memory usage chart component"
```

---

### Task 7: Build the Instance Count chart component

**Files:**
- Create: `src/apps/process-analytics/src/charts/InstanceChart.tsx`

**Step 1: Create the Instance Count chart**

Step-type area chart with integer Y-axis, no limit line.

```tsx
import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
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
            formatter={(v: number) => [Math.round(v), 'Instances']}
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
```

**Step 2: Commit**

```bash
git add src/apps/process-analytics/src/charts/InstanceChart.tsx
git commit -m "feat: add instance count chart component"
```

---

### Task 8: Build, verify, and final commit

**Files:**
- All files from previous tasks

**Step 1: Build the app**

Run:
```bash
pnpm build:app
```

Expected: `dist/index.html` is created with all React + Recharts + CSS inlined into a single file.

**Step 2: Run type checking**

Run:
```bash
npx tsc --noEmit -p tsconfig.app.json
```

Expected: No type errors.

**Step 3: Run the server**

Run:
```bash
pnpm start
```

Expected: Server starts on port 3000. The `process-analytics` tool and `list-processes`/`get-process-metrics` tools are registered alongside the existing CodeMode tools.

**Step 4: Run existing tests**

Run:
```bash
pnpm test
```

Expected: All existing tests still pass.

**Step 5: Run lint and format checks**

Run:
```bash
pnpm check:code
```

Fix any issues that arise.

**Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address lint and type issues"
```
