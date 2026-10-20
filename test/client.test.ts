import { after, before, describe, it } from 'node:test'
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  ApiError,
  buildUrl,
  createSevallaClient,
  encodePath,
  mcpClientName,
  readOnly,
  withSignal,
} from '../src/sevalla/client.ts'
import { startFakeApi, TOKENS, type FakeApi } from './support/fake-api.ts'

let api: FakeApi
let slow: Server
let slowUrl: string

before(async () => {
  api = await startFakeApi()
  slow = createServer((req, res) => {
    if (req.url?.startsWith('/v3/big')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ blob: 'x'.repeat(4096) }))
      return
    }
    if (req.url?.startsWith('/v3/text-error')) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('Bad gateway from proxy')
      return
    }
  })
  await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
  slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`
})

after(async () => {
  await api.close()
  slow.closeAllConnections()
  await new Promise<void>((resolve) => slow.close(() => resolve()))
})

describe('buildUrl', () => {
  it('pins requests to the /v3 prefix of the configured host and drops empty query values', () => {
    const url = buildUrl('https://api.sevalla.com', '/applications', {
      limit: 5,
      search: undefined,
      flag: false,
      empty: null,
    })
    strictEqual(url.toString(), 'https://api.sevalla.com/v3/applications?limit=5&flag=false')
  })

  it('rejects paths that could leave the API host', () => {
    throws(() => buildUrl('https://api.sevalla.com', '//evil.example.com/x'))
    throws(() => buildUrl('https://api.sevalla.com', 'https://evil.example.com/x'))
    throws(() => buildUrl('https://api.sevalla.com', 'applications'))
  })
})

describe('encodePath', () => {
  it('encodes interpolated values', () => {
    strictEqual(encodePath`/applications/${'a/b?c'}/env-vars`, '/applications/a%2Fb%3Fc/env-vars')
  })
})

describe('mcpClientName', () => {
  it('prefixes the client with mcp: and keeps it printable ASCII within 200 characters', () => {
    strictEqual(mcpClientName('claude-code/2.1.0'), 'mcp:claude-code/2.1.0')
    strictEqual(mcpClientName(' Cursor/1.7 (darwin)\u00e9\n '), 'mcp:Cursor/1.7 (darwin)')
    strictEqual(mcpClientName(undefined), 'mcp:unknown')
    strictEqual(mcpClientName('\u00e9'), 'mcp:unknown')
    strictEqual(mcpClientName('x'.repeat(300)).length, 200)
  })
})

describe('createSevallaClient', () => {
  it('sends the bearer token and JSON body', async () => {
    const client = createSevallaClient({ token: TOKENS.valid, baseUrl: api.url })
    await client.post('/projects', { display_name: 'Shop' })
    const call = api.requests.at(-1)
    strictEqual(call?.headers.authorization, `Bearer ${TOKENS.valid}`)
    strictEqual(call?.headers['content-type'], 'application/json')
    deepStrictEqual(call?.body, { display_name: 'Shop' })
    strictEqual(call?.headers['x-sevalla-client'], undefined)
  })

  it('names the calling client in x-sevalla-client when one is set', async () => {
    const client = createSevallaClient({ token: TOKENS.valid, baseUrl: api.url, client: 'mcp:claude-code/2.1.0' })
    await client.get('/projects')
    strictEqual(api.requests.at(-1)?.headers['x-sevalla-client'], 'mcp:claude-code/2.1.0')
  })

  it('turns API errors into ApiError with code and message', async () => {
    const client = createSevallaClient({ token: 'svl_wrong', baseUrl: api.url })
    await rejects(
      () => client.get('/projects'),
      (err: unknown) =>
        err instanceof ApiError && err.status === 401 && err.message === 'Unauthorized' && err.code === 'err-401',
    )
  })

  it('keeps plain-text error bodies', async () => {
    const client = createSevallaClient({ token: 't', baseUrl: slowUrl })
    await rejects(
      () => client.get('/text-error'),
      (err: unknown) => err instanceof ApiError && err.status === 502 && err.message === 'Bad gateway from proxy',
    )
  })

  it('stops reading oversized responses', async () => {
    const client = createSevallaClient({ token: 't', baseUrl: slowUrl, maxResponseBytes: 1024 })
    await rejects(
      () => client.get('/big'),
      (err: unknown) => err instanceof ApiError && err.status === 502 && /limit/.test(err.message),
    )
  })

  it('times out slow responses', async () => {
    const client = createSevallaClient({ token: 't', baseUrl: slowUrl, timeoutMs: 100 })
    await rejects(
      () => client.get('/hang'),
      (err: unknown) => err instanceof ApiError && err.status === 504,
    )
  })

  it('reports unreachable hosts', async () => {
    const client = createSevallaClient({ token: 't', baseUrl: 'http://127.0.0.1:9' })
    await rejects(
      () => client.get('/projects'),
      (err: unknown) => err instanceof ApiError && err.status === 502,
    )
  })

  it('cancels in-flight requests when the bound signal aborts', async () => {
    const controller = new AbortController()
    const client = withSignal(
      createSevallaClient({ token: 't', baseUrl: slowUrl, timeoutMs: 10_000 }),
      controller.signal,
    )
    const started = Date.now()
    const pending = client.get('/hang')
    setTimeout(() => controller.abort(), 50)
    await rejects(
      () => pending,
      (err: unknown) => err instanceof ApiError && err.status === 499,
    )
    ok(Date.now() - started < 2_000)
  })

  it('never sends requests whose signal has already aborted', async () => {
    api.reset()
    const client = withSignal(createSevallaClient({ token: TOKENS.valid, baseUrl: api.url }), AbortSignal.abort())
    await rejects(
      () => client.post('/projects', { display_name: 'x' }),
      (err: unknown) => err instanceof ApiError && err.status === 499,
    )
    strictEqual(api.requests.length, 0)
  })

  it('exposes only GET through the read-only view', () => {
    const view = readOnly(createSevallaClient({ token: 't', baseUrl: api.url }))
    deepStrictEqual(Object.keys(view), ['get'])
    ok(typeof view.get === 'function')
  })
})
