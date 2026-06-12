import { after, before, describe, it } from 'node:test'
import { ok, strictEqual, deepStrictEqual } from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { app, loadSpec, __setShuttingDown } from '../src/index.ts'
import { signParams } from '../src/oauth.ts'

const FAKE_SPEC = {
  openapi: '3.0.0',
  servers: [{ url: 'https://api.sevalla.com/v3' }],
  paths: {
    '/applications': {
      get: { summary: 'List applications', tags: ['applications'] },
      post: { summary: 'Create application', tags: ['applications'], requestBody: { required: true } },
    },
    '/applications/{id}': {
      get: { summary: 'Get application', tags: ['applications'] },
      delete: { summary: 'Delete application', tags: ['applications'] },
    },
    '/sites': {
      get: { summary: 'List sites', tags: ['sites'] },
    },
  },
  components: {},
}

interface UpstreamCall {
  url: string
  method: string
  authorization: string | null
  body: string | null
}

const sevalla = {
  deviceCode: 'DEVICE_CODE_123',
  deviceStatus: 'approved' as 'approved' | 'pending' | 'denied',
  deviceCreateFails: false,
  devicePollFails: false,
  token: 'svl_real_user_token',
  calls: [] as UpstreamCall[],
}

const applications = [
  { id: 'app_1', name: 'api-server', status: 'running' },
  { id: 'app_2', name: 'worker', status: 'stopped' },
]

let realFetch: typeof globalThis.fetch

const installMock = () => {
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

    if (url.includes('/v3/openapi.json')) {
      return json(FAKE_SPEC)
    }

    if (url.endsWith('/v3/auth/device-codes') && method === 'POST') {
      if (sevalla.deviceCreateFails) {
        return json({ error: 'unavailable' }, 503)
      }
      return json({ code: sevalla.deviceCode })
    }

    if (url.includes('/v3/auth/device-codes/')) {
      if (sevalla.devicePollFails) {
        return json({ error: 'unavailable' }, 503)
      }
      if (sevalla.deviceStatus === 'approved') {
        return json({ status: 'approved', token: sevalla.token })
      }
      return json({ status: sevalla.deviceStatus })
    }

    if (url.includes('/v3/applications')) {
      sevalla.calls.push({
        url,
        method,
        authorization: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      })
      const idMatch = url.match(/\/v3\/applications\/([^/?]+)/)
      if (idMatch) {
        if (method === 'DELETE') {
          return json({ deleted: idMatch[1] })
        }
        return json(applications.find((a) => a.id === idMatch[1]) ?? { error: 'not_found' }, idMatch[1] ? 200 : 404)
      }
      if (method === 'POST') {
        const parsed = init?.body ? JSON.parse(init.body as string) : {}
        return json({ id: 'app_new', name: parsed.name, status: 'deploying' }, 201)
      }
      return json(applications)
    }

    if (url.includes('/v3/sites')) {
      sevalla.calls.push({
        url,
        method,
        authorization: new Headers(init?.headers).get('authorization'),
        body: null,
      })
      return json([{ id: 'site_1', name: 'marketing' }])
    }

    throw new Error(`unexpected upstream fetch: ${method} ${url}`)
  }) as typeof globalThis.fetch
}

const mcpRequest = async (token: string | null, body: unknown) => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token !== null) {
    headers.authorization = `Bearer ${token}`
  }
  const res = await app.request('/mcp', { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status: res.status, headers: res.headers, parsed, text }
}

let rpcId = 0
const rpc = (token: string, method: string, params: unknown) =>
  mcpRequest(token, { jsonrpc: '2.0', id: ++rpcId, method, params })

