import { z } from 'zod'
import { encodePath, type ReadOnlyClient } from '../sevalla/client.ts'
import { readTool, ToolInputError } from './define.ts'
import {
  formatApiErrorShort,
  formatLogLine,
  intervalFor,
  matchesText,
  resolveWindow,
  sortLogs,
  summarizeSeries,
  toolResult,
  type LogEntry,
  type SeriesPoint,
  type TimeWindow,
} from './format.ts'
import { serviceType, timeWindow, uuid, type ApiRecord } from './schemas.ts'

const MAX_CLIENT_SCAN = 1000

export interface LogFilter {
  key: string
  operator: string
  value?: string
  values?: string[]
}

interface LogQuery {
  path: string
  window: TimeWindow
  limit: number
  filters: LogFilter[]
  search?: string
  searchAttributes: boolean
}

const fetchLogs = async (api: ReadOnlyClient, q: LogQuery) => {
  const clientSearch = q.search !== undefined && q.searchAttributes
  const query = {
    from: q.window.from,
    to: q.window.to,
    limit: clientSearch ? MAX_CLIENT_SCAN : q.limit,
    filters: q.filters.length > 0 ? JSON.stringify(q.filters) : undefined,
    search: clientSearch ? undefined : q.search,
  }
  const fetched = sortLogs(await api.get<LogEntry[]>(q.path, query))
  const matching = clientSearch ? fetched.filter((e) => matchesText(e, q.search)) : fetched
  return { fetched, matching, shown: matching.slice(-q.limit), capped: fetched.length >= query.limit }
}

const logHeader = (label: string, window: TimeWindow, shown: number, matching: number, capped: boolean) => {
  const scope = capped
    ? ` The window holds more entries than were scanned; a shorter window or end_time set to the oldest timestamp shown reaches older entries.`
    : ''
  return `${label} from ${window.from} to ${window.to}: the latest ${shown} of ${matching} matching entries, oldest first.${scope}`
}

const SEVERITIES = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const

const REQUEST_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const

export const searchRuntimeLogs = readTool({
  name: 'search_runtime_logs',
  title: 'Search Sevalla runtime logs',
  description:
    'Returns runtime logs (stdout and stderr of running processes) of a Sevalla application: the latest entries of a time window (default last 60 minutes), oldest first, one line each. Build output: get_deployment_logs. HTTP requests: search_access_logs.',
  input: z
    .object({
      application_id: uuid('Application ID (list_services).'),
      ...timeWindow,
      severity: z.enum(SEVERITIES).optional().describe('Only entries with this severity.'),
      search: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Only entries whose message contains this text (case-insensitive).'),
      limit: z.number().int().min(1).max(500).default(100).describe('Maximum entries returned.'),
    })
    .strict(),
  run: async (args, { api }) => {
    const window = resolveWindow(args)
    const result = await fetchLogs(api, {
      path: encodePath`/applications/${args.application_id}/runtime-logs`,
      window,
      limit: args.limit,
      filters: args.severity
        ? [{ key: 'severity', operator: 'IS_IN', values: [args.severity, args.severity.toLowerCase()] }]
        : [],
      search: args.search,
      searchAttributes: false,
    })
    const header = logHeader('Runtime logs', window, result.shown.length, result.matching.length, result.capped)
    return toolResult([header, ...result.shown.map(formatLogLine)].join('\n'))
  },
})

const attribute = (entry: LogEntry, name: string): unknown => entry.attributes?.[name]

const formatAccessLine = (entry: LogEntry): string => {
  const status = attribute(entry, 'edgeResponseStatus')
  const method = attribute(entry, 'clientRequestMethod')
  const path = attribute(entry, 'clientRequestPath')
  if (status === undefined && method === undefined && path === undefined) {
    return formatLogLine(entry)
  }
  const time =
    typeof entry.unix_timestamp === 'number' ? new Date(entry.unix_timestamp / 1000).toISOString() : entry.timestamp
  const extras = ['clientIP', 'clientCountry', 'edgeTimeToFirstByteMs']
    .map((key) => (attribute(entry, key) === undefined ? undefined : `${key}=${String(attribute(entry, key))}`))
    .filter(Boolean)
  return [time, status, method, path, ...extras].filter((part) => part !== undefined && part !== '').join(' ')
}

