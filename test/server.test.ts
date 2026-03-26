import { describe, it, mock } from 'node:test'
import { strictEqual } from 'node:assert'
import { createAuthenticatedFetch, normalizeApiPath, prependApiPrefix } from '../src/api.ts'

describe('normalizeApiPath', () => {
  it('keeps versionless paths unchanged', () => {
    strictEqual(normalizeApiPath('/applications'), '/applications')
  })

  it('strips a leading version prefix', () => {
    strictEqual(normalizeApiPath('/v1/applications'), '/applications')
    strictEqual(normalizeApiPath('/v3/applications'), '/applications')
  })
})

describe('prependApiPrefix', () => {
  it('adds /v3 to versionless paths', () => {
    strictEqual(prependApiPrefix('/applications'), '/v3/applications')
  })

  it('normalizes versioned paths before prefixing', () => {
    strictEqual(prependApiPrefix('/v1/applications'), '/v3/applications')
    strictEqual(prependApiPrefix('/v3/applications'), '/v3/applications')
  })
})

describe('createAuthenticatedFetch', () => {
  it('rewrites versioned URLs without double-prefixing and preserves query parameters', async () => {
    const fetchMock = mock.fn(
      async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
        new Response('{}', { headers: { 'content-type': 'application/json' } }),
    )
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as typeof fetch

    try {
      const authenticatedFetch = createAuthenticatedFetch('test-token')
      await authenticatedFetch('https://api.sevalla.com/v1/applications?page=1&limit=25')

      strictEqual(fetchMock.mock.calls.length, 1)
      const call = fetchMock.mock.calls[0]
      if (!call) {
        throw new Error('Expected fetch to be called')
      }
      const [url, init] = call.arguments as [string, RequestInit | undefined]
      strictEqual(url, 'https://api.sevalla.com/v3/applications?page=1&limit=25')

      const headers = new Headers(init?.headers)
      strictEqual(headers.get('authorization'), 'Bearer test-token')
      strictEqual(headers.get('content-type'), 'application/json')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