const callTool = async (token: string, name: string, args: Record<string, unknown>) => {
  const res = await rpc(token, 'tools/call', { name, arguments: args })
  const result = res.parsed?.result
  const textBlock = result?.content?.[0]?.text ?? ''
  let data: any = textBlock
  try {
    data = JSON.parse(textBlock)
  } catch {
    // non-JSON tool output (e.g. a plain number or error string)
  }
  return { status: res.status, isError: result?.isError === true, text: textBlock, data, raw: res.parsed }
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

before(async () => {
  installMock()
  await loadSpec()
})

after(() => {
  globalThis.fetch = realFetch
})

describe('Integration: public + discovery endpoints', () => {
  it('serves the landing page', async () => {
    const res = await app.request('/')
    strictEqual(res.status, 200)
    ok(res.headers.get('content-type')?.includes('text/html'))
    ok((await res.text()).includes('<title>Sevalla MCP</title>'))
  })

  it('reports healthy', async () => {
    const res = await app.request('/health')
    strictEqual(res.status, 200)
    deepStrictEqual(await res.json(), { status: 'ok' })
  })

  it('serves the glama connector manifest', async () => {
    const res = await app.request('/.well-known/glama.json')
    strictEqual(res.status, 200)
    const body = await res.json()
    strictEqual(body.$schema, 'https://glama.ai/mcp/schemas/connector.json')
  })

  it('advertises OAuth protected-resource metadata', async () => {
    const res = await app.request('/.well-known/oauth-protected-resource')
    strictEqual(res.status, 200)
    const body = await res.json()
    ok(body.resource.endsWith('/mcp'))
    ok(Array.isArray(body.authorization_servers))
  })

  it('advertises OAuth authorization-server metadata', async () => {
    const res = await app.request('/.well-known/oauth-authorization-server')
    strictEqual(res.status, 200)
    const body = await res.json()
    ok(body.authorization_endpoint.endsWith('/oauth/authorize'))
    ok(body.token_endpoint.endsWith('/oauth/token'))
    deepStrictEqual(body.code_challenge_methods_supported, ['S256'])
  })
})

describe('Integration: full OAuth login (real-life client + browser approval)', () => {
  const redirectUri = 'http://localhost:8976/callback'

  const register = async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Integration Client', redirect_uris: [redirectUri] }),
    })
    strictEqual(res.status, 201)
    return (await res.json()).client_id as string
  }

  const authorize = async (clientId: string, challenge: string, state: string) => {
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })
    const res = await app.request(`/oauth/authorize?${qs}`, { redirect: 'manual' })
    strictEqual(res.status, 302)
    const sevallaUrl = new URL(res.headers.get('location') ?? '')
    return new URL(sevallaUrl.searchParams.get('callback') ?? '')
  }

  const approveViaCallback = async (callbackUrl: URL) => {
    const res = await app.request(`${callbackUrl.pathname}${callbackUrl.search}`, { redirect: 'manual' })
    strictEqual(res.status, 302)
    return new URL(res.headers.get('location') ?? '')
  }

  const exchange = async (code: string, verifier: string, clientId: string) => {
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })
    return res
  }

  it('completes register → authorize → approve → token and yields a usable token', async () => {
    sevalla.deviceStatus = 'approved'
    const { verifier, challenge } = pkce()
    const clientId = await register()

    const callbackUrl = await authorize(clientId, challenge, 'state-xyz')
    strictEqual(callbackUrl.pathname, `/oauth/callback/${sevalla.deviceCode}`)

    const redirectBack = await approveViaCallback(callbackUrl)
    strictEqual(redirectBack.origin + redirectBack.pathname, redirectUri)
    strictEqual(redirectBack.searchParams.get('state'), 'state-xyz')
    const code = redirectBack.searchParams.get('code') ?? ''
    ok(code.length > 0)

    const tokenRes = await exchange(code, verifier, clientId)
    strictEqual(tokenRes.status, 200)
    const tokenBody = await tokenRes.json()
    strictEqual(tokenBody.access_token, sevalla.token)
    strictEqual(tokenBody.token_type, 'bearer')

    const list = await callTool(tokenBody.access_token, 'execute', {
      code: 'async () => (await sevalla.request({ method: "GET", path: "/applications" })).body',
    })
    strictEqual(list.isError, false)
    deepStrictEqual(list.data, applications)
  })

  it('rejects the exchange when the PKCE verifier does not match', async () => {
    sevalla.deviceStatus = 'approved'
    const { challenge } = pkce()
    const clientId = await register()
    const callbackUrl = await authorize(clientId, challenge, 's')
    const redirectBack = await approveViaCallback(callbackUrl)
    const code = redirectBack.searchParams.get('code') ?? ''

    const tokenRes = await exchange(code, 'wrong-verifier', clientId)
    strictEqual(tokenRes.status, 400)
    strictEqual((await tokenRes.json()).error, 'invalid_grant')
  })

  it('redirects with access_denied when the user rejects the device approval', async () => {
    sevalla.deviceStatus = 'denied'
    const { challenge } = pkce()
    const clientId = await register()
    const callbackUrl = await authorize(clientId, challenge, 'denied-state')
    const redirectBack = await approveViaCallback(callbackUrl)
    strictEqual(redirectBack.searchParams.get('error'), 'access_denied')
    strictEqual(redirectBack.searchParams.get('code'), null)
    sevalla.deviceStatus = 'approved'
  })

  it('returns 502 when Sevalla cannot mint a device code', async () => {
    sevalla.deviceCreateFails = true
    const { challenge } = pkce()
    const clientId = await register()
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
    })
    const res = await app.request(`/oauth/authorize?${qs}`)
    strictEqual(res.status, 502)
    strictEqual((await res.json()).error, 'device_code_request_failed')
    sevalla.deviceCreateFails = false
  })

  it('returns 502 when Sevalla device-code polling fails', async () => {
    sevalla.devicePollFails = true
    const { challenge } = pkce()
    const clientId = await register()
    const callbackUrl = await authorize(clientId, challenge, 's')
    const res = await app.request(`${callbackUrl.pathname}${callbackUrl.search}`)
    strictEqual(res.status, 502)
    strictEqual((await res.json()).error, 'device_code_poll_failed')
    sevalla.devicePollFails = false
  })

  it('rejects an expired (but correctly signed) callback', async () => {
    const clientId = await register()
    const params = {
      redirect_uri: redirectUri,
      code_challenge: 'chal',
      client_id: clientId,
      state: 'st',
      device_code: 'EXPIRED_CODE',
      expires_at: '1000',
    }
    const sig = signParams(params)
    const qs = new URLSearchParams({ ...params, sig }).toString()
    const res = await app.request(`/oauth/callback/EXPIRED_CODE?${qs}`)
    strictEqual(res.status, 400)
    strictEqual((await res.json()).error, 'expired')
  })
})

