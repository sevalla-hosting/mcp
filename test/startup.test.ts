import { after, before, describe, it } from 'node:test'
import { ok, rejects, strictEqual } from 'node:assert'
import { randomBytes } from 'node:crypto'
import { loadSpec } from '../src/index.ts'
import { signParams, verifySignedParams } from '../src/oauth.ts'

const realFetch = globalThis.fetch

before(() => {
  process.env.OAUTH_SECRET = randomBytes(32).toString('base64url')
})

after(() => {
  globalThis.fetch = realFetch
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

describe('Integration: OpenAPI spec loading at startup', () => {
  it('throws on a failed spec fetch and resets so a later attempt can recover', async () => {
    let attempt = 0
    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (!url.includes('/openapi.json')) {
        throw new Error(`unexpected fetch: ${url}`)
      }
      attempt++
      if (attempt === 1) {
        return new Response('nope', { status: 503, statusText: 'Service Unavailable' })
      }
      return new Response(JSON.stringify({ openapi: '3.0.0', paths: {} }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    await rejects(() => loadSpec(), /Failed to fetch OpenAPI spec: 503/)

    const spec = await loadSpec()
    ok(spec)
    strictEqual(attempt, 2)
  })
})
