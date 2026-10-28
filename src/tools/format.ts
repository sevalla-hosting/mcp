import { ApiError, RESPONSE_TOO_LARGE } from '../sevalla/client.ts'
import type { ToolResult } from './define.ts'
import { ToolInputError } from './define.ts'

export const MAX_RESULT_CHARS = 30_000
export const MAX_WINDOW_MINUTES = 30 * 24 * 60
export const REDACTED = '[redacted]'

export const truncate = (text: string, max = MAX_RESULT_CHARS): string => {
  if (text.length <= max) {
    return text
  }
  return `${text.slice(0, max)}\n\n[Truncated: showing ${max} of ${text.length} characters. A narrower request (filters, a smaller limit or a shorter time range) returns the rest.]`
}

export const toolResult = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: truncate(typeof data === 'string' ? data : JSON.stringify(data)) }],
})

export const toolError = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
})

export const redact = (value: unknown, fields: Set<string>): unknown => {
  if (fields.size === 0 || value === null || typeof value !== 'object') {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, fields))
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      fields.has(key) && (typeof item === 'string' || typeof item === 'number') ? REDACTED : redact(item, fields),
    ]),
  )
}

export const omitEmpty = <T extends Record<string, unknown>>(record: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0),
    ),
  ) as Partial<T>

export const firstLine = (text: unknown, max = 160): string | undefined => {
  if (typeof text !== 'string' || text.length === 0) {
    return undefined
  }
  const line = text.split('\n')[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const shortSha = (sha: unknown): string | undefined =>
  typeof sha === 'string' && sha.length > 0 ? sha.slice(0, 7) : undefined

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

export const formatApiError = (err: ApiError): string => {
  if (err.code === RESPONSE_TOO_LARGE) {
    return 'The Sevalla API response was larger than this connector reads (5 MB). A narrower request fits: a shorter time window, a smaller limit or more filters.'
  }
  const detail = err.detail && err.detail !== err.message ? ` ${err.detail}` : ''
  switch (err.status) {
    case 400:
    case 422:
      return `The Sevalla API rejected the request: ${sentence(err.message)}${detail}`
    case 401:
      return 'The Sevalla API key for this connection is invalid, expired or revoked. Reconnecting the Sevalla connector issues a new one.'
    case 403:
      return `The Sevalla API refused the request: ${sentence(err.message)}`
    case 404:
      return `Not found: ${sentence(err.message)} The ID may be wrong or belong to another company; list_services returns the IDs this connection can access.`
    case 409:
      return `The request conflicts with the current state of the resource: ${sentence(err.message)}${detail}`
    case 429:
      return `The Sevalla API rate limit was reached${err.retryAfter ? `; it accepts requests again after ${err.retryAfter} seconds` : ''}.`
    default:
      return err.status >= 500
        ? `The Sevalla API failed with status ${err.status}: ${sentence(err.message)} The request may succeed on a later attempt.`
        : `The Sevalla API returned status ${err.status}: ${sentence(err.message)}${detail}`
  }
}

export const formatApiErrorShort = (err: unknown): string =>
  err instanceof ApiError
    ? `Sevalla API error ${err.status}: ${err.message}`
    : err instanceof Error
      ? err.message
      : String(err)

export interface TimeWindowInput {
  since_minutes?: number
  start_time?: string
  end_time?: string
}

export interface TimeWindow {
  from: string
  to: string
  seconds: number
}

const parseTime = (value: string, field: string): Date => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new ToolInputError(`${field} must be an ISO 8601 timestamp such as 2026-01-31T14:00:00Z (got "${value}").`)
  }
  return date
}

export const resolveWindow = (input: TimeWindowInput, defaultMinutes = 60, now = new Date()): TimeWindow => {
  const to = input.end_time ? parseTime(input.end_time, 'end_time') : now
  const from = input.start_time
    ? parseTime(input.start_time, 'start_time')
    : new Date(to.getTime() - (input.since_minutes ?? defaultMinutes) * 60_000)
  const seconds = Math.round((to.getTime() - from.getTime()) / 1000)
  if (seconds <= 0) {
    throw new ToolInputError('start_time must be earlier than end_time.')
  }
  if (seconds > MAX_WINDOW_MINUTES * 60) {
    throw new ToolInputError('The time window can be at most 30 days.')
  }
  return { from: from.toISOString(), to: to.toISOString(), seconds }
}

export const intervalFor = (windowSeconds: number, points = 60): number =>
  Math.max(60, Math.ceil(windowSeconds / points / 60) * 60)

export interface LogEntry {
  message?: string
  severity?: string
  timestamp?: string
  unix_timestamp?: number
  tags?: Record<string, unknown>
  attributes?: Record<string, unknown>
}

const MAX_LOG_MESSAGE = 1_000

const entryTime = (entry: LogEntry): string => {
  if (typeof entry.unix_timestamp === 'number') {
    return new Date(entry.unix_timestamp / 1000).toISOString()
  }
  return entry.timestamp ?? ''
}

export const sortLogs = (entries: LogEntry[]): LogEntry[] =>
  [...entries].sort((a, b) => (a.unix_timestamp ?? 0) - (b.unix_timestamp ?? 0))

export const formatLogLine = (entry: LogEntry): string => {
  const message = (entry.message ?? '').trimEnd()
  const clipped = message.length > MAX_LOG_MESSAGE ? `${message.slice(0, MAX_LOG_MESSAGE)}…` : message
  return [entryTime(entry), (entry.severity ?? '').toUpperCase(), clipped].filter((part) => part.length > 0).join(' ')
}

export const matchesText = (entry: LogEntry, text: string | undefined): boolean => {
  if (!text) {
    return true
  }
  const needle = text.toLowerCase()
  return (
    (entry.message ?? '').toLowerCase().includes(needle) ||
    JSON.stringify(entry.attributes ?? {})
      .toLowerCase()
      .includes(needle)
  )
}

export interface SeriesPoint {
  time: string
  value: number
}

export const summarizeSeries = (points: SeriesPoint[], maxPoints = 24) => {
  const values = points.map((p) => p.value).filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (values.length === 0) {
    return { points: 0 }
  }
  const round = (n: number) => Math.round(n * 1000) / 1000
  const step = Math.max(1, Math.ceil(points.length / maxPoints))
  return {
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    avg: round(values.reduce((sum, v) => sum + v, 0) / values.length),
    last: round(values[values.length - 1] ?? 0),
    series: points.filter((_, i) => i % step === 0).map((p) => [p.time, round(p.value)]),
  }
}
