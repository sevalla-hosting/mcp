import { after, afterEach, before, describe, it } from 'node:test'
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { startFakeApi, TOKENS, type FakeApi } from './support/fake-api.ts'

let api: FakeApi
let app: Awaited<typeof import('../src/index.ts')>['app']
let setShuttingDown: (_value: boolean) => void
let resetTokenCache: () => void
let signParams: (_params: Record<string, string>) => string
let setClientMetadataFetcher: (typeof import('../src/client-metadata.ts'))['__setClientMetadataFetcher']

before(async () => {
  api = await startFakeApi()
  process.env.SEVALLA_API_URL = api.url
  process.env.PUBLIC_URL = 'https://mcp.sevalla.com'
  const server = await import('../src/index.ts')
  app = server.app
  setShuttingDown = server.__setShuttingDown
  resetTokenCache = server.__resetTokenCache
  signParams = (await import('../src/oauth.ts')).signParams
  setClientMetadataFetcher = (await import('../src/client-metadata.ts')).__setClientMetadataFetcher
})

after(async () => {
  await api.close()
})

afterEach(() => {
  api.reset()
  resetTokenCache()
  delete process.env.DEVICE_CODE_TRUSTED_CLIENT_TOKEN
  setClientMetadataFetcher()
})

const mcpRequest = async (token: string | null, body: unknown, path = '/mcp') => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token !== null) {
    headers.authorization = `Bearer ${token}`
  }
  const res = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  return { status: res.status, headers: res.headers, parsed }
}

const listTools = (token: string, path = '/mcp') =>
  mcpRequest(token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, path)

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

describe('HTTP: public and discovery endpoints', () => {
  it('serves the landing page, health and glama manifest', async () => {
    strictEqual((await app.request('/')).status, 200)
    deepStrictEqual(await (await app.request('/health')).json(), { status: 'ok' })
    strictEqual(
      (await (await app.request('/.well-known/glama.json')).json()).$schema,
      'https://glama.ai/mcp/schemas/connector.json',
    )
  })

  it('serves protected resource metadata whose resource matches the MCP URL', async () => {
    const root = await (await app.request('/.well-known/oauth-protected-resource')).json()
    const mcp = await (await app.request('/.well-known/oauth-protected-resource/mcp')).json()
    strictEqual(root.resource, 'https://mcp.sevalla.com/mcp')
    strictEqual(mcp.resource, 'https://mcp.sevalla.com/mcp')
    deepStrictEqual(mcp.authorization_servers, ['https://mcp.sevalla.com'])
    strictEqual((await app.request('/.well-known/oauth-protected-resource/mcp/full')).status, 404)
  })

  it('serves the OpenAI domain verification token when configured', async () => {
    strictEqual((await app.request('/.well-known/openai-apps-challenge')).status, 404)
    process.env.OPENAI_APPS_CHALLENGE = 'challenge-token-123'
    try {
      const res = await app.request('/.well-known/openai-apps-challenge')
      strictEqual(res.status, 200)
      strictEqual(await res.text(), 'challenge-token-123')
    } finally {
      delete process.env.OPENAI_APPS_CHALLENGE
    }
  })

  it('serves authorization server metadata with DCR and S256 PKCE', async () => {
    const body = await (await app.request('/.well-known/oauth-authorization-server')).json()
    strictEqual(body.authorization_response_iss_parameter_supported, true)
    strictEqual(body.issuer, 'https://mcp.sevalla.com')
    strictEqual(body.registration_endpoint, 'https://mcp.sevalla.com/oauth/register')
    deepStrictEqual(body.code_challenge_methods_supported, ['S256'])
    deepStrictEqual(body.token_endpoint_auth_methods_supported, ['none'])
    strictEqual(body.client_id_metadata_document_supported, true)
  })

  it('names the resource and its bearer method in the protected resource metadata', async () => {
    const body = await (await app.request('/.well-known/oauth-protected-resource/mcp')).json()
    strictEqual(body.resource_name, 'Sevalla')
    deepStrictEqual(body.bearer_methods_supported, ['header'])
  })
})

