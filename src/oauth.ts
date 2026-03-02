import { randomBytes, createHash } from 'node:crypto'
import { Hono } from 'hono'

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

  return router
}