export const accessLogFilters = (status?: string, method?: string, pathPrefix?: string): LogFilter[] => {
  const filters: LogFilter[] = []
  if (status) {
    const normalized = status.toLowerCase()
    if (!/^[1-5](\d\d|xx)$/.test(normalized)) {
      throw new ToolInputError('status must be a status code such as 404 or a class such as 5xx.')
    }
    const key = 'attributes.edgeResponseStatus'
    if (normalized.endsWith('xx')) {
      const base = Number(normalized[0]) * 100
      filters.push(
        { key, operator: 'GREATER_THAN_OR_EQUALS', value: String(base) },
        { key, operator: 'LESS_THAN_OR_EQUALS', value: String(base + 99) },
      )
    } else {
      filters.push({ key, operator: 'EQUALS', value: normalized })
    }
  }
  if (method) {
    filters.push({ key: 'attributes.clientRequestMethod', operator: 'EQUALS', value: method })
  }
  if (pathPrefix) {
    filters.push({ key: 'attributes.clientRequestPath', operator: 'STARTS_WITH', value: pathPrefix })
  }
  return filters
}

export const searchAccessLogs = readTool({
  name: 'search_access_logs',
  title: 'Search Sevalla access logs',
  description:
    'Returns HTTP access logs of a Sevalla application or static site: the latest requests of a time window (default last 60 minutes), oldest first, with status, method, path and client details. Aggregated traffic and error rates: get_metrics.',
  input: z
    .object({
      service_type: serviceType,
      service_id: uuid('Application or static site ID (list_services).'),
      ...timeWindow,
      status: z.string().optional().describe('Status code (404) or class (5xx).'),
      request_method: z.enum(REQUEST_METHODS).optional().describe('Only requests with this method.'),
      path_prefix: z.string().min(1).max(500).optional().describe('Only paths starting with this text.'),
      search: z.string().min(1).max(200).optional().describe('Only entries containing this text (case-insensitive).'),
      limit: z.number().int().min(1).max(500).default(100).describe('Maximum entries returned.'),
    })
    .strict(),
  run: async (args, { api }) => {
    const window = resolveWindow(args)
    const filters = accessLogFilters(args.status, args.request_method, args.path_prefix)
    const isApplication = args.service_type === 'application'
    const result = await fetchLogs(api, {
      path: isApplication
        ? encodePath`/applications/${args.service_id}/access-logs`
        : encodePath`/static-sites/${args.service_id}/access-logs`,
      window,
      limit: args.limit,
      filters,
      search: args.search,
      searchAttributes: true,
    })
    const header = logHeader('Access logs', window, result.shown.length, result.matching.length, result.capped)
    return toolResult([header, ...result.shown.map(formatAccessLine)].join('\n'))
  },
})

type Target = 'application' | 'static_site' | 'process' | 'database'

interface MetricSpec {
  path: string
  shape: 'series' | 'value' | 'list' | 'status_series' | 'events' | 'average'
  interval?: boolean
  limit?: boolean
  percentile?: boolean
}

const HTTP_METRICS: Record<string, MetricSpec> = {
  requests_per_minute: { path: 'requests-per-minute', shape: 'series', interval: true },
  response_time_ms: { path: 'response-time', shape: 'series', interval: true, percentile: true },
  average_response_time_ms: { path: 'response-time-avg', shape: 'average' },
  status_codes: { path: 'status-codes', shape: 'status_series', interval: true },
  top_status_codes: { path: 'top-status-codes', shape: 'list', limit: true },
  top_countries: { path: 'top-countries', shape: 'list', limit: true },
  slowest_requests: { path: 'slowest-requests', shape: 'list', limit: true },
  top_pages: { path: 'top-pages', shape: 'list', limit: true },
}

