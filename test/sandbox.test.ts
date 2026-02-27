import { describe, it } from 'node:test'
import { deepStrictEqual, strictEqual } from 'node:assert'
import { resolveRefs, processSpec, extractTags, createRequestBridge } from '../src/sandbox.ts'

describe('resolveRefs', () => {
  it('resolves a simple $ref', () => {
    const spec = {
      paths: { '/a': { $ref: '#/components/schemas/A' } },
      components: { schemas: { A: { type: 'string' } } },
    }
    const result = resolveRefs(spec.paths, spec)
    deepStrictEqual(result, { '/a': { type: 'string' } })
  })

  it('detects circular references', () => {
    const spec = {
      paths: { '/a': { $ref: '#/components/schemas/A' } },
      components: { schemas: { A: { self: { $ref: '#/components/schemas/A' } } } },
    }
    const result = resolveRefs(spec.paths, spec)
    deepStrictEqual(result['/a'].self, { $circular: '#/components/schemas/A' })
  })

  it('blocks dangerous keys in ref paths', () => {
    const spec = {
      paths: { '/a': { $ref: '#/__proto__/bad' } },
      __proto__: { bad: { type: 'object' } },
    }
    const result = resolveRefs(spec.paths, spec)
    strictEqual(result['/a'].$error, 'unsafe ref path')
  })

  it('respects max depth', () => {
    const spec = {
      paths: { '/a': { $ref: '#/components/schemas/A' } },
      components: { schemas: { A: { nested: { $ref: '#/components/schemas/A' } } } },
    }
    const result = resolveRefs(spec.paths, spec, new Set(), 1)
    strictEqual(result['/a'].nested.$reason, 'max depth exceeded')
  })
})

describe('processSpec', () => {
  it('extracts operations with server base path prepended', () => {
    const spec = {
      servers: [{ url: 'https://api.example.com/v3' }],
      paths: {
        '/items': {
          get: { summary: 'List items', tags: ['items'], description: 'Gets all items' },
          post: { summary: 'Create item', tags: ['items'], requestBody: { required: true } },
        },
      },
      components: {},
    }
    const result = processSpec(spec)
    strictEqual(result.paths['/v3/items'] !== undefined, true)
    strictEqual(result.paths['/v3/items'].get.summary, 'List items')
    strictEqual(result.paths['/v3/items'].post.summary, 'Create item')
    strictEqual(result.paths['/items'], undefined)
  })

  it('drops fields not in the extraction list', () => {
    const spec = {
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/items': {
          get: { summary: 'List', operationId: 'listItems', deprecated: true, security: [] },
        },
      },
      components: {},
    }
    const result = processSpec(spec)
    strictEqual(result.paths['/items'].get.summary, 'List')
    strictEqual(result.paths['/items'].get.operationId, undefined)
    strictEqual(result.paths['/items'].get.deprecated, undefined)
  })
})

describe('extractTags', () => {
  it('returns tags sorted by frequency', () => {
    const spec = {
      paths: {
        '/a': { get: { tags: ['common', 'rare'] }, post: { tags: ['common'] } },
        '/b': { get: { tags: ['medium'] }, put: { tags: ['medium', 'common'] } },
      },
    }
    const tags = extractTags(spec)
    deepStrictEqual(tags, ['common', 'medium', 'rare'])
  })

  it('returns empty array when no tags', () => {
    const spec = { paths: { '/a': { get: { summary: 'no tags' } } } }
    deepStrictEqual(extractTags(spec), [])
  })
})

describe('createRequestBridge', () => {
  const mockHandler = async (url: string, init?: RequestInit): Promise<Response> => {
    return new Response(JSON.stringify({ url, method: init?.method }), {
      headers: { 'content-type': 'application/json' },
    })
  }

  it('builds URL from base and path', async () => {
    const bridge = createRequestBridge(mockHandler, 'https://api.example.com')
    const res = await bridge({ method: 'GET', path: '/items' })
    strictEqual(res.body.url, 'https://api.example.com/items')
  })

  it('appends query parameters', async () => {
    const bridge = createRequestBridge(mockHandler, 'https://api.example.com')
    const res = await bridge({ method: 'GET', path: '/items', query: { page: 1, limit: 25 } })
    strictEqual(res.body.url, 'https://api.example.com/items?page=1&limit=25')
  })

  it('rejects invalid HTTP methods', async () => {
    const bridge = createRequestBridge(mockHandler, 'https://api.example.com')
    try {
      await bridge({ method: 'TRACE' as any, path: '/items' })
      throw new Error('should have thrown')
    } catch (e: any) {
      strictEqual(e.message.includes('not allowed'), true)
    }
  })

  it('rejects paths with protocol', async () => {
    const bridge = createRequestBridge(mockHandler, 'https://api.example.com')
    try {
      await bridge({ method: 'GET', path: 'https://evil.com/items' })
      throw new Error('should have thrown')
    } catch (e: any) {
      strictEqual(e.message.includes('Invalid path'), true)
    }
  })

  it('rejects paths starting with //', async () => {
    const bridge = createRequestBridge(mockHandler, 'https://api.example.com')
    try {
      await bridge({ method: 'GET', path: '//evil.com' })
      throw new Error('should have thrown')
    } catch (e: any) {
      strictEqual(e.message.includes('Invalid path'), true)
    }
  })

  it('enforces request count limit', async () => {
    const bridge = createRequestBridge(mockHandler, 'https://api.example.com', { maxRequests: 2 })
    await bridge({ method: 'GET', path: '/a' })
    await bridge({ method: 'GET', path: '/b' })
    try {
      await bridge({ method: 'GET', path: '/c' })
      throw new Error('should have thrown')
    } catch (e: any) {
      strictEqual(e.message.includes('limit'), true)
    }
  })

  it('filters blocked headers', async () => {
    const handler = async (_url: string, init?: RequestInit): Promise<Response> => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      return new Response(JSON.stringify({ headers }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    const bridge = createRequestBridge(handler, 'https://api.example.com')
    const res = await bridge({
      method: 'GET',
      path: '/items',
      headers: { Authorization: 'Bearer secret', 'X-Custom': 'ok', Cookie: 'bad' },
    })
    strictEqual(res.body.headers['authorization'], undefined)
    strictEqual(res.body.headers['cookie'], undefined)
    strictEqual(res.body.headers['x-custom'], 'ok')
  })
})
