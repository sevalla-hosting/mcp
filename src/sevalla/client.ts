export const DEFAULT_API_URL = 'https://api.sevalla.com'
export const API_PREFIX = '/v3'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024

export const RESPONSE_TOO_LARGE = 'response_too_large'

export const getApiBaseUrl = () => process.env.SEVALLA_API_URL || DEFAULT_API_URL

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type QueryValue = string | number | boolean | undefined | null

export type Query = Record<string, QueryValue>

export interface RequestOptions {
  query?: Query
  body?: unknown
  signal?: AbortSignal
}

export class ApiError extends Error {
  status: number
  code?: string
  detail?: string
  retryAfter?: string

  constructor(status: number, message: string, code?: string, detail?: string, retryAfter?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
    this.retryAfter = retryAfter
  }
}

export interface SevallaClient {
  request: <T = unknown>(_method: HttpMethod, _path: string, _options?: RequestOptions) => Promise<T>
  get: <T = unknown>(_path: string, _query?: Query) => Promise<T>
  post: <T = unknown>(_path: string, _body?: unknown) => Promise<T>
  put: <T = unknown>(_path: string, _body?: unknown) => Promise<T>
  patch: <T = unknown>(_path: string, _body?: unknown) => Promise<T>
  delete: <T = unknown>(_path: string) => Promise<T>
}

export type ReadOnlyClient = Pick<SevallaClient, 'get'>

export interface ClientOptions {
  token: string
  baseUrl?: string
  timeoutMs?: number
  maxResponseBytes?: number
}

export const encodePath = (strings: TemplateStringsArray, ...values: string[]): string =>
  strings.reduce((path, part, i) => path + part + (i < values.length ? encodeURIComponent(values[i] ?? '') : ''), '')

const readBodyWithLimit = async (response: Response, maxBytes: number): Promise<string> => {
  if (!response.body) {
    return ''
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new ApiError(
          502,
          `The Sevalla API response exceeded the ${Math.round(maxBytes / 1024 / 1024)} MB limit`,
          RESPONSE_TOO_LARGE,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

const parseBody = (text: string): unknown => {
  if (text.length === 0) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const toApiError = (status: number, body: unknown, retryAfter: string | null): ApiError => {
  if (body && typeof body === 'object') {
    const record = body as { message?: unknown; data?: { code?: unknown; message?: unknown } }
    const message = typeof record.message === 'string' && record.message.length > 0 ? record.message : `HTTP ${status}`
    const code = typeof record.data?.code === 'string' ? record.data.code : undefined
    const detail = typeof record.data?.message === 'string' ? record.data.message : undefined
    return new ApiError(status, message, code, detail, retryAfter ?? undefined)
  }
  const text = typeof body === 'string' && body.length > 0 ? body.slice(0, 300) : `HTTP ${status}`
  return new ApiError(status, text, undefined, undefined, retryAfter ?? undefined)
}

export const buildUrl = (baseUrl: string, path: string, query?: Query): URL => {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    throw new Error(`Invalid API path: ${path}`)
  }
  const url = new URL(`${API_PREFIX}${path}`, baseUrl)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

export const createSevallaClient = (options: ClientOptions): SevallaClient => {
  const baseUrl = options.baseUrl ?? getApiBaseUrl()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES

  const request = async <T = unknown>(method: HttpMethod, path: string, init: RequestOptions = {}): Promise<T> => {
    const url = buildUrl(baseUrl, path, init.query)
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      accept: 'application/json',
    }
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json'
    }
    const signals = [AbortSignal.timeout(timeoutMs), init.signal].filter((s): s is AbortSignal => s !== undefined)
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.any(signals),
        redirect: 'error',
      })
    } catch (err) {
      if (init.signal?.aborted) {
        throw new ApiError(499, 'The request was cancelled')
      }
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new ApiError(504, `The Sevalla API did not respond within ${Math.round(timeoutMs / 1000)} seconds`)
      }
      throw new ApiError(502, `Could not reach the Sevalla API: ${err instanceof Error ? err.message : String(err)}`)
    }
    const body = parseBody(await readBodyWithLimit(response, maxResponseBytes))
    if (!response.ok) {
      throw toApiError(response.status, body, response.headers.get('retry-after'))
    }
    return body as T
  }

  return bindMethods(request)
}

const bindMethods = (request: SevallaClient['request']): SevallaClient => ({
  request,
  get: (path, query) => request('GET', path, { query }),
  post: (path, body) => request('POST', path, { body: body ?? {} }),
  put: (path, body) => request('PUT', path, { body: body ?? {} }),
  patch: (path, body) => request('PATCH', path, { body: body ?? {} }),
  delete: (path) => request('DELETE', path),
})

export const withSignal = (client: SevallaClient, signal?: AbortSignal): SevallaClient =>
  signal
    ? bindMethods((method, path, options = {}) =>
        client.request(method, path, { ...options, signal: options.signal ?? signal }),
      )
    : client

export const readOnly = (client: SevallaClient): ReadOnlyClient => ({ get: client.get })