describe('HTTP: OAuth sign-in flow', () => {
  const redirectUri = 'http://localhost:8976/callback'

  const register = async (uris = [redirectUri]) =>
    app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test', redirect_uris: uris }),
    })

  const authorize = async (clientId: string, challenge: string, headers: Record<string, string> = {}) => {
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'state-1',
    })
    return app.request(`/oauth/authorize?${qs}`, { redirect: 'manual', headers })
  }

  it('signs in end to end and the issued token works on /mcp', async () => {
    const { verifier, challenge } = pkce()
    const clientId = (await (await register()).json()).client_id
    const consent = new URL((await authorize(clientId, challenge)).headers.get('location') ?? '')
    strictEqual(consent.searchParams.get('name'), 'Sevalla MCP (localhost)')
    const callback = new URL(consent.searchParams.get('callback') ?? '')
    const back = new URL(
      (await app.request(`${callback.pathname}${callback.search}`, { redirect: 'manual' })).headers.get('location') ??
        '',
    )
    strictEqual(back.searchParams.get('state'), 'state-1')
    strictEqual(back.searchParams.get('iss'), 'https://mcp.sevalla.com')
    const token = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') ?? '',
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })
    const { access_token } = await token.json()
    ok(access_token.startsWith('smcp_'))
    ok(!access_token.includes(TOKENS.valid))
    const tools = await listTools(access_token)
    strictEqual(tools.parsed.result.tools.length, 27)
    strictEqual(api.forOperation('getCurrentApiKeyV3')[0]?.token, TOKENS.valid)
  })

  it('rejects tampered or foreign access tokens and unknown resources', async () => {
    const tampered = await listTools('smcp_not-a-valid-envelope')
    strictEqual(tampered.status, 401)
    ok(tampered.headers.get('www-authenticate')?.includes('error="invalid_token"'))
    const { challenge } = pkce()
    const clientId = (await (await register()).json()).client_id
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
      resource: 'https://other.example.com/mcp',
    })
    const res = await app.request(`/oauth/authorize?${qs}`)
    strictEqual(res.status, 400)
    strictEqual((await res.json()).error, 'invalid_target')
  })

  it('accepts the MCP URL or origin as the resource parameter', async () => {
    for (const resource of ['https://mcp.sevalla.com/mcp', 'https://mcp.sevalla.com', 'https://mcp.sevalla.com/mcp/']) {
      const { challenge } = pkce()
      const clientId = (await (await register()).json()).client_id
      const qs = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 's',
        resource,
      })
      strictEqual((await app.request(`/oauth/authorize?${qs}`, { redirect: 'manual' })).status, 302, resource)
    }
  })

  const deviceCodeIp = async (headers: Record<string, string>) => {
    api.reset()
    const { challenge } = pkce()
    const clientId = (await (await register()).json()).client_id
    await authorize(clientId, challenge, headers)
    return api.forOperation('createDeviceCodeV3')[0]?.headers
  }

  it('sends trusted-client headers for device codes when configured', async () => {
    process.env.DEVICE_CODE_TRUSTED_CLIENT_TOKEN = 'service-secret'
    const { challenge } = pkce()
    const clientId = (await (await register()).json()).client_id
    const consent = new URL(
      (await authorize(clientId, challenge, { 'x-forwarded-for': '203.0.113.7' })).headers.get('location') ?? '',
    )
    const create = api.forOperation('createDeviceCodeV3')[0]
    strictEqual(create?.headers['x-sevalla-service-token'], 'service-secret')
    strictEqual(create?.headers['x-sevalla-client-ip'], '203.0.113.7')
    const callback = new URL(consent.searchParams.get('callback') ?? '')
    await app.request(`${callback.pathname}${callback.search}`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    })
    strictEqual(api.forOperation('pollDeviceCodeV3')[0]?.headers['x-sevalla-client-ip'], '203.0.113.7')
  })

  it('ignores client-supplied X-Forwarded-For entries left of the trusted proxies', async () => {
    process.env.DEVICE_CODE_TRUSTED_CLIENT_TOKEN = 'service-secret'
    const spoofed = { 'x-forwarded-for': '198.51.100.99, 203.0.113.7' }
    strictEqual((await deviceCodeIp(spoofed))?.['x-sevalla-client-ip'], '203.0.113.7')
    process.env.TRUSTED_PROXY_HOPS = '2'
    try {
      strictEqual(
        (await deviceCodeIp({ 'x-forwarded-for': '198.51.100.99, 203.0.113.7, 10.0.0.1' }))?.['x-sevalla-client-ip'],
        '203.0.113.7',
      )
    } finally {
      delete process.env.TRUSTED_PROXY_HOPS
    }
  })

  it('reads the client IP from an edge header such as CF-Connecting-IP', async () => {
    process.env.DEVICE_CODE_TRUSTED_CLIENT_TOKEN = 'service-secret'
    process.env.CLIENT_IP_HEADER = 'cf-connecting-ip'
    try {
      const headers = await deviceCodeIp({ 'cf-connecting-ip': '2001:db8::1', 'x-forwarded-for': '198.51.100.99' })
      strictEqual(headers?.['x-sevalla-client-ip'], '2001:db8::1')
    } finally {
      delete process.env.CLIENT_IP_HEADER
    }
  })

  it('omits the trusted-client headers when no valid client IP is available', async () => {
    process.env.DEVICE_CODE_TRUSTED_CLIENT_TOKEN = 'service-secret'
    const headers = await deviceCodeIp({ 'x-forwarded-for': 'not-an-ip' })
    strictEqual(headers?.['x-sevalla-service-token'], undefined)
    strictEqual(headers?.['x-sevalla-client-ip'], undefined)
  })

  it('omits trusted-client headers when no service token is configured', async () => {
    const { challenge } = pkce()
    const clientId = (await (await register()).json()).client_id
    await authorize(clientId, challenge, { 'x-forwarded-for': '203.0.113.7' })
    strictEqual(api.forOperation('createDeviceCodeV3')[0]?.headers['x-sevalla-service-token'], undefined)
  })

  it('rejects public http redirect URIs at registration', async () => {
    const res = await register(['http://evil.example.com/cb'])
    strictEqual(res.status, 400)
    strictEqual((await res.json()).error, 'invalid_redirect_uris')
  })

  it('reports unsupported grant types with the RFC 6749 error code', async () => {
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'x' }).toString(),
    })
    strictEqual(res.status, 400)
    strictEqual((await res.json()).error, 'unsupported_grant_type')
  })

  it('returns 502 when the API cannot create a device code', async () => {
    api.override('createDeviceCodeV3', () => ({ status: 503, body: { message: 'down' } }))
    const { challenge } = pkce()
    const clientId = (await (await register()).json()).client_id
    const res = await authorize(clientId, challenge)
    strictEqual(res.status, 502)
    strictEqual((await res.json()).error, 'device_code_request_failed')
  })

  it('redirects with access_denied when the user declines', async () => {
    api.override('pollDeviceCodeV3', () => ({ body: { status: 'denied' } }))
    const { challenge } = pkce()
    const clientId = (await (await register()).json()).client_id
    const consent = new URL((await authorize(clientId, challenge)).headers.get('location') ?? '')
    const callback = new URL(consent.searchParams.get('callback') ?? '')
    const back = new URL(
      (await app.request(`${callback.pathname}${callback.search}`, { redirect: 'manual' })).headers.get('location') ??
        '',
    )
    strictEqual(back.searchParams.get('error'), 'access_denied')
  })

  it('rejects an expired callback', async () => {
    const params = {
      redirect_uri: redirectUri,
      code_challenge: 'c',
      client_id: 'id',
      state: 's',
      device_code: 'OLD',
      expires_at: '1000',
    }
    const res = await app.request(`/oauth/callback/OLD?${new URLSearchParams({ ...params, sig: signParams(params) })}`)
    strictEqual(res.status, 400)
    strictEqual((await res.json()).error, 'expired')
  })
})

