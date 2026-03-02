import { describe, it, mock } from 'node:test'
import { strictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import {
  verifyPkce,
  generateAuthCode,
  pendingAuthorizations,
  authCodes,
  cleanupExpired,
  createOAuthRouter,
} from '../src/oauth.ts'

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

describe('generateAuthCode', () => {
  it('returns a non-empty string', () => {
    const code = generateAuthCode()
    strictEqual(typeof code, 'string')
    strictEqual(code.length > 0, true)
  })

  it('returns unique values', () => {
    const a = generateAuthCode()
    const b = generateAuthCode()
    strictEqual(a !== b, true)
  })
})

describe('auth store', () => {
  it('stores and retrieves a pending authorization', () => {
    pendingAuthorizations.set('TEST1', {
      redirectUri: 'http://localhost:8080/callback',
      codeChallenge: 'challenge123',
      clientId: 'client1',
      state: 'state1',
      expiresAt: Date.now() + 300_000,
    })
    const entry = pendingAuthorizations.get('TEST1')
    strictEqual(entry?.clientId, 'client1')
    pendingAuthorizations.delete('TEST1')
  })

  it('stores and retrieves an auth code', () => {
    authCodes.set('code1', {
      token: 'svl_test123',
      codeChallenge: 'challenge123',
      redirectUri: 'http://localhost:8080/callback',
      clientId: 'client1',
      expiresAt: Date.now() + 60_000,
    })
    const entry = authCodes.get('code1')
    strictEqual(entry?.token, 'svl_test123')
    authCodes.delete('code1')
  })

  it('cleanupExpired removes expired entries', () => {
    pendingAuthorizations.set('EXPIRED', {
      redirectUri: 'http://localhost:8080/callback',
      codeChallenge: 'c',
      clientId: 'c',
      state: '',
      expiresAt: Date.now() - 1000,
    })
    authCodes.set('expired-code', {
      token: 'svl_old',
      codeChallenge: 'c',
      redirectUri: 'http://localhost:8080/callback',
      clientId: 'c',
      expiresAt: Date.now() - 1000,
    })
    cleanupExpired()
    strictEqual(pendingAuthorizations.has('EXPIRED'), false)
    strictEqual(authCodes.has('expired-code'), false)
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
    strictEqual(body.code_challenge_methods_supported[0], 'S256')
    delete process.env.PUBLIC_URL
  })
})

describe('POST /oauth/register', () => {
  const app = new Hono()
  app.route('', createOAuthRouter())

  it('returns client_id from request body when provided', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'test-client', client_id: 'my-client-id' }),
    })
    strictEqual(res.status, 201)
    const body = await res.json()
    strictEqual(body.client_id, 'my-client-id')
    strictEqual(typeof body.client_id_issued_at, 'number')
  })

  it('generates client_id when not provided', async () => {
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'test-client' }),
    })
    strictEqual(res.status, 201)
    const body = await res.json()
    strictEqual(typeof body.client_id, 'string')
    strictEqual(body.client_id.length > 0, true)
  })
})

