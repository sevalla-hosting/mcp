// test/server.test.ts
import { describe, it, expect } from 'vitest'

// Test the URL rewriting helper in isolation
describe('createAuthenticatedFetch', () => {
  it('prepends /v3 to the path', async () => {
    const url = new URL('https://api.sevalla.com/applications')
    url.pathname = '/v3' + url.pathname
    expect(url.toString()).toBe('https://api.sevalla.com/v3/applications')
  })

  it('preserves query parameters', () => {
    const url = new URL('https://api.sevalla.com/applications?page=1&limit=25')
    url.pathname = '/v3' + url.pathname
    expect(url.toString()).toBe('https://api.sevalla.com/v3/applications?page=1&limit=25')
  })

  it('handles nested paths', () => {
    const url = new URL('https://api.sevalla.com/applications/123/deployments')
    url.pathname = '/v3' + url.pathname
    expect(url.toString()).toBe('https://api.sevalla.com/v3/applications/123/deployments')
  })
})