describe('HTTP: OAuth sign-in with client ID metadata documents', () => {
  const CLAUDE_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
  const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
  const claudeDocument = {
    client_id: CLAUDE_ID,
    client_name: 'Claude',
    redirect_uris: [CLAUDE_REDIRECT],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }

  const serveDocuments = (documents: Record<string, unknown>) => {
    const fetched: string[] = []
    setClientMetadataFetcher(async (url) => {
      fetched.push(url.href)
      const doc = documents[url.href]
      if (doc === undefined) {
        const { ClientMetadataError } = await import('../src/client-metadata.ts')
        throw new ClientMetadataError('could not be fetched')
      }
      return { body: typeof doc === 'string' ? doc : JSON.stringify(doc), ttlMs: 300_000 }
    })
    return fetched
  }

  const authorize = (clientId: string, redirect: string, challenge: string) =>
    app.request(
      `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'cimd-state',
        resource: 'https://mcp.sevalla.com/mcp',
      })}`,
      { redirect: 'manual' },
    )

  it('signs a client in from its metadata document and names it on the consent screen', async () => {
    const fetched = serveDocuments({ [CLAUDE_ID]: claudeDocument })
    const { verifier, challenge } = pkce()
    const res = await authorize(CLAUDE_ID, CLAUDE_REDIRECT, challenge)
    strictEqual(res.status, 302)
    deepStrictEqual(fetched, [CLAUDE_ID])
    const consent = new URL(res.headers.get('location') ?? '')
    strictEqual(consent.searchParams.get('name'), 'Sevalla MCP (claude.ai - Claude)')
    const callback = new URL(consent.searchParams.get('callback') ?? '')
    const back = new URL(
      (await app.request(`${callback.pathname}${callback.search}`, { redirect: 'manual' })).headers.get('location') ??
        '',
    )
    strictEqual(`${back.origin}${back.pathname}`, CLAUDE_REDIRECT)
    strictEqual(back.searchParams.get('iss'), 'https://mcp.sevalla.com')
    const exchange = (clientId: string) =>
      app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: back.searchParams.get('code') ?? '',
          redirect_uri: CLAUDE_REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
          resource: 'https://mcp.sevalla.com/mcp',
        }).toString(),
      })
    strictEqual((await (await exchange('https://evil.example/client.json')).json()).error, 'invalid_grant')
    const { access_token } = await (await exchange(CLAUDE_ID)).json()
    ok(access_token.startsWith('smcp_'))
    strictEqual((await listTools(access_token)).parsed.result.tools.length, 27)
  })

  it('rejects redirect URIs that the metadata document does not list', async () => {
    serveDocuments({ [CLAUDE_ID]: claudeDocument })
    const res = await authorize(CLAUDE_ID, 'https://evil.example/callback', pkce().challenge)
    strictEqual(res.status, 400)
    strictEqual((await res.json()).error, 'invalid_redirect_uri')
    strictEqual(api.forOperation('createDeviceCodeV3').length, 0)
  })

  it('rejects clients whose metadata document cannot be used', async () => {
    serveDocuments({ [CLAUDE_ID]: { ...claudeDocument, client_id: 'https://evil.example/client.json' } })
    const mismatch = await authorize(CLAUDE_ID, CLAUDE_REDIRECT, pkce().challenge)
    strictEqual(mismatch.status, 401)
    const body = await mismatch.json()
    strictEqual(body.error, 'invalid_client')
    ok(body.error_description.includes('does not match'))
    const missing = await authorize('https://unknown.example/client.json', CLAUDE_REDIRECT, pkce().challenge)
    strictEqual(missing.status, 401)
    strictEqual((await missing.json()).error_description, 'The client metadata document could not be fetched.')
    strictEqual(api.forOperation('createDeviceCodeV3').length, 0)
  })

  it('never fetches client IDs on IP addresses, bare host names or explicit ports', async () => {
    const fetched = serveDocuments({})
    for (const clientId of [
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.8/client.json',
      'https://kubernetes/client.json',
      'https://client.example:22/meta.json',
    ]) {
      const res = await authorize(clientId, CLAUDE_REDIRECT, pkce().challenge)
      strictEqual(res.status, 401, clientId)
      strictEqual((await res.json()).error, 'invalid_client', clientId)
    }
    deepStrictEqual(fetched, [])
  })

  it('limits uncached metadata fetches per client address', async () => {
    serveDocuments({})
    const attempt = (i: number) =>
      app.request(
        `/oauth/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: `https://client${i}.example/meta.json`,
          redirect_uri: CLAUDE_REDIRECT,
          code_challenge: pkce().challenge,
          code_challenge_method: 'S256',
          state: 's',
        })}`,
        { redirect: 'manual', headers: { 'x-forwarded-for': '203.0.113.50' } },
      )
    for (let i = 0; i < 30; i += 1) {
      strictEqual((await attempt(i)).status, 401)
    }
    const limited = await attempt(30)
    strictEqual(limited.status, 429)
    strictEqual((await limited.json()).error, 'temporarily_unavailable')
  })

  it('keeps hostile client names short and printable on the consent screen', async () => {
    const id = 'https://client.example/meta.json'
    serveDocuments({
      [id]: {
        client_id: id,
        client_name: 'Totally\u0000 Legit\u202e   Client With An Extremely Long Name That Keeps Going',
        redirect_uris: ['https://client.example/callback'],
      },
    })
    const res = await authorize(id, 'https://client.example/callback', pkce().challenge)
    const name = new URL(res.headers.get('location') ?? '').searchParams.get('name') ?? ''
    strictEqual(name, 'Sevalla MCP (client.example - Totally Legit Client With An Extremely L)')
  })
})

describe('HTTP: OAuth endpoint limits', () => {
  it('answers a pathological resource parameter in linear time', async () => {
    const started = Date.now()
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'x',
        redirect_uri: 'https://client.example/cb',
        client_id: 'x',
        code_verifier: 'x',
        resource: `${'/'.repeat(5_000)}x`,
      }).toString(),
    })
    strictEqual(res.status, 400)
    strictEqual((await res.json()).error, 'invalid_target')
    ok(Date.now() - started < 250)
  })

  it('rejects OAuth request bodies over 16 KB', async () => {
    const token = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=authorization_code&resource=${'a'.repeat(20_000)}`,
    })
    strictEqual(token.status, 413)
    const register = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'x'.repeat(20_000), redirect_uris: ['https://client.example/cb'] }),
    })
    strictEqual(register.status, 413)
  })
})

