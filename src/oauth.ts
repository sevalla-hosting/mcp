import { randomBytes, createHash } from 'node:crypto'
import { Hono } from 'hono'

const SEVALLA_API_BASE = 'https://api.sevalla.com'
const SEVALLA_FRONTEND_URL = process.env.SEVALLA_FRONTEND_URL || 'https://app.sevalla.com'
const DEVICE_CODE_TTL_MS = 300_000

export const verifyPkce = (verifier: string, challenge: string): boolean =>
  createHash('sha256').update(verifier).digest('base64url') === challenge

export const generateAuthCode = (): string => randomBytes(32).toString('base64url')

interface PendingAuthorization {
  redirectUri: string
  codeChallenge: string
  clientId: string
  state: string
  expiresAt: number
}

interface StoredAuthCode {
  token: string
  codeChallenge: string
  redirectUri: string
  clientId: string
  expiresAt: number
}

export const pendingAuthorizations = new Map<string, PendingAuthorization>()
export const authCodes = new Map<string, StoredAuthCode>()

export const cleanupExpired = () => {
  const now = Date.now()
  for (const [key, val] of pendingAuthorizations) {
    if (val.expiresAt <= now) pendingAuthorizations.delete(key)
  }
  for (const [key, val] of authCodes) {
    if (val.expiresAt <= now) authCodes.delete(key)
  }
}

const cleanupTimer = setInterval(cleanupExpired, 30_000)
cleanupTimer.unref()

const getPublicUrl = () => process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3000'}`

export const createOAuthRouter = () => {
  const router = new Hono()

  router.get('/.well-known/oauth-protected-resource', (c) => {
    const url = getPublicUrl()
    return c.json({
      resource: `${url}/mcp`,
      authorization_servers: [url],
      scopes_supported: ['mcp:tools'],
    })
  })

  router.get('/.well-known/oauth-authorization-server', (c) => {
    const url = getPublicUrl()
    return c.json({
      issuer: url,
      authorization_endpoint: `${url}/oauth/authorize`,
      token_endpoint: `${url}/oauth/token`,
      registration_endpoint: `${url}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
    })
  })

  router.post('/oauth/register', async (c) => {
    const body = await c.req.json()
    const clientId = body.client_id || randomBytes(16).toString('hex')
    return c.json({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) }, 201)
  })

  router.get('/oauth/authorize', async (c) => {
    const q = c.req.query()
    if (
      q.response_type !== 'code' ||
      !q.client_id ||
      !q.redirect_uri ||
      !q.code_challenge ||
      q.code_challenge_method !== 'S256' ||
      !q.state
    ) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const deviceCodeRes = await fetch(`${SEVALLA_API_BASE}/v3/auth/device-codes`, { method: 'POST' })
    if (!deviceCodeRes.ok) {
      return c.json({ error: 'device_code_request_failed' }, 502)
    }

    const { code: deviceCode } = (await deviceCodeRes.json()) as { code: string }

    pendingAuthorizations.set(deviceCode, {
      redirectUri: q.redirect_uri,
      codeChallenge: q.code_challenge,
      clientId: q.client_id,
      state: q.state,
      expiresAt: Date.now() + DEVICE_CODE_TTL_MS,
    })

    const publicUrl = getPublicUrl()
    const callbackUrl = `${publicUrl}/oauth/callback/${deviceCode}`
    const sevallaUrl = new URL('/authorize', SEVALLA_FRONTEND_URL)
    sevallaUrl.searchParams.set('code', deviceCode)
    sevallaUrl.searchParams.set('name', 'Sevalla MCP')
    sevallaUrl.searchParams.set('callback', callbackUrl)

    return c.redirect(sevallaUrl.toString(), 302)
  })

  router.get('/oauth/callback/:deviceCode', async (c) => {
    const deviceCode = c.req.param('deviceCode')
    const pending = pendingAuthorizations.get(deviceCode)
    if (!pending) {
      return c.json({ error: 'unknown_device_code' }, 404)
    }

    const statusRes = await fetch(`${SEVALLA_API_BASE}/v3/auth/device-codes/${deviceCode}`)
    if (!statusRes.ok) {
      return c.json({ error: 'device_code_poll_failed' }, 502)
    }

    const { status, token } = (await statusRes.json()) as { status: string; token?: string }
    const redirectUrl = new URL(pending.redirectUri)
    redirectUrl.searchParams.set('state', pending.state)

    if (status === 'approved' && token) {
      const code = generateAuthCode()
      authCodes.set(code, {
        token,
        codeChallenge: pending.codeChallenge,
        redirectUri: pending.redirectUri,
        clientId: pending.clientId,
        expiresAt: Date.now() + 60_000,
      })
      pendingAuthorizations.delete(deviceCode)
      redirectUrl.searchParams.set('code', code)
      return c.redirect(redirectUrl.toString(), 302)
    }

    pendingAuthorizations.delete(deviceCode)
    redirectUrl.searchParams.set('error', 'access_denied')
    return c.redirect(redirectUrl.toString(), 302)
  })

  return router
}
