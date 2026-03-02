import { describe, it } from 'node:test'
import { strictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { verifyPkce, generateAuthCode } from '../src/oauth.ts'

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
