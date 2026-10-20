import { randomBytes, createHash, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import {
  ClientMetadataError,
  ClientMetadataUnavailableError,
  isClientMetadataUrl,
  resolveClientMetadata,
} from './client-metadata.ts'
import { getApiBaseUrl, mcpClientName, SEVALLA_CLIENT_HEADER } from './sevalla/client.ts'

export const MCP_PATHS = ['/mcp'] as const

const SEVALLA_FRONTEND_URL = process.env.SEVALLA_FRONTEND_URL || 'https://app.sevalla.com'
const DEVICE_CODE_TTL_MS = 300_000
const MAX_OAUTH_BODY_BYTES = 16_384
const MCP_SCOPE = 'mcp:tools'
const CODE_KEY = 'aes:code'
const ACCESS_TOKEN_KEY = 'aes:access'
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

const serializeParams = (params: Record<string, string>): string =>
  Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&')

export const signParams = (params: Record<string, string>): string => {
  const key = deriveKey('hmac')
  return createHmac('sha256', key).update(serializeParams(params)).digest('base64url')
}

export const verifySignedParams = (params: Record<string, string>, sig: string): boolean => {
  const key = deriveKey('hmac')
  const expected = createHmac('sha256', key).update(serializeParams(params)).digest()
  const actual = Buffer.from(sig, 'base64url')
  if (expected.length !== actual.length) {
    return false
  }
  return timingSafeEqual(expected, actual)
}

export const encrypt = (plaintext: string, purpose = 'aes'): string => {
  const key = deriveKey(purpose)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted]).toString('base64url')
}

