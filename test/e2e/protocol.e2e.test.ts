import { after, before, describe, it } from 'node:test'
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { TOKENS } from '../support/fake-api.ts'
import { MODERN_PROTOCOL_VERSION, startHarness, type Harness } from '../support/harness.ts'

const PUBLIC_URL = 'https://mcp.sevalla.com'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'raw-e2e', version: '1.0.0' },
}

let h: Harness

before(async () => {
  h = await startHarness()
})

after(async () => {
  await h.close()
})

interface RawResponse {
  status: number
  headers: Headers
  body: any
}

const post = async (payload: unknown, headers: Record<string, string> = {}): Promise<RawResponse> => {
  const res = await fetch(`${h.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKENS.valid}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, headers: res.headers, body }
}

const modern = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post(
    { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { ...ENVELOPE, ...(params._meta as object) } } },
    {
      'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
      'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      ...headers,
    },
  )

const legacy = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post({ jsonrpc: '2.0', id: 1, method, params }, headers)

describe('e2e protocol: 2026-07-28', () => {
  it('negotiates 2026-07-28 and serves the tools', async () => {
    const session = await h.connect({ era: 'modern' })
    strictEqual(session.client.getNegotiatedProtocolVersion(), MODERN_PROTOCOL_VERSION)
    strictEqual(session.client.getProtocolEra(), 'modern')
    strictEqual((await session.client.listTools()).tools.length, 27)
    strictEqual((await session.call('list_services')).isError, false)
  })

  it('answers server/discover with versions, capabilities, instructions and cache hints', async () => {
    const res = await modern('server/discover')
    strictEqual(res.status, 200)
    strictEqual(res.headers.get('content-type'), 'application/json')
    const result = res.body.result
    ok(result.supportedVersions.includes(MODERN_PROTOCOL_VERSION))
    deepStrictEqual(result.capabilities, { tools: { listChanged: false } })
    ok(result.instructions.startsWith('Sevalla is a platform'))
    strictEqual(result.resultType, 'complete')
    strictEqual(result.ttlMs, 3_600_000)
    strictEqual(result.cacheScope, 'public')
  })

  it('marks tools/list as publicly cacheable for an hour', async () => {
    const { result } = (await modern('tools/list')).body
    strictEqual(result.tools.length, 27)
    strictEqual(result.ttlMs, 3_600_000)
    strictEqual(result.cacheScope, 'public')
  })

  it('identifies the server, with same-origin icons, on every result', async () => {
    const { result } = (await modern('tools/call', { name: 'list_services', arguments: {} })).body
    strictEqual(result.resultType, 'complete')
    const info = result._meta[SERVER_INFO_KEY]
    strictEqual(info.name, 'sevalla')
    strictEqual(info.title, 'Sevalla')
    strictEqual(info.websiteUrl, 'https://sevalla.com')
    deepStrictEqual(
      info.icons.map((icon: { mimeType: string }) => icon.mimeType),
      ['image/png', 'image/svg+xml'],
    )
    for (const icon of info.icons) {
      strictEqual(new URL(icon.src).origin, PUBLIC_URL)
    }
  })

  it('returns tool failures as tool results', async () => {
    const { result } = (await modern('tools/call', { name: 'get_application', arguments: { id: 'not-a-uuid' } })).body
    strictEqual(result.isError, true)
    strictEqual(result.resultType, 'complete')
  })

  it('rejects requests whose headers disagree with the body', async () => {
    const res = await modern('tools/call', { name: 'list_services', arguments: {} }, { 'mcp-name': 'get_application' })
    strictEqual(res.status, 400)
    strictEqual(res.body.error.code, -32020)
  })

  it('rejects unsupported protocol versions and names the supported ones', async () => {
    const res = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { ...ENVELOPE, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } },
      },
      { 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'tools/list' },
    )
    strictEqual(res.status, 400)
    strictEqual(res.body.error.code, -32022)
    ok(res.body.error.data.supported.includes(MODERN_PROTOCOL_VERSION))
  })

  it('rejects requests without the required envelope fields', async () => {
    const res = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION } },
      },
      { 'mcp-protocol-version': MODERN_PROTOCOL_VERSION, 'mcp-method': 'tools/list' },
    )
    strictEqual(res.status, 400)
    strictEqual(res.body.error.code, -32602)
  })
})

describe('e2e protocol: 2025-era clients', () => {
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
    it(`negotiates ${version} through initialize with a JSON response and no session`, async () => {
      const res = await legacy('initialize', {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'raw-e2e', version: '1.0.0' },
      })
      strictEqual(res.status, 200)
      strictEqual(res.headers.get('content-type'), 'application/json')
      strictEqual(res.headers.get('mcp-session-id'), null)
      strictEqual(res.body.result.protocolVersion, version)
      strictEqual(res.body.result.serverInfo.name, 'sevalla')
      strictEqual(res.body.result.serverInfo.icons.length, 2)
      deepStrictEqual(res.body.result.capabilities, { tools: { listChanged: false } })
      ok(res.body.result.instructions.startsWith('Sevalla is a platform'))
    })
  }

  it('answers an unknown initialize version with the latest 2025 revision', async () => {
    const res = await legacy('initialize', {
      protocolVersion: '2023-01-01',
      capabilities: {},
      clientInfo: { name: 'raw-e2e', version: '1.0.0' },
    })
    strictEqual(res.body.result.protocolVersion, '2025-11-25')
  })

  it('serves stateless requests without a prior initialize', async () => {
    const res = await legacy('tools/list')
    strictEqual(res.status, 200)
    strictEqual(res.headers.get('content-type'), 'application/json')
    strictEqual(res.body.result.tools.length, 27)
    strictEqual(res.body.result.resultType, undefined)
  })

  it('serves a 2025 client through the SDK', async () => {
    const session = await h.connect({ era: 'legacy' })
    strictEqual(session.client.getNegotiatedProtocolVersion(), '2025-11-25')
    strictEqual(session.client.getProtocolEra(), 'legacy')
    strictEqual((await session.call('list_services')).isError, false)
  })
})

describe('e2e protocol: HTTP surface', () => {
  it('answers GET and DELETE with 405 for authenticated clients', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${h.baseUrl}/mcp`, { method, headers: { authorization: `Bearer ${TOKENS.valid}` } })
      strictEqual(res.status, 405, method)
      strictEqual(res.headers.get('allow'), 'POST')
    }
  })

  it('rejects non-JSON request bodies', async () => {
    const res = await post('tools/list', { 'content-type': 'text/plain' })
    strictEqual(res.status, 415)
  })

  it('lets browser clients send the MCP request headers', async () => {
    const res = await fetch(`${h.baseUrl}/mcp`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://inspector.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,mcp-protocol-version,mcp-method,mcp-name',
      },
    })
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    for (const header of ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name']) {
      ok(allowed.includes(header), header)
    }
  })

  it('serves the PNG and SVG icons', async () => {
    const png = await fetch(`${h.baseUrl}/icon.png`)
    strictEqual(png.status, 200)
    strictEqual(png.headers.get('content-type'), 'image/png')
    strictEqual(png.headers.get('x-content-type-options'), 'nosniff')
    ok(png.headers.get('cache-control')?.includes('max-age='))
    deepStrictEqual([...new Uint8Array(await png.arrayBuffer()).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    const svg = await fetch(`${h.baseUrl}/icon.svg`)
    strictEqual(svg.status, 200)
    strictEqual(svg.headers.get('content-type'), 'image/svg+xml')
    ok(svg.headers.get('content-security-policy')?.includes("default-src 'none'"))
    const text = await svg.text()
    ok(text.startsWith('<svg'))
    ok(!/<script|on\w+=/i.test(text))
  })

  it('serves the favicons the landing page links', async () => {
    const page = await (await fetch(`${h.baseUrl}/`)).text()
    ok(page.includes('href="/favicon.ico"') && page.includes('href="/favicon.svg"'))
    const ico = await fetch(`${h.baseUrl}/favicon.ico`)
    strictEqual(ico.status, 200)
    strictEqual(ico.headers.get('content-type'), 'image/x-icon')
    deepStrictEqual([...new Uint8Array(await ico.arrayBuffer()).subarray(0, 4)], [0, 0, 1, 0])
    const svg = await fetch(`${h.baseUrl}/favicon.svg`)
    strictEqual(svg.status, 200)
    strictEqual(svg.headers.get('content-type'), 'image/svg+xml')
    ok(svg.headers.get('content-security-policy')?.includes("default-src 'none'"))
    ok((await svg.text()).startsWith('<svg'))
  })
})