describe('Integration: OAuth request validation', () => {
  it('rejects authorize with an unparseable redirect_uri', async () => {
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: 'anything',
      redirect_uri: 'http://[not-a-valid-uri',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      state: 's',
    })
    const res = await app.request(`/oauth/authorize?${qs}`)
    strictEqual(res.status, 400)
    strictEqual((await res.json()).error, 'invalid_redirect_uri')
  })

  it('rejects a callback whose path device code does not match the signed one', async () => {
    const params = {
      redirect_uri: 'http://localhost:8976/callback',
      code_challenge: 'chal',
      client_id: 'cid',
      state: 'st',
      device_code: 'SIGNED_CODE',
      expires_at: Number.MAX_SAFE_INTEGER.toString(),
    }
    const sig = signParams(params)
    const qs = new URLSearchParams({ ...params, sig }).toString()
    const res = await app.request(`/oauth/callback/DIFFERENT_CODE?${qs}`)
    strictEqual(res.status, 400)
    strictEqual((await res.json()).error, 'invalid_request')
  })

  it('rejects a token request with an unsupported grant_type', async () => {
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'rt' }).toString(),
    })
    strictEqual(res.status, 400)
    strictEqual((await res.json()).error, 'invalid_request')
  })
})

describe('Integration: MCP protocol handshake', () => {
  const token = 'svl_handshake'

  it('responds to initialize with server capabilities', async () => {
    const res = await rpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'integration', version: '1.0.0' },
    })
    strictEqual(res.status, 200)
    strictEqual(res.parsed.result.serverInfo.name, 'sevalla')
    ok(res.parsed.result.capabilities.tools)
  })

  it('lists exactly the search and execute tools', async () => {
    const res = await rpc(token, 'tools/list', {})
    const names = res.parsed.result.tools.map((t: { name: string }) => t.name).sort()
    deepStrictEqual(names, ['execute', 'search'])
  })
})