export const decrypt = (data: string, purpose = 'aes'): string => {
  const key = deriveKey(purpose)
  const buf = Buffer.from(data, 'base64url')
  const iv = buf.subarray(0, 12)
  const authTag = buf.subarray(12, 28)
  const ciphertext = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export const getPublicUrl = () => process.env.PUBLIC_URL || 'https://mcp.sevalla.com'

export const getProtectedResourceUrl = (resourcePath = '/mcp') =>
  `${getPublicUrl()}/.well-known/oauth-protected-resource${resourcePath}`

export const getBearerAuthChallenge = (resourcePath = '/mcp', error?: string) =>
  `Bearer resource_metadata="${getProtectedResourceUrl(resourcePath)}", scope="${MCP_SCOPE}"${error ? `, error="${error}"` : ''}`

const getProtectedResourceMetadata = (resourcePath = '/mcp') => {
  const url = getPublicUrl()
  return {
    resource: `${url}${resourcePath}`,
    resource_name: 'Sevalla',
    authorization_servers: [url],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
  }
}

const getAuthorizationServerMetadata = () => {
  const url = getPublicUrl()
  return {
    issuer: url,
    authorization_endpoint: `${url}/oauth/authorize`,
    token_endpoint: `${url}/oauth/token`,
    registration_endpoint: `${url}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [MCP_SCOPE],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  }
}

export const getResourceUrl = () => `${getPublicUrl()}/mcp`

export const isAcceptedResource = (value: unknown): boolean => {
  if (value === undefined || value === '') {
    return true
  }
  const resource = getResourceUrl()
  const publicUrl = getPublicUrl()
  return typeof value === 'string' && [resource, `${resource}/`, publicUrl, `${publicUrl}/`].includes(value)
}

const ACCESS_TOKEN_PREFIX = 'smcp_'

export const issueAccessToken = (sevallaToken: string): string =>
  `${ACCESS_TOKEN_PREFIX}${encrypt(JSON.stringify({ type: 'access_token', token: sevallaToken, aud: getResourceUrl() }), ACCESS_TOKEN_KEY)}`

export const resolveBearerToken = (bearer: string): string | undefined => {
  if (!bearer.startsWith(ACCESS_TOKEN_PREFIX)) {
    return bearer
  }
  try {
    const payload = JSON.parse(decrypt(bearer.slice(ACCESS_TOKEN_PREFIX.length), ACCESS_TOKEN_KEY))
    return payload.type === 'access_token' && payload.aud === getResourceUrl() && typeof payload.token === 'string'
      ? payload.token
      : undefined
  } catch {
    return undefined
  }
}

export const decryptClientId = (clientId: string): { redirect_uris: string[] } => {
  const parsed = JSON.parse(decrypt(clientId))
  if (parsed.type !== 'registration' || !Array.isArray(parsed.redirect_uris)) {
    throw new Error('invalid client_id payload')
  }
  return { redirect_uris: parsed.redirect_uris }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const BLOCKED_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
  'ftp:',
  'ws:',
  'wss:',
])

export const validateRedirectUri = (uri: string): boolean => {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  if (url.hash) {
    return false
  }
  if (url.protocol === 'https:') {
    return true
  }
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname)
  }
  return !BLOCKED_SCHEMES.has(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol)
}

export const redirectUriMatches = (registered: string, requested: string): boolean => {
  if (registered === requested) {
    return true
  }
  try {
    const a = new URL(registered)
    const b = new URL(requested)
    return (
      a.protocol === 'http:' &&
      b.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(a.hostname) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    )
  } catch {
    return false
  }
}

const MAX_CLIENT_NAME_LENGTH = 40

export const describeClient = (redirectUri: string, clientName?: string): string => {
  const url = new URL(redirectUri)
  const target = url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : `${url.protocol}//${url.host}`
  const name = (clientName ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CLIENT_NAME_LENGTH)
    .trim()
  return name ? `${target} - ${name}` : target
}

interface AuthorizingClient {
  name?: string
  redirectUris: string[]
}

const resolveAuthorizingClient = async (clientId: string, requester: string): Promise<AuthorizingClient> => {
  if (isClientMetadataUrl(clientId)) {
    const metadata = await resolveClientMetadata(clientId, requester)
    return { name: metadata.clientName, redirectUris: metadata.redirectUris }
  }
  return { redirectUris: decryptClientId(clientId).redirect_uris }
}

const trustedProxyHops = () => {
  const hops = parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10)
  return Number.isInteger(hops) && hops >= 1 ? hops : 1
}

export const getClientIp = (c: Context): string | undefined => {
  const header = (process.env.CLIENT_IP_HEADER || 'x-forwarded-for').toLowerCase()
  const entries = (c.req.header(header) ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  const candidate =
    header === 'x-forwarded-for' ? entries[entries.length - trustedProxyHops()] : entries[entries.length - 1]
  if (candidate && isIP(candidate)) {
    return candidate
  }
  try {
    const address = getConnInfo(c).remote.address
    return address && isIP(address) ? address : undefined
  } catch {
    return undefined
  }
}

const trustedClientHeaders = (c: Context): Record<string, string> => {
  const token = process.env.DEVICE_CODE_TRUSTED_CLIENT_TOKEN
  const ip = token ? getClientIp(c) : undefined
  return token && ip ? { 'x-sevalla-service-token': token, 'x-sevalla-client-ip': ip } : {}
}

export const createOAuthRouter = () => {
  const router = new Hono()

  router.use(
    '/oauth/*',
    bodyLimit({
      maxSize: MAX_OAUTH_BODY_BYTES,
      onError: (c) => c.json({ error: 'invalid_request', error_description: 'The request body is too large.' }, 413),
    }),
  )

  router.get('/.well-known/oauth-protected-resource', (c) => c.json(getProtectedResourceMetadata()))
  router.get('/.well-known/oauth-authorization-server', (c) => c.json(getAuthorizationServerMetadata()))
  for (const path of MCP_PATHS) {
    router.get(`/.well-known/oauth-protected-resource${path}`, (c) => c.json(getProtectedResourceMetadata(path)))
    router.get(`${path}/.well-known/oauth-protected-resource`, (c) => c.json(getProtectedResourceMetadata(path)))
    router.get(`/.well-known/oauth-authorization-server${path}`, (c) => c.json(getAuthorizationServerMetadata()))
    router.get(`${path}/.well-known/oauth-authorization-server`, (c) => c.json(getAuthorizationServerMetadata()))
  }

  router.post('/oauth/register', async (c) => {
    const body = await c.req.json()
    const redirectUris: unknown = body.redirect_uris
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return c.json({ error: 'invalid_redirect_uris' }, 400)
    }
    for (const uri of redirectUris) {
      if (typeof uri !== 'string' || !validateRedirectUri(uri)) {
        return c.json({ error: 'invalid_redirect_uris' }, 400)
      }
    }
    const clientId = encrypt(JSON.stringify({ type: 'registration', redirect_uris: redirectUris }))
    return c.json(
      {
        client_id: clientId,
        client_name: body.client_name,
        redirect_uris: redirectUris,
        client_id_issued_at: Math.floor(Date.now() / 1000),
      },
      201,
    )
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

    if (!validateRedirectUri(q.redirect_uri)) {
      return c.json({ error: 'invalid_redirect_uri' }, 400)
    }

    if (!isAcceptedResource(q.resource)) {
      return c.json({ error: 'invalid_target' }, 400)
    }

    let client: AuthorizingClient
    try {
      client = await resolveAuthorizingClient(q.client_id, getClientIp(c) ?? 'unknown')
    } catch (err) {
      if (err instanceof ClientMetadataUnavailableError) {
        return c.json({ error: 'temporarily_unavailable', error_description: err.message }, err.status)
      }
      if (err instanceof ClientMetadataError) {
        return c.json(
          { error: 'invalid_client', error_description: `The client metadata document ${err.message}.` },
          401,
        )
      }
      return c.json({ error: 'invalid_client' }, 401)
    }

    if (!client.redirectUris.some((uri) => redirectUriMatches(uri, q.redirect_uri as string))) {
      return c.json({ error: 'invalid_redirect_uri' }, 400)
    }

    const deviceCodeRes = await fetch(`${getApiBaseUrl()}/v3/auth/device-codes`, {
      method: 'POST',
      headers: {
        ...trustedClientHeaders(c),
        [SEVALLA_CLIENT_HEADER]: mcpClientName(describeClient(q.redirect_uri, client.name)),
      },
    })
    if (!deviceCodeRes.ok) {
      return c.json({ error: 'device_code_request_failed' }, 502)
    }

    const { code: deviceCode } = (await deviceCodeRes.json()) as { code: string }

    const params: Record<string, string> = {
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      client_id: q.client_id,
      state: q.state,
      device_code: deviceCode,
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
    sevallaUrl.searchParams.set('name', `Sevalla MCP (${describeClient(q.redirect_uri, client.name)})`)
    sevallaUrl.searchParams.set('callback', callbackUrl.toString())

    return c.redirect(sevallaUrl.toString(), 302)
  })

  router.get('/oauth/callback/:deviceCode', async (c) => {
    const deviceCode = c.req.param('deviceCode')
    const q = c.req.query()

    if (!q.sig || !q.redirect_uri || !q.code_challenge || !q.client_id || !q.state || !q.expires_at || !q.device_code) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const params = {
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      client_id: q.client_id,
      state: q.state,
      device_code: q.device_code,
      expires_at: q.expires_at,
    }

    if (!verifySignedParams(params, q.sig)) {
      return c.json({ error: 'invalid_signature' }, 403)
    }

    if (q.device_code !== deviceCode) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    if (Number(q.expires_at) <= Date.now()) {
      return c.json({ error: 'expired' }, 400)
    }

    const statusRes = await fetch(`${getApiBaseUrl()}/v3/auth/device-codes/${encodeURIComponent(deviceCode)}`, {
      headers: trustedClientHeaders(c),
    })
    if (!statusRes.ok) {
      return c.json({ error: 'device_code_poll_failed' }, 502)
    }

    const { status, token } = (await statusRes.json()) as { status: string; token?: string }
    const redirectUrl = new URL(q.redirect_uri)
    redirectUrl.searchParams.set('state', q.state)
    redirectUrl.searchParams.set('iss', getPublicUrl())

    if (status === 'approved' && token) {
      const payload = JSON.stringify({
        type: 'authorization_code',
        token,
        code_challenge: q.code_challenge,
        redirect_uri: q.redirect_uri,
        client_id: q.client_id,
        expires_at: Date.now() + 60_000,
      })
      const code = encrypt(payload, CODE_KEY)
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

    if (grantType && grantType !== 'authorization_code') {
      return c.json({ error: 'unsupported_grant_type' }, 400)
    }
    if (!grantType || !code || !redirectUri || !clientId || !codeVerifier) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    if (!isAcceptedResource(body.resource)) {
      return c.json({ error: 'invalid_target' }, 400)
    }

    let stored: {
      type?: string
      token: string
      code_challenge: string
      redirect_uri: string
      client_id: string
      expires_at: number
    }
    try {
      stored = JSON.parse(decrypt(code, CODE_KEY))
    } catch {
      return c.json({ error: 'invalid_grant' }, 400)
    }

    if (stored.type !== 'authorization_code' || !(stored.expires_at > Date.now())) {
      return c.json({ error: 'invalid_grant' }, 400)
    }

    if (stored.redirect_uri !== redirectUri || stored.client_id !== clientId) {
      return c.json({ error: 'invalid_grant' }, 400)
    }

    if (!verifyPkce(codeVerifier, stored.code_challenge)) {
      return c.json({ error: 'invalid_grant' }, 400)
    }

    return c.json({ access_token: issueAccessToken(stored.token), token_type: 'bearer', scope: MCP_SCOPE })
  })

  return router
}
