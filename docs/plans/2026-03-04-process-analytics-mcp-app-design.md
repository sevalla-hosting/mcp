# Process Analytics MCP App

## Overview

Add an MCP App that renders interactive process analytics charts (CPU, memory, instance count) directly inside MCP hosts (Claude, Claude Desktop, VS Code Copilot, etc.). Uses the MCP Apps extension (`@modelcontextprotocol/ext-apps`) with React + Recharts, matching the Sevalla frontend's visual style.

## Architecture

### Folder Structure

```
src/
  index.ts                        # existing MCP server — imports and registers app tools
  apps/
    process-analytics/
      tools.ts                    # registerAppTool + helper tools for this app
      index.html                  # Vite entry point
      src/
        main.tsx                  # App class init + React mount
        App.tsx                   # layout: process picker, time range, chart grid
        charts/
          CpuChart.tsx            # area chart: usage + dashed limit line
          MemoryChart.tsx         # area chart: usage + dashed limit line
          InstanceChart.tsx       # step area chart
  shared/
    lib/
      timeframes.ts              # preset time range configs (1h, 6h, 24h, 7d)
      formatters.ts              # CPU %, bytes, date formatting utilities
    components/
      TimeRangePicker.tsx         # reusable time range preset buttons
vite.config.ts                    # single-file bundling per app
```

Future apps (db-analytics, deployment-progress, etc.) follow the same pattern under `src/apps/`.

### MCP Tools

#### 1. `process-analytics` (main tool with UI)

- Input: `{ application_id: string }`
- `_meta.ui.resourceUri`: `ui://process-analytics/app.html`
- Returns text summary of application + available processes
- This is the tool the AI calls when the user asks about process metrics

#### 2. `list-processes` (helper, no UI)

- Input: `{ application_id: string }`
- Calls `GET /applications/{id}/processes`
- Returns JSON array of processes `[{ id, displayName, key }]`
- Called by the app UI via `app.callServerTool()`

#### 3. `get-process-metrics` (helper, no UI)

- Input: `{ application_id: string, process_id: string, start: string, end: string, interval_in_seconds: number }`
- Fetches 5 endpoints in parallel:
  - `GET /applications/{id}/processes/{pid}/metrics/cpu-usage`
  - `GET /applications/{id}/processes/{pid}/metrics/cpu-limit`
  - `GET /applications/{id}/processes/{pid}/metrics/memory-usage`
  - `GET /applications/{id}/processes/{pid}/metrics/memory-limit`
  - `GET /applications/{id}/processes/{pid}/metrics/instance-count`
- Returns combined JSON with all time-series data
- Called by the app UI via `app.callServerTool()`

### Data Flow

1. AI calls `process-analytics` with `application_id`
2. Host preloads `ui://process-analytics/app.html`, renders sandboxed iframe
3. App receives tool result via `app.ontoolresult` (gets application_id)
4. App calls `list-processes` → renders process dropdown
5. App calls `get-process-metrics` with selected process + time range → renders charts
6. User switches process or time range → app calls `get-process-metrics` again

### UI Design

Matches the Sevalla frontend's chart style:

- **Top bar:** Process dropdown + time range preset buttons (1h, 6h, 24h, 7d)
- **Charts:** 3 area charts in a responsive grid
  - **CPU usage:** `AreaChart` with usage area (`fillOpacity: 0.1`, `--chart-1` color) + dashed limit line (`--color-failed`). Y-axis formatted as `%`. Values multiplied by 100 from raw API data.
  - **Memory usage:** Same visual pattern. Y-axis formatted with human-readable bytes (KB/MB/GB).
  - **Instance count:** `type="step"` area chart. Y-axis as integers. No limit line.
- **Interactions:** Hover tooltips (`indicator="dot"`, formatted timestamp), crosshair cursor
- **Colors:** OKLCH variables matching Sevalla palette. Respects `prefers-color-scheme` for dark mode.
- **Chart config:** `CartesianGrid vertical={false}`, `strokeWidth: 1`, time-based X-axis with auto-formatted labels

### Time Range Presets

Matching the Sevalla frontend config:

| Label | Key | Interval |
|-------|-----|----------|
| Last 1 hour | 1h | 60s |
| Last 6 hours | 6h | 60s |
| Last 24 hours | 24h | 600s |
| Last 7 days | 7d | 1800s |

### Build

- Vite + `vite-plugin-singlefile` bundles each app into one self-contained HTML file
- Bundled HTML served as `ui://` resource (read from `dist/` at runtime)
- New deps: `@modelcontextprotocol/ext-apps`, `react`, `react-dom`, `recharts`, `date-fns`, `vite`, `vite-plugin-singlefile`
- New scripts: `pnpm build:app` (builds all apps), `pnpm dev:app` (Vite dev server for UI iteration)

### Auth Flow

The helper tools (`list-processes`, `get-process-metrics`) use the same `createAuthenticatedFetch(token)` pattern as existing CodeMode tools. The user's Bearer token from the MCP request is bound to each tool handler at request time.

### Integration with Existing Server

The `src/apps/process-analytics/tools.ts` exports a function that takes `token` and returns tool + resource registrations. `src/index.ts` calls this alongside the existing CodeMode tool registration in `createMcpServer()`.