describe('Integration: search tool against the live spec', () => {
  const token = 'svl_search'

  it('discovers endpoints by tag', async () => {
    const res = await callTool(token, 'search', {
      code: `async () => {
        const out = []
        for (const [path, methods] of Object.entries(spec.paths)) {
          for (const [method, op] of Object.entries(methods)) {
            if (op.tags?.includes('applications')) out.push(method.toUpperCase() + ' ' + path)
          }
        }
        return out.sort()
      }`,
    })
    strictEqual(res.isError, false)
    deepStrictEqual(res.data, [
      'DELETE /applications/{id}',
      'GET /applications',
      'GET /applications/{id}',
      'POST /applications',
    ])
  })

  it('exposes execute-ready paths', async () => {
    const res = await callTool(token, 'search', { code: 'async () => Object.keys(spec.paths).sort()' })
    deepStrictEqual(res.data, ['/applications', '/applications/{id}', '/sites'])
  })
})

describe('Integration: execute tool drives the Sevalla API', () => {
  const token = 'svl_execute_user'

  it('lists applications and forwards the caller token upstream', async () => {
    sevalla.calls.length = 0
    const res = await callTool(token, 'execute', {
      code: 'async () => (await sevalla.request({ method: "GET", path: "/applications" })).body',
    })
    strictEqual(res.isError, false)
    deepStrictEqual(res.data, applications)
    const call = sevalla.calls.at(-1)
    strictEqual(call?.url, 'https://api.sevalla.com/v3/applications')
    strictEqual(call?.authorization, `Bearer ${token}`)
  })

  it('creates an application and round-trips the request body', async () => {
    sevalla.calls.length = 0
    const res = await callTool(token, 'execute', {
      code: `async () => {
        const r = await sevalla.request({ method: "POST", path: "/applications", body: { name: "billing" } })
        return { status: r.status, body: r.body }
      }`,
    })
    strictEqual(res.isError, false)
    strictEqual(res.data.status, 201)
    strictEqual(res.data.body.name, 'billing')
    const call = sevalla.calls.at(-1)
    strictEqual(call?.method, 'POST')
    deepStrictEqual(JSON.parse(call?.body ?? '{}'), { name: 'billing' })
  })

  it('chains multiple calls in a single execution', async () => {
    sevalla.calls.length = 0
    const res = await callTool(token, 'execute', {
      code: `async () => {
        const list = await sevalla.request({ method: "GET", path: "/applications" })
        const details = await Promise.all(
          list.body.map((a) => sevalla.request({ method: "GET", path: '/applications/' + a.id }))
        )
        return details.map((d) => d.body.id)
      }`,
    })
    strictEqual(res.isError, false)
    deepStrictEqual(res.data, ['app_1', 'app_2'])
    strictEqual(sevalla.calls.length, 3)
  })

  it('passes query parameters through to the upstream URL', async () => {
    sevalla.calls.length = 0
    await callTool(token, 'execute', {
      code: 'async () => (await sevalla.request({ method: "GET", path: "/applications", query: { limit: 5, page: 2 } })).body',
    })
    strictEqual(sevalla.calls.at(-1)?.url, 'https://api.sevalla.com/v3/applications?limit=5&page=2')
  })

  it('reports sandbox runtime errors as tool errors', async () => {
    const res = await callTool(token, 'execute', {
      code: 'async () => { throw new Error("boom from sandbox") }',
    })
    strictEqual(res.isError, true)
    ok(res.text.includes('boom from sandbox'))
  })

  it('truncates oversized tool output', async () => {
    const res = await callTool(token, 'execute', {
      code: 'async () => "x".repeat(40000)',
    })
    strictEqual(res.isError, false)
    ok(res.text.includes('--- TRUNCATED ---'))
    ok(res.text.length < 40000)
  })

  it('surfaces upstream non-2xx responses without throwing', async () => {
    const res = await callTool(token, 'execute', {
      code: `async () => {
        const r = await sevalla.request({ method: "GET", path: "/applications/missing_app" })
        return { status: r.status, body: r.body }
      }`,
    })
    strictEqual(res.isError, false)
    strictEqual(res.data.status, 200)
    deepStrictEqual(res.data.body, { error: 'not_found' })
  })
})

