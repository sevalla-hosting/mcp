import { randomBytes, createHash, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'

const SEVALLA_API_BASE = 'https://api.sevalla.com'
const SEVALLA_FRONTEND_URL = process.env.SEVALLA_FRONTEND_URL || 'https://app.sevalla.com'
const DEVICE_CODE_TTL_MS = 300_000

export const verifyPkce = (verifier: string, challenge: string): boolean =>
  createHash('sha256').update(verifier).digest('base64url') === challenge

let _secret: Buffer | undefined

const getSecret = (): Buffer => {
  if (!_secret) {
    const envSecret = process.env.OAUTH_SECRET
    if (envSecret) {
      _secret = Buffer.from(envSecret, 'base64url')
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error('OAUTH_SECRET env var is required in production')
    } else {
      console.warn('OAUTH_SECRET not set — using ephemeral key (not suitable for production)')
      _secret = randomBytes(32)
    }
  }
  return _secret
}

const deriveKey = (purpose: string): Buffer =>
  createHash('sha256')
    .update(Buffer.concat([getSecret(), Buffer.from(purpose)]))
    .digest()

export const signParams = (params: Record<string, string>): string => {
  const key = deriveKey('hmac')
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
  return createHmac('sha256', key).update(sorted).digest('base64url')
}

export const verifySignedParams = (params: Record<string, string>, sig: string): boolean => {
  const key = deriveKey('hmac')
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&')
  const expected = createHmac('sha256', key).update(sorted).digest()
  const actual = Buffer.from(sig, 'base64url')
  if (expected.length !== actual.length) {
    return false
  }
  return timingSafeEqual(expected, actual)
}

export const encrypt = (plaintext: string): string => {
  const key = deriveKey('aes')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted]).toString('base64url')
}

export const decrypt = (data: string): string => {
  const key = deriveKey('aes')
  const buf = Buffer.from(data, 'base64url')
  const iv = buf.subarray(0, 12)
  const authTag = buf.subarray(12, 28)
  const ciphertext = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

const getPublicUrl = () => process.env.PUBLIC_URL || 'https://mcp.sevalla.com'

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
    return c.json({ ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) }, 201)
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

    const params: Record<string, string> = {
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      client_id: q.client_id,
      state: q.state,
      expires_at: (Date.now() + DEVICE_CODE_TTL_MS).toString(),
    }
    const sig = signParams(params)

    const publicUrl = getPublicUrl()
    const callbackUrl = new URL(`${publicUrl}/oauth/callback/${deviceCode}`)
    for (const [k, v] of Object.entries(params)) {
      callbackUrl.searchParams.set(k, v)
    }
    callbackUrl.searchParams.set('sig', sig)

    const sevallaUrl = new URL('/authorize', SEVALLA_FRONTEND_URL)
    sevallaUrl.searchParams.set('code', deviceCode)
    sevallaUrl.searchParams.set('name', 'Sevalla MCP')
    sevallaUrl.searchParams.set('callback', callbackUrl.toString())

    return c.redirect(sevallaUrl.toString(), 302)
  })

  router.get('/oauth/callback/:deviceCode', async (c) => {
    const deviceCode = c.req.param('deviceCode')
    const q = c.req.query()

    if (!q.sig || !q.redirect_uri || !q.code_challenge || !q.client_id || !q.state || !q.expires_at) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const params = {
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      client_id: q.client_id,
      state: q.state,
      expires_at: q.expires_at,
    }

    if (!verifySignedParams(params, q.sig)) {
      return c.json({ error: 'invalid_signature' }, 403)
    }

    if (Number(q.expires_at) <= Date.now()) {
      return c.json({ error: 'expired' }, 400)
    }

    const statusRes = await fetch(`${SEVALLA_API_BASE}/v3/auth/device-codes/${deviceCode}`)
    if (!statusRes.ok) {
      return c.json({ error: 'device_code_poll_failed' }, 502)
    }

    const { status, token } = (await statusRes.json()) as { status: string; token?: string }
    const redirectUrl = new URL(q.redirect_uri)
    redirectUrl.searchParams.set('state', q.state)

    if (status === 'approved' && token) {
      const payload = JSON.stringify({
        token,
        code_challenge: q.code_challenge,
        redirect_uri: q.redirect_uri,
        client_id: q.client_id,
        expires_at: Date.now() + 60_000,
      })
      const code = encrypt(payload)
      redirectUrl.searchParams.set('code', code)
      return c.redirect(redirectUrl.toString(), 302)
    }

    redirectUrl.searchParams.set('error', 'access_denied')
    return c.redirect(redirectUrl.toString(), 302)
  })

  router.post('/oauth/token', async (c) => {
    const body = await c.req.parseBody()
    const grantType = body.grant_type as string
    const code = body.code as string
    const redirectUri = body.redirect_uri as string
    const clientId = body.client_id as string
    const codeVerifier = body.code_verifier as string

    if (grantType !== 'authorization_code' || !code || !redirectUri || !clientId || !codeVerifier) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    let stored: { token: string; code_challenge: string; redirect_uri: string; client_id: string; expires_at: number }
    try {
      stored = JSON.parse(decrypt(code))
    } catch {
      return c.json({ error: 'invalid_grant' }, 400)
    }

    if (stored.expires_at <= Date.now()) {
      return c.json({ error: 'invalid_grant' }, 400)
    }

    if (stored.redirect_uri !== redirectUri || stored.client_id !== clientId) {
      return c.json({ error: 'invalid_grant' }, 400)
    }

    if (!verifyPkce(codeVerifier, stored.code_challenge)) {
      return c.json({ error: 'invalid_grant' }, 400)
    }

    return c.json({ access_token: stored.token, token_type: 'bearer' })
  })

  return router
}