const PROCESS_METRICS: Record<string, MetricSpec> = {
  cpu_usage_cores: { path: 'cpu-usage', shape: 'series', interval: true },
  cpu_limit_cores: { path: 'cpu-limit', shape: 'series', interval: true },
  memory_usage_bytes: { path: 'memory-usage', shape: 'series', interval: true },
  memory_limit_bytes: { path: 'memory-limit', shape: 'series', interval: true },
  instance_count: { path: 'instance-count', shape: 'series', interval: true },
  exit_codes: { path: 'exit-codes', shape: 'events' },
}

const DATABASE_METRICS: Record<string, MetricSpec> = {
  cpu_usage_cores: { path: 'cpu-usage', shape: 'series', interval: true },
  cpu_limit_cores: { path: 'cpu-limit', shape: 'series', interval: true },
  memory_usage_bytes: { path: 'memory-usage', shape: 'series', interval: true },
  memory_limit_bytes: { path: 'memory-limit', shape: 'series', interval: true },
  storage_usage_bytes: { path: 'storage-usage', shape: 'series', interval: true },
  storage_limit_bytes: { path: 'storage-limit', shape: 'series', interval: true },
  allocated_storage_bytes: { path: 'all-storage', shape: 'value' },
  used_storage_bytes: { path: 'used-storage', shape: 'value' },
}

const METRICS_BY_TARGET: Record<Target, Record<string, MetricSpec>> = {
  application: HTTP_METRICS,
  static_site: HTTP_METRICS,
  process: PROCESS_METRICS,
  database: DATABASE_METRICS,
}

const DEFAULT_METRICS: Record<Target, string[]> = {
  application: ['requests_per_minute', 'average_response_time_ms', 'top_status_codes', 'slowest_requests'],
  static_site: ['requests_per_minute', 'average_response_time_ms', 'top_status_codes', 'top_pages'],
  process: ['cpu_usage_cores', 'memory_usage_bytes', 'instance_count', 'exit_codes'],
  database: ['cpu_usage_cores', 'memory_usage_bytes', 'used_storage_bytes', 'allocated_storage_bytes'],
}

const summarizeStatusSeries = (points: { time: string; value: Record<string, number> }[]) => {
  const totals: Record<string, number> = {}
  for (const point of points) {
    for (const [status, count] of Object.entries(point.value ?? {})) {
      totals[status] = (totals[status] ?? 0) + (typeof count === 'number' ? count : 0)
    }
  }
  return { totals_by_status: totals, points: points.length }
}

const shapeMetric = (spec: MetricSpec, data: unknown) => {
  switch (spec.shape) {
    case 'series':
      return summarizeSeries((data as SeriesPoint[]) ?? [])
    case 'status_series':
      return summarizeStatusSeries((data as { time: string; value: Record<string, number> }[]) ?? [])
    case 'average':
      return (data as ApiRecord)?.average_response_time_ms ?? null
    case 'value':
      return (data as ApiRecord)?.value ?? null
    case 'events':
      return ((data as ApiRecord[]) ?? []).slice(-50)
    default:
      return data
  }
}

const metricsBase = (target: Target, args: ApiRecord): string => {
  const need = (field: string) => {
    if (typeof args[field] !== 'string') {
      throw new ToolInputError(`${field} is required when target is ${target}.`)
    }
    return args[field] as string
  }
  switch (target) {
    case 'application':
      return encodePath`/applications/${need('application_id')}/metrics`
    case 'static_site':
      return encodePath`/static-sites/${need('static_site_id')}/metrics`
    case 'process':
      return encodePath`/applications/${need('application_id')}/processes/${need('process_id')}/metrics`
    default:
      return encodePath`/databases/${need('database_id')}/metrics`
  }
}