describe('HTTP: /mcp authentication', () => {
  it('challenges missing credentials with the protected resource metadata', async () => {
    const res = await mcpRequest(null, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    strictEqual(res.status, 401)
    ok(res.headers.get('www-authenticate')?.includes('/.well-known/oauth-protected-resource/mcp"'))
    ok(res.headers.get('www-authenticate')?.includes('scope="mcp:tools"'))
  })

  it('rejects non-bearer schemes', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Basic dXNlcjpwYXNz' },
      body: '{}',
    })
    strictEqual(res.status, 401)
  })

  it('answers an invalid API key with 401 invalid_token before running MCP', async () => {
    const res = await listTools('svl_revoked')
    strictEqual(res.status, 401)
    ok(res.headers.get('www-authenticate')?.includes('error="invalid_token"'))
  })

  it('caches token validation', async () => {
    await listTools(TOKENS.valid)
    await listTools(TOKENS.valid)
    strictEqual(api.forOperation('getCurrentApiKeyV3').length, 1)
  })

  it('serves requests when the API cannot validate the key', async () => {
    api.override('getCurrentApiKeyV3', () => ({ status: 503, body: { message: 'unavailable' } }))
    const res = await listTools(TOKENS.valid)
    strictEqual(res.status, 200)
    strictEqual(res.parsed.result.tools.length, 27)
  })
})