describe('Integration: concurrent users are isolated', () => {
  it('forwards each user their own bearer token', async () => {
    sevalla.calls.length = 0
    const code = 'async () => (await sevalla.request({ method: "GET", path: "/sites" })).body'
    await Promise.all([callTool('svl_user_A', 'execute', { code }), callTool('svl_user_B', 'execute', { code })])
    const auths = sevalla.calls.map((c) => c.authorization).sort()
    deepStrictEqual(auths, ['Bearer svl_user_A', 'Bearer svl_user_B'])
  })
})

describe('Integration: /mcp auth + protocol error handling', () => {
  it('returns 401 with a bearer challenge when Authorization is missing', async () => {
    const res = await mcpRequest(null, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    strictEqual(res.status, 401)
    ok(res.headers.get('www-authenticate')?.startsWith('Bearer'))
    ok(res.headers.get('www-authenticate')?.includes('resource_metadata'))
  })

  it('returns 401 for a non-bearer Authorization scheme', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic dXNlcjpwYXNz' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    strictEqual(res.status, 401)
    strictEqual((await res.json()).error, 'Missing or invalid Authorization header')
  })

  it('returns 401 with challenge on GET /mcp', async () => {
    const res = await app.request('/mcp')
    strictEqual(res.status, 401)
    ok(res.headers.get('www-authenticate')?.includes('resource_metadata'))
  })

  it('returns 405 with Allow: POST on GET /mcp with a bearer token', async () => {
    const res = await app.request('/mcp', { headers: { authorization: 'Bearer svl_x' } })
    strictEqual(res.status, 405)
    strictEqual(res.headers.get('allow'), 'POST')
  })

  it('returns 405 with Allow: POST on DELETE /mcp', async () => {
    const res = await app.request('/mcp', { method: 'DELETE' })
    strictEqual(res.status, 405)
    strictEqual(res.headers.get('allow'), 'POST')
  })

  it('returns a JSON-RPC parse error for malformed bodies', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer svl_x',
      },
      body: 'this is not json',
    })
    strictEqual(res.status, 400)
    strictEqual((await res.json()).error.code, -32700)
  })

  it('returns a JSON-RPC method-not-found error for unknown methods', async () => {
    const res = await rpc('svl_x', 'does/not/exist', {})
    ok(res.parsed.error)
    strictEqual(res.parsed.error.code, -32601)
  })

  it('honors CORS preflight', async () => {
    const res = await app.request('/mcp', {
      method: 'OPTIONS',
      headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' },
    })
    ok(res.status === 204 || res.status === 200)
    strictEqual(res.headers.get('access-control-allow-origin'), '*')
  })
})

describe('Integration: graceful shutdown (draining)', () => {
  after(() => __setShuttingDown(false))

  it('reports shutting_down on /health and 503 on /mcp while draining', async () => {
    __setShuttingDown(true)

    const health = await app.request('/health')
    strictEqual(health.status, 503)
    deepStrictEqual(await health.json(), { status: 'shutting_down' })

    const mcp = await mcpRequest('svl_token', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    strictEqual(mcp.status, 503)
    strictEqual(mcp.parsed.error, 'Server is shutting down')
  })
})