export const getMetrics = readTool({
  name: 'get_metrics',
  title: 'Get Sevalla metrics',
  description:
    'Returns metrics of a Sevalla application or static site (traffic, response times, status codes, top pages and countries, slowest requests), a process (CPU, memory, instances, exit codes) or a database (CPU, memory, storage), by default for the last 60 minutes. Series are summarized as min, max, avg, last and a downsampled series.',
  input: z
    .object({
      target: z.enum(['application', 'static_site', 'process', 'database']).describe('What to measure.'),
      application_id: uuid('For target application or process.').optional(),
      process_id: uuid('For target process (get_application).').optional(),
      static_site_id: uuid('For target static_site.').optional(),
      database_id: uuid('For target database.').optional(),
      metrics: z
        .array(z.string())
        .min(1)
        .max(10)
        .optional()
        .describe(
          'Default: a standard set. application, static_site: requests_per_minute, response_time_ms, average_response_time_ms, status_codes, top_status_codes, top_countries, slowest_requests, top_pages. process: cpu_usage_cores, cpu_limit_cores, memory_usage_bytes, memory_limit_bytes, instance_count, exit_codes. database: cpu_usage_cores, cpu_limit_cores, memory_usage_bytes, memory_limit_bytes, storage_usage_bytes, storage_limit_bytes, allocated_storage_bytes, used_storage_bytes.',
        ),
      status: z
        .string()
        .optional()
        .describe('application, static_site: only requests with this status code (404) or class (5xx).'),
      request_method: z.enum(REQUEST_METHODS).optional().describe('application, static_site: only this method.'),
      path_prefix: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('application, static_site: only paths starting with this text.'),
      percentile: z.number().int().min(1).max(99).optional().describe('Percentile of response_time_ms, e.g. 95.'),
      ...timeWindow,
    })
    .strict(),
  run: async (args, { api }) => {
    const target = args.target
    const available = METRICS_BY_TARGET[target]
    const names = args.metrics ?? DEFAULT_METRICS[target]
    const invalid = names.filter((name) => !available[name])
    if (invalid.length > 0) {
      throw new ToolInputError(
        `Metrics not available for target ${target}: ${invalid.join(', ')}. Available: ${Object.keys(available).join(', ')}.`,
      )
    }
    const filters = accessLogFilters(args.status, args.request_method, args.path_prefix)
    if (filters.length > 0 && (target === 'process' || target === 'database')) {
      throw new ToolInputError('status, request_method and path_prefix apply to applications and static sites.')
    }
    if (args.percentile !== undefined && !names.includes('response_time_ms')) {
      throw new ToolInputError('percentile applies to the response_time_ms metric, which metrics does not include.')
    }
    const base = metricsBase(target, args)
    const window = resolveWindow(args)
    const interval = intervalFor(window.seconds)
    const entries = await Promise.all(
      names.map(async (name) => {
        const spec = available[name] as MetricSpec
        const query =
          spec.shape === 'value'
            ? {}
            : {
                from: window.from,
                to: window.to,
                interval_in_seconds: spec.interval ? interval : undefined,
                limit: spec.limit ? 10 : undefined,
                filters: filters.length > 0 ? JSON.stringify(filters) : undefined,
                percent: spec.percentile ? args.percentile : undefined,
              }
        try {
          return [name, shapeMetric(spec, await api.get(`${base}/${spec.path}`, query))] as const
        } catch (err) {
          return [name, { error: formatApiErrorShort(err) }] as const
        }
      }),
    )
    return toolResult({
      target,
      window: { from: window.from, to: window.to, interval_seconds: interval },
      metrics: Object.fromEntries(entries),
    })
  },
})

export const OBSERVABILITY_TOOLS = [searchRuntimeLogs, searchAccessLogs, getMetrics]
