import { describe, it } from 'node:test'
import { strictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { verifyPkce, generateAuthCode, pendingAuthorizations, authCodes, cleanupExpired } from '../src/oauth.ts'

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
