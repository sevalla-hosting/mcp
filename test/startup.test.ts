import { after, before, describe, it } from 'node:test'
import { strictEqual } from 'node:assert'
import { randomBytes } from 'node:crypto'
import { signParams, verifySignedParams } from '../src/oauth.ts'

before(() => {
  process.env.OAUTH_SECRET = randomBytes(32).toString('base64url')
})

after(() => {
  delete process.env.OAUTH_SECRET
})

describe('Integration: OAUTH_SECRET configuration', () => {
  it('uses a provided secret to produce stable, verifiable signatures', () => {
    const params = { a: '1', b: '2' }
    const sig = signParams(params)
    strictEqual(signParams(params), sig)
    strictEqual(verifySignedParams(params, sig), true)
  })
})
