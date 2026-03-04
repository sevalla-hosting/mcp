import { describe, it, mock } from 'node:test'
import { strictEqual, ok, notStrictEqual, throws } from 'node:assert'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import {
  verifyPkce,
  signParams,
  verifySignedParams,
  encrypt,
  decrypt,
  decryptClientId,
  validateRedirectUri,
  createOAuthRouter,
} from '../src/oauth.ts'

const makeClientId = (redirectUris: string[]) =>
  encrypt(JSON.stringify({ type: 'registration', redirect_uris: redirectUris }))

describe('verifyPkce', () => {
  it('returns true for a valid verifier-challenge pair', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    strictEqual(verifyPkce(verifier, challenge), true)
  })

  it('returns false for an invalid verifier', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    strictEqual(verifyPkce('wrong-verifier', challenge), false)
  })

  it('returns false for a tampered challenge', () => {
    strictEqual(verifyPkce('some-verifier', 'tampered-challenge'), false)
  })
})

describe('signParams / verifySignedParams', () => {
  it('verifies a valid signature', () => {
    const params = { foo: 'bar', baz: 'qux' }
    const sig = signParams(params)
    strictEqual(verifySignedParams(params, sig), true)
  })

  it('rejects a tampered param', () => {
    const params = { foo: 'bar', baz: 'qux' }
    const sig = signParams(params)
    strictEqual(verifySignedParams({ ...params, foo: 'tampered' }, sig), false)
  })

  it('rejects a tampered signature', () => {
    const params = { foo: 'bar' }
    strictEqual(verifySignedParams(params, 'invalid-sig'), false)
  })

  it('is order-independent', () => {
    const sig1 = signParams({ a: '1', b: '2' })
    const sig2 = signParams({ b: '2', a: '1' })
    strictEqual(sig1, sig2)
  })
})

describe('encrypt / decrypt', () => {
  it('round-trips plaintext', () => {
    const plaintext = JSON.stringify({ token: 'svl_test', expires_at: Date.now() })
    strictEqual(decrypt(encrypt(plaintext)), plaintext)
  })

  it('produces unique ciphertexts for same plaintext', () => {
    const plaintext = 'hello'
    notStrictEqual(encrypt(plaintext), encrypt(plaintext))
  })

  it('rejects tampered ciphertext', () => {
    const encrypted = encrypt('secret')
    const tampered = encrypted.slice(0, -2) + 'XX'
    throws(() => decrypt(tampered))
  })
})

describe('decryptClientId', () => {
  it('round-trips a valid registration blob', () => {
    const uris = ['http://localhost:8080/callback', 'https://example.com/cb']
    const clientId = makeClientId(uris)
    const result = decryptClientId(clientId)
    strictEqual(JSON.stringify(result.redirect_uris), JSON.stringify(uris))
  })

  it('rejects a blob with wrong type', () => {
    const blob = encrypt(JSON.stringify({ type: 'auth_code', redirect_uris: ['http://localhost/cb'] }))
    throws(() => decryptClientId(blob))
  })

  it('rejects a plain string client_id', () => {
    throws(() => decryptClientId('test-client'))
  })

  it('rejects an auth code blob used as client_id', () => {
    const authCode = encrypt(
      JSON.stringify({
        token: 'svl_stolen',
        code_challenge: 'abc',
        redirect_uri: 'http://localhost/cb',
        client_id: 'x',
        expires_at: Date.now() + 60_000,
      }),
    )
    throws(() => decryptClientId(authCode))
  })
})

describe('validateRedirectUri', () => {
  it('allows any valid URL', () => {
    strictEqual(validateRedirectUri('http://localhost:8080/callback'), true)
    strictEqual(validateRedirectUri('https://example.com/callback'), true)
    strictEqual(validateRedirectUri('http://evil.com/callback'), true)
    strictEqual(validateRedirectUri('cursor://anysphere.cursor-mcp/oauth/callback'), true)
    strictEqual(validateRedirectUri('vscode://extension/callback'), true)
  })

  it('rejects invalid URIs', () => {
    strictEqual(validateRedirectUri('not-a-url'), false)
    strictEqual(validateRedirectUri(''), false)
  })
})

