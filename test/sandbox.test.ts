import { describe, it } from 'node:test'
import { deepStrictEqual, strictEqual } from 'node:assert'
import {
  resolveRefs,
  processSpec,
  extractTags,
  createRequestBridge,
  executeInSandbox,
  createTools,
} from '../src/sandbox/index.ts'

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
  it('extracts operations without prepending the server base path', () => {
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
    strictEqual(result.paths['/items'] !== undefined, true)
    strictEqual(result.paths['/items'].get.summary, 'List items')
    strictEqual(result.paths['/items'].post.summary, 'Create item')
    strictEqual(result.paths['/v3/items'], undefined)
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

  it('rejects positional arguments with an actionable message', async () => {
    const bridge = createRequestBridge(mockHandler, 'https://api.example.com')
    try {
      await bridge('GET' as any)
      throw new Error('should have thrown')
    } catch (e: any) {
      strictEqual(e.message.includes('options object'), true)
      strictEqual(e.message.includes('Positional arguments'), true)
    }
  })

  it('rejects null request', async () => {
    const bridge = createRequestBridge(mockHandler, 'https://api.example.com')
    try {
      await bridge(null as any)
      throw new Error('should have thrown')
    } catch (e: any) {
      strictEqual(e.message.includes('options object'), true)
    }
  })

  it('rejects missing method', async () => {
    const bridge = createRequestBridge(mockHandler, 'https://api.example.com')
    try {
      await bridge({ path: '/items' } as any)
      throw new Error('should have thrown')
    } catch (e: any) {
      strictEqual(e.message.includes('options.method'), true)
    }
  })

  it('rejects missing path', async () => {
    const bridge = createRequestBridge(mockHandler, 'https://api.example.com')
    try {
      await bridge({ method: 'GET' } as any)
      throw new Error('should have thrown')
    } catch (e: any) {
      strictEqual(e.message.includes('options.path'), true)
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

describe('executeInSandbox', () => {
  it('executes simple code and returns result', async () => {
    const result = await executeInSandbox('async () => 42', {})
    deepStrictEqual(result, { result: 42 })
  })

  it('injects plain data globals', async () => {
    const result = await executeInSandbox('async () => data.value', { data: { value: 'hello' } })
    deepStrictEqual(result, { result: 'hello' })
  })

  it('injects function globals', async () => {
    const result = await executeInSandbox('async () => await add(2, 3)', {
      add: (a: number, b: number) => a + b,
    })
    deepStrictEqual(result, { result: 5 })
  })

  it('injects namespace objects with methods', async () => {
    const result = await executeInSandbox('async () => await api.greet("world")', {
      api: { greet: (name: string) => `hello ${name}` },
    })
    deepStrictEqual(result, { result: 'hello world' })
  })

  it('returns error for invalid code', async () => {
    const result = await executeInSandbox('async () => { throw new Error("boom") }', {})
    strictEqual(result.error, 'boom')
    strictEqual(result.result, undefined)
  })

  it('returns error when a host function throws synchronously', async () => {
    const result = await executeInSandbox('async () => await api.boom()', {
      api: {
        boom: () => {
          throw new Error('sync boom')
        },
      },
    })
    strictEqual(result.error, 'sync boom')
    strictEqual(result.result, undefined)
  })

  it('returns error when a host function rejects asynchronously', async () => {
    const result = await executeInSandbox('async () => await api.boom()', {
      api: {
        boom: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1))
          throw new Error('async boom')
        },
      },
    })
    strictEqual(result.error, 'async boom')
  })

  it('lets sandbox code catch host function errors', async () => {
    const result = await executeInSandbox(
      'async () => { try { await api.boom() } catch (e) { return `caught: ${e.message}` } }',
      {
        api: {
          boom: () => {
            throw new Error('sync boom')
          },
        },
      },
    )
    deepStrictEqual(result, { result: 'caught: sync boom' })
  })

  it('enforces CPU timeout', async () => {
    const result = await executeInSandbox('async () => { while(true) {} }', {}, { timeoutMs: 100, wallTimeMs: 500 })
    strictEqual(typeof result.error, 'string')
  })

  it('has no access to process or require', async () => {
    const result = await executeInSandbox(
      'async () => typeof process === "undefined" && typeof require === "undefined"',
      {},
    )
    deepStrictEqual(result, { result: true })
  })
})

describe('createTools', () => {
  const mockSpec = {
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/items': {
        get: { summary: 'List items', tags: ['items'] },
        post: { summary: 'Create item', tags: ['items'], requestBody: { required: true } },
      },
      '/users': {
        get: { summary: 'List users', tags: ['users'] },
      },
    },
    components: {},
  }

  it('returns two tool definitions (search and execute)', () => {
    const tools = createTools({
      spec: mockSpec,
      request: async () => new Response('{}'),
      baseUrl: 'https://api.example.com',
      namespace: 'myapi',
    })
    strictEqual(tools.definitions.length, 2)
    strictEqual(tools.definitions[0].name, 'search')
    strictEqual(tools.definitions[1].name, 'execute')
  })

  it('search tool description includes tags and endpoint count', () => {
    const tools = createTools({
      spec: mockSpec,
      request: async () => new Response('{}'),
      baseUrl: 'https://api.example.com',
      namespace: 'myapi',
    })
    const searchDesc = tools.definitions[0].description
    strictEqual(searchDesc.includes('items'), true)
    strictEqual(searchDesc.includes('users'), true)
    strictEqual(searchDesc.includes('Endpoints: 2'), true)
  })

  it('execute tool description includes namespace', () => {
    const tools = createTools({
      spec: mockSpec,
      request: async () => new Response('{}'),
      baseUrl: 'https://api.example.com',
      namespace: 'myapi',
    })
    const execDesc = tools.definitions[1].description
    strictEqual(execDesc.includes('myapi'), true)
    strictEqual(execDesc.includes('path: "/items"'), true)
    strictEqual(execDesc.includes('/v1/items'), false)
  })

  it('search tool handler executes code against processed spec', async () => {
    const tools = createTools({
      spec: mockSpec,
      request: async () => new Response('{}'),
      baseUrl: 'https://api.example.com',
      namespace: 'myapi',
    })
    const result = await tools.definitions[0].handler({
      code: 'async () => Object.keys(spec.paths).length',
    })
    strictEqual(result.content[0].text, '2')
  })

  it('search tool exposes execute-ready paths', async () => {
    const tools = createTools({
      spec: mockSpec,
      request: async () => new Response('{}'),
      baseUrl: 'https://api.example.com',
      namespace: 'myapi',
    })
    const result = await tools.definitions[0].handler({
      code: 'async () => Object.keys(spec.paths)',
    })
    deepStrictEqual(JSON.parse(result.content[0].text), ['/items', '/users'])
  })

  it('execute tool returns a tool error for positional request arguments instead of crashing', async () => {
    const tools = createTools({
      spec: mockSpec,
      request: async () => new Response('{}'),
      baseUrl: 'https://api.example.com',
      namespace: 'myapi',
    })
    const result = await tools.definitions[1].handler({
      code: `async () => myapi.request('GET', '/items')`,
    })
    strictEqual(result.isError, true)
    strictEqual(result.content[0].text.includes('options object'), true)
  })

  it('execute tool returns a tool error for invalid method instead of crashing', async () => {
    const tools = createTools({
      spec: mockSpec,
      request: async () => new Response('{}'),
      baseUrl: 'https://api.example.com',
      namespace: 'myapi',
    })
    const result = await tools.definitions[1].handler({
      code: `async () => myapi.request({ method: 'TRACE', path: '/items' })`,
    })
    strictEqual(result.isError, true)
    strictEqual(result.content[0].text.includes('not allowed'), true)
  })

  it('inputSchema is a Zod schema with code property', () => {
    const tools = createTools({
      spec: mockSpec,
      request: async () => new Response('{}'),
      baseUrl: 'https://api.example.com',
      namespace: 'myapi',
    })
    const schema = tools.definitions[0].inputSchema
    strictEqual(typeof schema.parse, 'function')
    const result = schema.parse({ code: 'async () => 42' })
    deepStrictEqual(result, { code: 'async () => 42' })
  })
})
