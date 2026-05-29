import { after, before, describe, it } from 'node:test'
import { throws } from 'node:assert'
import { signParams } from '../src/oauth.ts'

const prevEnv = process.env.NODE_ENV
const prevSecret = process.env.OAUTH_SECRET

before(() => {
  delete process.env.OAUTH_SECRET
  process.env.NODE_ENV = 'production'
})

after(() => {
  process.env.NODE_ENV = prevEnv
  if (prevSecret !== undefined) {
    process.env.OAUTH_SECRET = prevSecret
  }
})

describe('Integration: production refuses to run without OAUTH_SECRET', () => {
  it('throws when no OAUTH_SECRET is configured in production', () => {
    throws(() => signParams({ a: '1' }), /OAUTH_SECRET env var is required in production/)
  })
})