describe('well-known endpoints', () => {
  const app = new Hono()
  app.route('', createOAuthRouter())

  it('GET /.well-known/oauth-protected-resource returns resource metadata', async () => {
    process.env.PUBLIC_URL = 'https://mcp.test.com'
    const res = await app.request('/.well-known/oauth-protected-resource')
    strictEqual(res.status, 200)
    const body = await res.json()
    strictEqual(body.resource, 'https://mcp.test.com/mcp')
    strictEqual(body.authorization_servers[0], 'https://mcp.test.com')
    delete process.env.PUBLIC_URL
  })

  it('GET /.well-known/oauth-authorization-server returns AS metadata', async () => {
    process.env.PUBLIC_URL = 'https://mcp.test.com'
    const res = await app.request('/.well-known/oauth-authorization-server')
    strictEqual(res.status, 200)
    const body = await res.json()
    strictEqual(body.issuer, 'https://mcp.test.com')
    strictEqual(body.authorization_endpoint, 'https://mcp.test.com/oauth/authorize')
    strictEqual(body.token_endpoint, 'https://mcp.test.com/oauth/token')
    strictEqual(body.registration_endpoint, 'https://mcp.test.com/oauth/register')
    strictEqual(body.token_endpoint_auth_methods_supported[0], 'none')
    strictEqual(body.code_challenge_methods_supported[0], 'S256')
    delete process.env.PUBLIC_URL
  })
})

describe('POST /oauth/register', () => {
  const app = new Hono()
  app.route('', createOAuthRouter())

  it('returns encrypted client_id from redirect_uris', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test-client',
        redirect_uris: ['http://localhost:8080/callback'],
      }),
    })
    strictEqual(res.status, 201)
    const body = await res.json()
    strictEqual(body.client_name, 'test-client')
    strictEqual(typeof body.client_id_issued_at, 'number')
    strictEqual(JSON.stringify(body.redirect_uris), JSON.stringify(['http://localhost:8080/callback']))
    const decoded = decryptClientId(body.client_id)
    strictEqual(JSON.stringify(decoded.redirect_uris), JSON.stringify(['http://localhost:8080/callback']))
  })

  it('ignores caller-provided client_id', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test',
        client_id: 'my-custom-id',
        redirect_uris: ['http://localhost:3000/cb'],
      }),
    })
    strictEqual(res.status, 201)
    const body = await res.json()
    notStrictEqual(body.client_id, 'my-custom-id')
    const decoded = decryptClientId(body.client_id)
    ok(decoded.redirect_uris.includes('http://localhost:3000/cb'))
  })

  it('does not reflect arbitrary body fields', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test',
        redirect_uris: ['http://localhost/cb'],
        access_token: 'injected',
        secret: 'evil',
      }),
    })
    strictEqual(res.status, 201)
    const body = await res.json()
    strictEqual(body.access_token, undefined)
    strictEqual(body.secret, undefined)
  })

  it('rejects missing redirect_uris', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'test-client' }),
    })
    strictEqual(res.status, 400)
    const body = await res.json()
    strictEqual(body.error, 'invalid_redirect_uris')
  })

  it('rejects empty redirect_uris array', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'test', redirect_uris: [] }),
    })
    strictEqual(res.status, 400)
    const body = await res.json()
    strictEqual(body.error, 'invalid_redirect_uris')
  })

  it('rejects invalid redirect_uris', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'test', redirect_uris: ['not-a-url'] }),
    })
    strictEqual(res.status, 400)
    const body = await res.json()
    strictEqual(body.error, 'invalid_redirect_uris')
  })
})