describe('HTTP: protocol handling', () => {
  it('returns 405 for GET with a bearer token and for DELETE', async () => {
    const get = await app.request('/mcp', { headers: { authorization: `Bearer ${TOKENS.valid}` } })
    strictEqual(get.status, 405)
    strictEqual((await app.request('/mcp', { method: 'DELETE' })).status, 405)
  })

  it('returns JSON-RPC errors for malformed bodies and unknown methods', async () => {
    const parse = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKENS.valid}`,
      },
      body: 'not json',
    })
    strictEqual((await parse.json()).error.code, -32700)
    const unknown = await mcpRequest(TOKENS.valid, { jsonrpc: '2.0', id: 2, method: 'does/not/exist', params: {} })
    strictEqual(unknown.parsed.error.code, -32601)
  })

  it('allows CORS preflight and exposes WWW-Authenticate', async () => {
    const res = await app.request('/mcp', {
      method: 'OPTIONS',
      headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' },
    })
    strictEqual(res.headers.get('access-control-allow-origin'), '*')
    ok(res.headers.get('access-control-expose-headers')?.includes('WWW-Authenticate'))
  })

  it('drains during shutdown', async () => {
    setShuttingDown(true)
    try {
      strictEqual((await app.request('/health')).status, 503)
      strictEqual((await listTools(TOKENS.valid)).status, 503)
    } finally {
      setShuttingDown(false)
    }
  })
})