describe('GET /oauth/authorize', () => {
  const app = new Hono()
  app.route('', createOAuthRouter())

  it('redirects to Sevalla authorize with device code', async () => {
    process.env.PUBLIC_URL = 'https://mcp.sevalla.com'
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify({ code: 'TESTCODE', expires_at: new Date(Date.now() + 300_000).toISOString() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as typeof fetch

    try {
      const res = await app.request(
        '/oauth/authorize?response_type=code&client_id=test-client&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&state=xyz',
        { redirect: 'manual' },
      )
      strictEqual(res.status, 302)
      const location = res.headers.get('location') ?? ''
      const url = new URL(location)
      strictEqual(url.origin, 'https://app.sevalla.com')
      strictEqual(url.pathname, '/authorize')
      strictEqual(url.searchParams.get('code'), 'TESTCODE')
      strictEqual(url.searchParams.get('name'), 'Sevalla MCP')
      strictEqual(url.searchParams.get('callback'), 'https://mcp.sevalla.com/oauth/callback/TESTCODE')

      strictEqual(pendingAuthorizations.has('TESTCODE'), true)
      const pending = pendingAuthorizations.get('TESTCODE')
      strictEqual(pending?.redirectUri, 'http://localhost:8080/callback')
      strictEqual(pending?.codeChallenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
      strictEqual(pending?.clientId, 'test-client')
      strictEqual(pending?.state, 'xyz')
    } finally {
      pendingAuthorizations.delete('TESTCODE')
      globalThis.fetch = originalFetch
      delete process.env.PUBLIC_URL
    }
  })

  it('returns 400 when required params are missing', async () => {
    const res = await app.request('/oauth/authorize?response_type=code')
    strictEqual(res.status, 400)
  })

  it('returns 400 when code_challenge_method is not S256', async () => {
    const res = await app.request(
      '/oauth/authorize?response_type=code&client_id=c&redirect_uri=http%3A%2F%2Flocalhost&code_challenge=abc&code_challenge_method=plain&state=s',
    )
    strictEqual(res.status, 400)
  })
})

describe('GET /oauth/callback/:deviceCode', () => {
  const app = new Hono()
  app.route('', createOAuthRouter())

  it('generates auth code and redirects on approved device code', async () => {
    pendingAuthorizations.set('APPROVED1', {
      redirectUri: 'http://localhost:8080/callback',
      codeChallenge: 'test-challenge',
      clientId: 'test-client',
      state: 'test-state',
      expiresAt: Date.now() + 300_000,
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify({ status: 'approved', token: 'svl_testtoken123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as typeof fetch

    try {
      const res = await app.request('/oauth/callback/APPROVED1', { redirect: 'manual' })
      strictEqual(res.status, 302)
      const location = new URL(res.headers.get('location') ?? '')
      strictEqual(location.origin, 'http://localhost:8080')
      strictEqual(location.pathname, '/callback')
      strictEqual(location.searchParams.get('state'), 'test-state')
      const authCode = location.searchParams.get('code') ?? ''
      strictEqual(authCode.length > 0, true)
      strictEqual(authCodes.has(authCode), true)
      const stored = authCodes.get(authCode)
      strictEqual(stored?.token, 'svl_testtoken123')
      strictEqual(stored?.clientId, 'test-client')
      strictEqual(stored?.codeChallenge, 'test-challenge')
      strictEqual(stored?.redirectUri, 'http://localhost:8080/callback')
    } finally {
      globalThis.fetch = originalFetch
      pendingAuthorizations.delete('APPROVED1')
      for (const [k] of authCodes) {
        authCodes.delete(k)
      }
    }
  })

  it('redirects with error when device code is denied', async () => {
    pendingAuthorizations.set('DENIED1', {
      redirectUri: 'http://localhost:8080/callback',
      codeChallenge: 'c',
      clientId: 'c',
      state: 'denied-state',
      expiresAt: Date.now() + 300_000,
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify({ status: 'denied' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    ) as typeof fetch

    try {
      const res = await app.request('/oauth/callback/DENIED1', { redirect: 'manual' })
      strictEqual(res.status, 302)
      const location = new URL(res.headers.get('location') ?? '')
      strictEqual(location.searchParams.get('error'), 'access_denied')
      strictEqual(location.searchParams.get('state'), 'denied-state')
    } finally {
      globalThis.fetch = originalFetch
      pendingAuthorizations.delete('DENIED1')
    }
  })

  it('returns 404 for unknown device code', async () => {
    const res = await app.request('/oauth/callback/NONEXISTENT')
    strictEqual(res.status, 404)
  })
})

describe('POST /oauth/token', () => {
  const app = new Hono()
  app.route('', createOAuthRouter())

  it('exchanges auth code for access token with valid PKCE', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    authCodes.set('test-auth-code', {
      token: 'svl_realtoken',
      codeChallenge: challenge,
      redirectUri: 'http://localhost:8080/callback',
      clientId: 'test-client',
      expiresAt: Date.now() + 60_000,
    })

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'test-auth-code',
        redirect_uri: 'http://localhost:8080/callback',
        client_id: 'test-client',
        code_verifier: verifier,
      }).toString(),
    })

    strictEqual(res.status, 200)
    const body = await res.json()
    strictEqual(body.access_token, 'svl_realtoken')
    strictEqual(body.token_type, 'bearer')
    strictEqual(authCodes.has('test-auth-code'), false)
  })

  it('rejects invalid PKCE verifier', async () => {
    const challenge = createHash('sha256').update('correct-verifier').digest('base64url')

    authCodes.set('pkce-fail-code', {
      token: 'svl_token',
      codeChallenge: challenge,
      redirectUri: 'http://localhost:8080/callback',
      clientId: 'test-client',
      expiresAt: Date.now() + 60_000,
    })

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'pkce-fail-code',
        redirect_uri: 'http://localhost:8080/callback',
        client_id: 'test-client',
        code_verifier: 'wrong-verifier',
      }).toString(),
    })

    strictEqual(res.status, 400)
    const body = await res.json()
    strictEqual(body.error, 'invalid_grant')
    authCodes.delete('pkce-fail-code')
  })

  it('rejects mismatched redirect_uri', async () => {
    const verifier = 'test-verifier'
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    authCodes.set('redirect-fail-code', {
      token: 'svl_token',
      codeChallenge: challenge,
      redirectUri: 'http://localhost:8080/callback',
      clientId: 'test-client',
      expiresAt: Date.now() + 60_000,
    })

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'redirect-fail-code',
        redirect_uri: 'http://evil.com/callback',
        client_id: 'test-client',
        code_verifier: verifier,
      }).toString(),
    })

    strictEqual(res.status, 400)
    authCodes.delete('redirect-fail-code')
  })

  it('rejects expired auth code', async () => {
    const verifier = 'test-verifier-for-expiry'
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    authCodes.set('expired-auth-code', {
      token: 'svl_token',
      codeChallenge: challenge,
      redirectUri: 'http://localhost:8080/callback',
      clientId: 'test-client',
      expiresAt: Date.now() - 1000,
    })

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'expired-auth-code',
        redirect_uri: 'http://localhost:8080/callback',
        client_id: 'test-client',
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

    authCodes.set('client-mismatch-code', {
      token: 'svl_token',
      codeChallenge: challenge,
      redirectUri: 'http://localhost:8080/callback',
      clientId: 'client-a',
      expiresAt: Date.now() + 60_000,
    })

    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'client-mismatch-code',
        redirect_uri: 'http://localhost:8080/callback',
        client_id: 'client-b',
        code_verifier: verifier,
      }).toString(),
    })

    strictEqual(res.status, 400)
    authCodes.delete('client-mismatch-code')
  })

  it('rejects unknown auth code', async () => {
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'nonexistent',
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
