const VERSION_PREFIX_PATTERN = /^\/v\d+(?=\/|$)/

export const SEVALLA_API_BASE = 'https://api.sevalla.com'
export const SEVALLA_API_PREFIX = '/v3'
export const SEVALLA_SPEC_URL = `${SEVALLA_API_BASE}${SEVALLA_API_PREFIX}/openapi.json`

export const normalizeApiPath = (path: string): string => {
  const normalized = path.replace(VERSION_PREFIX_PATTERN, '')
  return normalized || '/'
}

export const prependApiPrefix = (path: string): string => {
  return `${SEVALLA_API_PREFIX}${normalizeApiPath(path)}`
}

export const createAuthenticatedFetch = (token: string) => {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url
    const url = new URL(rawUrl)
    url.pathname = prependApiPrefix(url.pathname)

    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('Content-Type', 'application/json')

    return fetch(url.toString(), { ...init, headers })
  }
}