describe('e2e protocol: stdio', () => {
  const connectStdio = async (era: 'modern' | 'legacy') => {
    const client = new Client(
      { name: 'sevalla-stdio-e2e', version: '1.0.0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } } : {},
    )
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [new URL('../../src/index.ts', import.meta.url).pathname, '--stdio'],
        env: { SEVALLA_API_KEY: TOKENS.valid, SEVALLA_API_URL: h.api.url, PATH: process.env.PATH ?? '' },
        stderr: 'ignore',
      }),
    )
    return client
  }

  for (const era of ['modern', 'legacy'] as const) {
    it(`serves the tools over stdio to ${era} clients`, async () => {
      const client = await connectStdio(era)
      try {
        strictEqual(client.getProtocolEra(), era)
        strictEqual((await client.listTools()).tools.length, 27)
        const result = (await client.callTool({ name: 'list_services', arguments: {} })) as { isError?: boolean }
        strictEqual(result.isError ?? false, false)
      } finally {
        await client.close()
      }
    })
  }
})

describe('e2e protocol: request size limit', () => {
  it('rejects request bodies over 1 MiB', async () => {
    const res = await legacy('tools/call', { name: 'list_services', arguments: { padding: 'x'.repeat(1_100_000) } })
    strictEqual(res.status, 413)
  })
})
