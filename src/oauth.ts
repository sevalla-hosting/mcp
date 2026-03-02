import { randomBytes, createHash } from 'node:crypto'

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
