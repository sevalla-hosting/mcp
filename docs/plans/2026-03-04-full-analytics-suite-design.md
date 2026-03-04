# Full Analytics Chart Suite — Design

## Overview

Extend the MCP Apps with three new analytics apps: App Analytics (HTTP metrics), Database Analytics (CPU/memory/storage), and Static Site Analytics (HTTP metrics). Reuse shared chart components across apps that share the same chart types.

## New Apps

### 1. App Analytics (`src/apps/app-analytics/`)

Shows HTTP-level metrics for applications. The AI passes `application_id`.

**Charts:**
- Requests per minute — AreaChart, Y-axis as "rpm"
- Response time — LineChart, 4 lines (avg, p90, p95, p99), Y-axis as "ms", step type
- Status codes — stacked BarChart, 5 categories (1xx-5xx), color-coded
- Top countries — table with country name, request count, avg response time
- Top paths — table with path + request count
- Slowest requests — table with method, path, avg response time, request count

**API endpoints used:**
- `GET /applications/{id}/metrics/requests-per-minute`
- `GET /applications/{id}/metrics/response-time` (called 4x with percent=0, 90, 95, 99)
- `GET /applications/{id}/metrics/response-time-avg`
- `GET /applications/{id}/metrics/status-codes`
- `GET /applications/{id}/metrics/top-countries?limit=10`
- `GET /applications/{id}/metrics/top-pages?limit=10`
- `GET /applications/{id}/metrics/slowest-requests?limit=10`

**MCP tools:**
- `app-analytics` (main tool with UI, `_meta.ui.resourceUri`)
- `get-app-metrics` (helper — fetches all HTTP metrics in parallel)

### 2. Database Analytics (`src/apps/database-analytics/`)

Shows resource usage for databases. The AI passes `database_id`.

**Charts:**
- CPU usage — AreaChart with usage + dashed limit line, Y-axis as "%"
- Memory usage — AreaChart with usage + dashed limit line, Y-axis as bytes
- Storage usage — AreaChart with usage + dashed limit line, Y-axis as bytes

**API endpoints used:**
- `GET /databases/{id}/metrics/cpu-usage`
- `GET /databases/{id}/metrics/cpu-limit`
- `GET /databases/{id}/metrics/memory-usage`
- `GET /databases/{id}/metrics/memory-limit`
- `GET /databases/{id}/metrics/storage-usage`
- `GET /databases/{id}/metrics/storage-limit`

**MCP tools:**
- `database-analytics` (main tool with UI)
- `get-database-metrics` (helper — fetches all 6 endpoints in parallel)

### 3. Static Site Analytics (`src/apps/static-site-analytics/`)

Same HTTP metrics as App Analytics but for static sites. The AI passes `static_site_id`.

**Charts:** Same as App Analytics (reuses shared components).

**API endpoints used:**
- Same pattern as App Analytics but under `/static-sites/{id}/metrics/*`

**MCP tools:**
- `static-site-analytics` (main tool with UI)
- `get-static-site-metrics` (helper — fetches all metrics in parallel)

## Shared Components

Since App Analytics and Static Site Analytics have identical chart types, we build reusable components in `src/shared/components/`:

| Component | Chart Type | Data Format |
|-----------|-----------|-------------|
| `RequestsPerMinuteChart.tsx` | AreaChart | `{ time, value }[]` |
| `ResponseTimeChart.tsx` | LineChart (step) | `{ time, avg, p90, p95, p99 }[]` |
| `StatusCodesChart.tsx` | Stacked BarChart | `{ time, 1xx, 2xx, 3xx, 4xx, 5xx }[]` |
| `TopCountriesTable.tsx` | Table | `{ country, total, response_time }[]` |
| `TopPathsTable.tsx` | Table | `{ page, total }[]` |
| `SlowestRequestsTable.tsx` | Table | `{ method, path, avg_time, count }[]` |

Database Analytics reuses the existing `CpuChart` and `MemoryChart` patterns from process-analytics, plus a new `StorageChart`.

## File Structure

```
src/apps/
  process-analytics/          # already built
  app-analytics/
    tools.ts                  # registerAppTool + get-app-metrics helper
    index.html
    src/
      main.tsx
      App.tsx                 # time range picker + chart grid (no process picker)
  database-analytics/
    tools.ts                  # registerAppTool + get-database-metrics helper
    index.html
    src/
      main.tsx
      App.tsx                 # time range picker + 3 charts
      charts/
        StorageChart.tsx      # new: storage with limit
  static-site-analytics/
    tools.ts                  # registerAppTool + get-static-site-metrics helper
    index.html
    src/
      main.tsx
      App.tsx                 # time range picker + chart grid (same layout as app-analytics)
src/shared/
  components/
    RequestsPerMinuteChart.tsx
    ResponseTimeChart.tsx
    StatusCodesChart.tsx
    TopCountriesTable.tsx
    TopPathsTable.tsx
    SlowestRequestsTable.tsx
  lib/
    timeframes.ts             # already built
    formatters.ts             # already built — add formatCount() for "1.2k" abbreviation
```

## Build Changes

Update `package.json` scripts to build all apps:
```json
"build:app": "cross-env INPUT=src/apps/process-analytics/index.html vite build && cross-env INPUT=src/apps/app-analytics/index.html vite build && cross-env INPUT=src/apps/database-analytics/index.html vite build && cross-env INPUT=src/apps/static-site-analytics/index.html vite build"
```

Each app gets its own `ui://` resource URI and bundled HTML in `dist/`.

## Integration

`src/index.ts` imports and calls all four `register*App` functions in `createMcpServer()`:
```
registerProcessAnalyticsApp(server, fetch)
registerAppAnalyticsApp(server, fetch)
registerDatabaseAnalyticsApp(server, fetch)
registerStaticSiteAnalyticsApp(server, fetch)
```