describe('GET /oauth/authorize', () => {
  const app = new Hono()
  app.route('', createOAuthRouter())

  it('redirects to Sevalla authorize with signed callback params', async () => {
    process.env.PUBLIC_URL = 'https://mcp.sevalla.com'
    const clientId = makeClientId(['http://localhost:8080/callback'])
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify({ code: 'TESTCODE', expires_at: new Date(Date.now() + 300_000).toISOString() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as typeof fetch

    try {
      const qs = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'http://localhost:8080/callback',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
        state: 'xyz',
      })
      const res = await app.request(`/oauth/authorize?${qs}`, { redirect: 'manual' })
      strictEqual(res.status, 302)
      const location = res.headers.get('location') ?? ''
      const url = new URL(location)
      strictEqual(url.origin, 'https://app.sevalla.com')
      strictEqual(url.pathname, '/authorize')
      strictEqual(url.searchParams.get('code'), 'TESTCODE')
      strictEqual(url.searchParams.get('name'), 'Sevalla MCP')

      const callbackUrl = new URL(url.searchParams.get('callback') ?? '')
      strictEqual(callbackUrl.pathname, '/oauth/callback/TESTCODE')
      strictEqual(callbackUrl.searchParams.get('redirect_uri'), 'http://localhost:8080/callback')
      strictEqual(callbackUrl.searchParams.get('code_challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
      strictEqual(callbackUrl.searchParams.get('client_id'), clientId)
      strictEqual(callbackUrl.searchParams.get('state'), 'xyz')
      strictEqual(callbackUrl.searchParams.get('device_code'), 'TESTCODE')
      ok(callbackUrl.searchParams.get('expires_at'))
      ok(callbackUrl.searchParams.get('sig'))

      const params = {
        redirect_uri: callbackUrl.searchParams.get('redirect_uri') ?? '',
        code_challenge: callbackUrl.searchParams.get('code_challenge') ?? '',
        client_id: callbackUrl.searchParams.get('client_id') ?? '',
        state: callbackUrl.searchParams.get('state') ?? '',
        device_code: callbackUrl.searchParams.get('device_code') ?? '',
        expires_at: callbackUrl.searchParams.get('expires_at') ?? '',
      }
      strictEqual(verifySignedParams(params, callbackUrl.searchParams.get('sig') ?? ''), true)
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.PUBLIC_URL
    }
  })

  it('returns 400 when required params are missing', async () => {
    const res = await app.request('/oauth/authorize?response_type=code')
    strictEqual(res.status, 400)
  })

  it('returns 400 when code_challenge_method is not S256', async () => {
    const clientId = makeClientId(['http://localhost/callback'])
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://localhost/callback',
      code_challenge: 'abc',
      code_challenge_method: 'plain',
      state: 's',
    })
    const res = await app.request(`/oauth/authorize?${qs}`)
    strictEqual(res.status, 400)
  })

  it('returns 400 for http non-loopback redirect_uri', async () => {
    const clientId = makeClientId(['https://example.com/cb'])
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://evil.com/steal',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      state: 's',
    })
    const res = await app.request(`/oauth/authorize?${qs}`)
    strictEqual(res.status, 400)
    const body = await res.json()
    strictEqual(body.error, 'invalid_redirect_uri')
  })

  it('returns 400 for javascript: redirect_uri', async () => {
    const clientId = makeClientId(['https://example.com/cb'])
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'javascript:alert(1)',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      state: 's',
    })
    const res = await app.request(`/oauth/authorize?${qs}`)
    strictEqual(res.status, 400)
    const body = await res.json()
    strictEqual(body.error, 'invalid_redirect_uri')
  })

  it('returns 401 for plain-string (unregistered) client_id', async () => {
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: 'test-client',
      redirect_uri: 'http://localhost:8080/callback',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      state: 's',
    })
    const res = await app.request(`/oauth/authorize?${qs}`)
    strictEqual(res.status, 401)
    const body = await res.json()
    strictEqual(body.error, 'invalid_client')
  })

  it('returns 400 for redirect_uri not in registered list', async () => {
    const clientId = makeClientId(['http://localhost:8080/callback'])
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify({ code: 'X' }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ) as typeof fetch

    try {
      const qs = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: 'https://evil.com/callback',
        code_challenge: 'abc',
        code_challenge_method: 'S256',
        state: 's',
      })
      const res = await app.request(`/oauth/authorize?${qs}`)
      strictEqual(res.status, 400)
      const body = await res.json()
      strictEqual(body.error, 'invalid_redirect_uri')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('GET /oauth/callback/:deviceCode', () => {
  const app = new Hono()
  app.route('', createOAuthRouter())

  it('encrypts auth code and redirects on approved device code', async () => {
    const clientId = makeClientId(['http://localhost:8080/callback'])
    const params = {
      redirect_uri: 'http://localhost:8080/callback',
      code_challenge: 'test-challenge',
      client_id: clientId,
      state: 'test-state',
      device_code: 'APPROVED1',
      expires_at: (Date.now() + 300_000).toString(),
    }
    const sig = signParams(params)
    const qs = new URLSearchParams({ ...params, sig }).toString()

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify({ status: 'approved', token: 'svl_testtoken123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as typeof fetch

    try {
      const res = await app.request(`/oauth/callback/APPROVED1?${qs}`, { redirect: 'manual' })
      strictEqual(res.status, 302)
      const location = new URL(res.headers.get('location') ?? '')
      strictEqual(location.origin, 'http://localhost:8080')
      strictEqual(location.pathname, '/callback')
      strictEqual(location.searchParams.get('state'), 'test-state')
      const authCode = location.searchParams.get('code') ?? ''
      ok(authCode.length > 0)
      const stored = JSON.parse(decrypt(authCode))
      strictEqual(stored.token, 'svl_testtoken123')
      strictEqual(stored.client_id, clientId)
      strictEqual(stored.code_challenge, 'test-challenge')
      strictEqual(stored.redirect_uri, 'http://localhost:8080/callback')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('redirects with error when device code is denied', async () => {
    const clientId = makeClientId(['http://localhost:8080/callback'])
    const params = {
      redirect_uri: 'http://localhost:8080/callback',
      code_challenge: 'c',
      client_id: clientId,
      state: 'denied-state',
      device_code: 'DENIED1',
      expires_at: (Date.now() + 300_000).toString(),
    }
    const sig = signParams(params)
    const qs = new URLSearchParams({ ...params, sig }).toString()

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify({ status: 'denied' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as typeof fetch

    try {
      const res = await app.request(`/oauth/callback/DENIED1?${qs}`, { redirect: 'manual' })
      strictEqual(res.status, 302)
      const location = new URL(res.headers.get('location') ?? '')
      strictEqual(location.searchParams.get('error'), 'access_denied')
      strictEqual(location.searchParams.get('state'), 'denied-state')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns 400 for missing signed params', async () => {
    const res = await app.request('/oauth/callback/NONEXISTENT')
    strictEqual(res.status, 400)
  })

  it('returns 403 for invalid signature', async () => {
    const qs = new URLSearchParams({
      redirect_uri: 'http://localhost:8080/callback',
      code_challenge: 'c',
      client_id: 'c',
      state: 's',
      device_code: 'TAMPERED',
      expires_at: (Date.now() + 300_000).toString(),
      sig: 'invalid-signature',
    }).toString()

    const res = await app.request(`/oauth/callback/TAMPERED?${qs}`)
    strictEqual(res.status, 403)
  })
})

describe('POST /oauth/token', () => {
  const app = new Hono()
  app.route('', createOAuthRouter())

  it('exchanges encrypted auth code for access token with valid PKCE', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const clientId = makeClientId(['http://localhost:8080/callback'])

    const code = encrypt(
      JSON.stringify({
        token: 'svl_realtoken',
        code_challenge: challenge,
        redirect_uri: 'http://localhost:8080/callback',
        client_id: clientId,
        expires_at: Date.now() + 60_000,
      }),
    )

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:8080/callback',
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })

    strictEqual(res.status, 200)
    const body = await res.json()
    strictEqual(body.access_token, 'svl_realtoken')
    strictEqual(body.token_type, 'bearer')
  })

  it('rejects invalid PKCE verifier', async () => {
    const challenge = createHash('sha256').update('correct-verifier').digest('base64url')
    const clientId = makeClientId(['http://localhost:8080/callback'])

    const code = encrypt(
      JSON.stringify({
        token: 'svl_token',
        code_challenge: challenge,
        redirect_uri: 'http://localhost:8080/callback',
        client_id: clientId,
        expires_at: Date.now() + 60_000,
      }),
    )

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:8080/callback',
        client_id: clientId,
        code_verifier: 'wrong-verifier',
      }).toString(),
    })

    strictEqual(res.status, 400)
    const body = await res.json()
    strictEqual(body.error, 'invalid_grant')
  })

  it('rejects mismatched redirect_uri', async () => {
    const verifier = 'test-verifier'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const clientId = makeClientId(['http://localhost:8080/callback'])

    const code = encrypt(
      JSON.stringify({
        token: 'svl_token',
        code_challenge: challenge,
        redirect_uri: 'http://localhost:8080/callback',
        client_id: clientId,
        expires_at: Date.now() + 60_000,
      }),
    )

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://evil.com/callback',
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })

    strictEqual(res.status, 400)
  })

  it('rejects expired auth code', async () => {
    const verifier = 'test-verifier-for-expiry'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const clientId = makeClientId(['http://localhost:8080/callback'])

    const code = encrypt(
      JSON.stringify({
        token: 'svl_token',
        code_challenge: challenge,
        redirect_uri: 'http://localhost:8080/callback',
        client_id: clientId,
        expires_at: Date.now() - 1000,
      }),
    )

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:8080/callback',
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    })

    strictEqual(res.status, 400)
    const body = await res.json()
    strictEqual(body.error, 'invalid_grant')
  })

  it('rejects mismatched client_id', async () => {
    const verifier = 'test-verifier-for-client'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const clientA = makeClientId(['http://localhost:8080/callback'])
    const clientB = makeClientId(['http://localhost:8080/callback'])

    const code = encrypt(
      JSON.stringify({
        token: 'svl_token',
        code_challenge: challenge,
        redirect_uri: 'http://localhost:8080/callback',
        client_id: clientA,
        expires_at: Date.now() + 60_000,
      }),
    )

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:8080/callback',
        client_id: clientB,
        code_verifier: verifier,
      }).toString(),
    })

    strictEqual(res.status, 400)
  })

  it('rejects invalid encrypted auth code', async () => {
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'not-a-valid-encrypted-code',
        redirect_uri: 'http://localhost:8080/callback',
        client_id: 'test-client',
        code_verifier: 'whatever',
      }).toString(),
    })

    strictEqual(res.status, 400)
    const body = await res.json()
    strictEqual(body.error, 'invalid_grant')
  })
})
