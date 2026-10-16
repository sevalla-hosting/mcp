import { after, afterEach, before, describe, it, mock } from 'node:test'
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo, LookupFunction } from 'node:net'
import {
  __setClientMetadataFetcher,
  assertPublicAddresses,
  cacheTtl,
  ClientMetadataError,
  ClientMetadataUnavailableError,
  fetchClientMetadataDocument,
  isPublicAddress,
  parseClientMetadata,
  requesterKey,
  resolveClientMetadata,
  validateClientIdUrl,
} from '../src/client-metadata.ts'

const CLAUDE = {
  client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
  client_name: 'Claude',
  client_uri: 'https://claude.ai',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
}

const CHATGPT = {
  client_id: 'https://chatgpt.com/oauth/client.json',
  client_uri: 'https://chatgpt.com/',
  redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  token_endpoint_auth_method: 'private_key_jwt',
  token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  client_name: 'ChatGPT',
  jwks_uri: 'https://chatgpt.com/oauth/jwks.json',
}

const VSCODE = {
  client_name: 'Visual Studio Code',
  grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  application_type: 'native',
  client_id: 'https://vscode.dev/oauth/client-metadata.json',
  redirect_uris: ['http://127.0.0.1:33418/', 'https://vscode.dev/redirect'],
}

const documentFor = (clientId: string) =>
  JSON.stringify({ client_id: clientId, client_name: 'Test', redirect_uris: ['https://client.example/cb'] })

afterEach(() => {
  __setClientMetadataFetcher()
})

describe('client ID metadata documents: client_id URLs', () => {
  it('accepts the client IDs that Claude, ChatGPT and VS Code use', () => {
    for (const doc of [CLAUDE, CHATGPT, VSCODE]) {
      strictEqual(validateClientIdUrl(doc.client_id).href, doc.client_id)
    }
  })

  for (const [clientId, reason] of [
    ['http://example.com/client.json', 'https'],
    ['https://example.com/', 'path'],
    ['https://example.com', 'path'],
    ['https://example.com/client.json#frag', 'fragment'],
    ['https://user:pass@example.com/client.json', 'credentials'],
    ['https://example.com:8443/client.json', 'port'],
    ['https://example.com:22/client.json', 'port'],
    ['https://example.com/a/../client.json', 'normalized'],
    ['https://example.com/a/%2e%2e/client.json', 'normalized'],
    ['https://EXAMPLE.com/client.json', 'normalized'],
    ['https://example.com:443/client.json', 'normalized'],
    ['https://8.8.8.8/client.json', 'DNS host name'],
    ['https://10.0.0.8/client.json', 'DNS host name'],
    ['https://169.254.169.254/latest/meta-data', 'DNS host name'],
    ['https://[2606:4700::1]/client.json', 'DNS host name'],
    ['https://[::7f00:1]/client.json', 'DNS host name'],
    ['https://kubernetes/client.json', 'DNS host name'],
    ['https://localhost/client.json', 'DNS host name'],
    ['https://example.com./client.json', 'DNS host name'],
    ['not a url', 'valid URL'],
  ]) {
    it(`rejects ${clientId}`, () => {
      throws(
        () => validateClientIdUrl(clientId),
        (err: Error) => err instanceof ClientMetadataError && err.message.includes(reason),
      )
    })
  }
})

describe('client ID metadata documents: network guard', () => {
  it('classifies private, reserved and public addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      '::7f00:1',
      '::a9fe:a9fe',
      '::ffff:0:a9fe:a9fe',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:a9fe:a9fe',
      '64:ff9b::a00:1',
      '64:ff9b::7f00:1',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b::',
      '64:ff9b::1',
      '64:ff9b:1::a00:1',
      '64:ff9b::ffff:7f00:1',
      '64:ff9b:0:1::808:808',
      'fe80::1%lo0',
      'ff02::1',
      '2001:db8::1',
      'not-an-ip',
    ]) {
      strictEqual(isPublicAddress(address), false, address)
    }
    for (const address of [
      '1.1.1.1',
      '8.8.8.8',
      '104.18.0.1',
      '::ffff:1.1.1.1',
      '64:ff9b::96ab:6d64',
      '64:ff9b::150.171.109.100',
      '2606:4700::1',
      '2606:4700::6810:1',
      '2a00:1450:4001::200e',
    ]) {
      strictEqual(isPublicAddress(address), true, address)
    }
  })

  it('refuses a host when any of its addresses is not public', () => {
    deepStrictEqual(assertPublicAddresses('client.example', [{ address: '104.18.0.1', family: 4 }]), [
      { address: '104.18.0.1', family: 4 },
    ])
    throws(
      () =>
        assertPublicAddresses('client.example', [
          { address: '104.18.0.1', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ]),
      /does not resolve to a public address/,
    )
    throws(() => assertPublicAddresses('client.example', []), /did not resolve/)
  })

  it('reports hosts that cannot be reached without revealing why', async () => {
    const warn = mock.method(console, 'warn', () => undefined)
    try {
      await rejects(
        () => fetchClientMetadataDocument(new URL('https://localhost/client.json')),
        (err: Error) => err instanceof ClientMetadataError && err.message === 'could not be fetched',
      )
      strictEqual(warn.mock.callCount(), 1)
    } finally {
      warn.mock.restore()
    }
  })
})

describe('client ID metadata documents: fetching', () => {
  let server: Server
  let base: string
  const loopback: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: '127.0.0.1', family: 4 }])
      return
    }
    callback(null, '127.0.0.1', 4)
  }
  const transport = { request: httpRequest as never, lookup: loopback }
  const fetchPath = (path: string) => fetchClientMetadataDocument(new URL(`${base}${path}`), transport)

  before(async () => {
    server = createServer((req, res) => {
      const routes: Record<string, () => void> = {
        '/ok': () => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=120' })
          res.end(JSON.stringify(CLAUDE))
        },
        '/redirect': () => {
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
          res.end()
        },
        '/missing': () => {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end('{}')
        },
        '/html': () => {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<html></html>')
        },
        '/declared-large': () => {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '10000' })
          res.end('x'.repeat(10_000))
        },
        '/streamed-large': () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.write('x'.repeat(4_000))
          res.end('x'.repeat(4_000))
        },
      }
      ;(routes[req.url ?? ''] ?? routes['/missing'])()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://metadata.example:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('returns the document body with the cache lifetime from its headers', async () => {
    const document = await fetchPath('/ok')
    deepStrictEqual(JSON.parse(document.body), CLAUDE)
    strictEqual(document.ttlMs, 120_000)
  })

  it('never follows redirects and hides upstream status codes', async () => {
    const warn = mock.method(console, 'warn', () => undefined)
    try {
      for (const path of ['/redirect', '/missing']) {
        await rejects(
          () => fetchPath(path),
          (err: Error) => err instanceof ClientMetadataError && err.message === 'could not be fetched',
          path,
        )
      }
      ok(warn.mock.calls.some((call) => String(call.arguments[0]).includes('HTTP 302')))
    } finally {
      warn.mock.restore()
    }
  })

  it('rejects documents that are not JSON or larger than 5 KB', async () => {
    await rejects(() => fetchPath('/html'), /is not served as application\/json/)
    await rejects(() => fetchPath('/declared-large'), /is larger than 5 KB/)
    await rejects(() => fetchPath('/streamed-large'), /is larger than 5 KB/)
  })
})

describe('client ID metadata documents: validation', () => {
  it('accepts the documents that Claude, ChatGPT and VS Code publish', () => {
    for (const doc of [CLAUDE, CHATGPT, VSCODE]) {
      const metadata = parseClientMetadata(doc.client_id, JSON.stringify(doc))
      deepStrictEqual(metadata, {
        clientId: doc.client_id,
        clientName: doc.client_name,
        redirectUris: doc.redirect_uris,
      })
    }
  })

  for (const [name, doc, reason] of [
    ['a different client_id', { ...CLAUDE, client_id: 'https://evil.example/client.json' }, 'does not match'],
    ['no client_name', { ...CLAUDE, client_name: undefined }, 'client_name'],
    ['an empty client_name', { ...CLAUDE, client_name: '  ' }, 'client_name'],
    ['no redirect_uris', { ...CLAUDE, redirect_uris: [] }, 'redirect_uris'],
    ['non-string redirect_uris', { ...CLAUDE, redirect_uris: [42] }, 'redirect_uris'],
    ['a client secret', { ...CLAUDE, client_secret: 's3cret' }, 'client secret'],
    ['a shared-secret auth method', { ...CLAUDE, token_endpoint_auth_method: 'client_secret_basic' }, 'shared-secret'],
    ['no authorization_code grant', { ...CLAUDE, grant_types: ['client_credentials'] }, 'authorization_code'],
    ['no code response type', { ...CLAUDE, response_types: ['token'] }, 'code response type'],
  ] as const) {
    it(`rejects a document with ${name}`, () => {
      throws(
        () => parseClientMetadata(CLAUDE.client_id, JSON.stringify(doc)),
        (err: Error) => err instanceof ClientMetadataError && err.message.includes(reason),
      )
    })
  }

  it('rejects documents that are not JSON objects', () => {
    for (const body of ['not json', '[]', 'null', '"text"']) {
      throws(() => parseClientMetadata(CLAUDE.client_id, body), ClientMetadataError)
    }
  })
})

describe('client ID metadata documents: caching and limits', () => {
  it('derives the cache lifetime from Cache-Control', () => {
    strictEqual(cacheTtl('public, max-age=300'), 300_000)
    strictEqual(cacheTtl('no-store,no-cache,max-age=0'), 0)
    strictEqual(cacheTtl('max-age=0'), 0)
    strictEqual(cacheTtl('private, no-cache'), 0)
    strictEqual(cacheTtl('max-age=999999999'), 86_400_000)
    strictEqual(cacheTtl(undefined), 300_000)
    strictEqual(cacheTtl('public'), 300_000)
    strictEqual(cacheTtl('max-age=abc'), 0)
  })

  it('reuses a cached document until it expires', async () => {
    let fetches = 0
    __setClientMetadataFetcher(async () => {
      fetches += 1
      return { body: JSON.stringify(CLAUDE), ttlMs: 60_000 }
    })
    await resolveClientMetadata(CLAUDE.client_id)
    await resolveClientMetadata(CLAUDE.client_id)
    strictEqual(fetches, 1)
  })

  it('fetches uncacheable documents every time', async () => {
    let fetches = 0
    __setClientMetadataFetcher(async () => {
      fetches += 1
      return { body: JSON.stringify(VSCODE), ttlMs: 0 }
    })
    await resolveClientMetadata(VSCODE.client_id)
    await resolveClientMetadata(VSCODE.client_id)
    strictEqual(fetches, 2)
  })

  it('validates the client_id before fetching anything', async () => {
    let fetches = 0
    __setClientMetadataFetcher(async () => {
      fetches += 1
      return { body: '{}', ttlMs: 0 }
    })
    await rejects(() => resolveClientMetadata('https://10.0.0.8/client.json'), ClientMetadataError)
    strictEqual(fetches, 0)
  })

  it('remembers failures for a minute', async () => {
    let fetches = 0
    __setClientMetadataFetcher(async () => {
      fetches += 1
      return { body: JSON.stringify({ ...CLAUDE, client_id: 'https://evil.example/x' }), ttlMs: 60_000 }
    })
    await rejects(() => resolveClientMetadata(CLAUDE.client_id), /does not match/)
    await rejects(() => resolveClientMetadata(CLAUDE.client_id), /does not match/)
    strictEqual(fetches, 1)
  })

  it('shares one fetch between concurrent requests for the same client', async () => {
    let fetches = 0
    __setClientMetadataFetcher(async () => {
      fetches += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { body: JSON.stringify(VSCODE), ttlMs: 0 }
    })
    const results = await Promise.all([1, 2, 3].map(() => resolveClientMetadata(VSCODE.client_id)))
    strictEqual(fetches, 1)
    ok(results.every((r) => r.clientName === 'Visual Studio Code'))
  })

  it('caps concurrent fetches and answers the rest as temporarily unavailable', async () => {
    const releases: (() => void)[] = []
    let blocking = true
    __setClientMetadataFetcher(
      (url) =>
        new Promise((resolve) => {
          const release = () => resolve({ body: documentFor(url.href), ttlMs: 0 })
          if (blocking) {
            releases.push(release)
          } else {
            release()
          }
        }),
    )
    const pending = Array.from({ length: 8 }, (_, i) =>
      resolveClientMetadata(`https://client${i}.example/meta.json`, `requester-${i}`),
    )
    await rejects(
      () => resolveClientMetadata('https://client8.example/meta.json', 'requester-8'),
      (err: Error) => err instanceof ClientMetadataUnavailableError && err.status === 503,
    )
    blocking = false
    for (const release of releases) {
      release()
    }
    strictEqual((await Promise.all(pending)).length, 8)
    strictEqual((await resolveClientMetadata('https://client8.example/meta.json', 'requester-8')).clientName, 'Test')
  })

  it('counts IPv6 requesters per /64 and IPv4-mapped requesters as IPv4', () => {
    strictEqual(requesterKey('2001:db8:1:2::1'), '2001:db8:1:2::/64')
    strictEqual(requesterKey('2001:db8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64')
    strictEqual(requesterKey('2001:db8:1:3::1'), '2001:db8:1:3::/64')
    strictEqual(requesterKey('::ffff:203.0.113.7'), '203.0.113.7')
    strictEqual(requesterKey('203.0.113.7'), '203.0.113.7')
    strictEqual(requesterKey('fe80::1%en0'), 'fe80:0:0:0::/64')
    strictEqual(requesterKey('unknown'), 'unknown')
  })

  it('allows two fetches in flight per address', async () => {
    const releases: (() => void)[] = []
    __setClientMetadataFetcher(
      (url) =>
        new Promise((resolve) => {
          releases.push(() => resolve({ body: documentFor(url.href), ttlMs: 0 }))
        }),
    )
    const pending = [0, 1].map((i) => resolveClientMetadata(`https://slow${i}.example/meta.json`, '2001:db8:9:9::1'))
    await rejects(
      () => resolveClientMetadata('https://slow2.example/meta.json', '2001:db8:9:9::2'),
      (err: Error) => err instanceof ClientMetadataUnavailableError && err.status === 429,
    )
    const other = resolveClientMetadata('https://slow3.example/meta.json', '2001:db8:9:a::1')
    for (const release of releases) {
      release()
    }
    strictEqual((await Promise.all([...pending, other])).length, 3)
  })

  it('limits how many uncached documents one address can request per minute', async () => {
    __setClientMetadataFetcher(async (url) => ({ body: documentFor(url.href), ttlMs: 0 }))
    for (let i = 0; i < 30; i += 1) {
      await resolveClientMetadata(`https://client${i}.example/meta.json`, '203.0.113.7')
    }
    await rejects(
      () => resolveClientMetadata('https://client30.example/meta.json', '203.0.113.7'),
      (err: Error) => err instanceof ClientMetadataUnavailableError && err.status === 429,
    )
    strictEqual((await resolveClientMetadata('https://client30.example/meta.json', '198.51.100.9')).clientName, 'Test')
    await rejects(
      () => resolveClientMetadata('https://client31.example/meta.json', '::ffff:203.0.113.7'),
      (err: Error) => err instanceof ClientMetadataUnavailableError && err.status === 429,
    )
  })

  it('applies the per-minute limit to a whole IPv6 /64', async () => {
    __setClientMetadataFetcher(async (url) => ({ body: documentFor(url.href), ttlMs: 0 }))
    for (let i = 0; i < 30; i += 1) {
      await resolveClientMetadata(`https://v6client${i}.example/meta.json`, `2001:db8:1:2::${(i + 1).toString(16)}`)
    }
    await rejects(
      () => resolveClientMetadata('https://v6client30.example/meta.json', '2001:db8:1:2::ffff'),
      (err: Error) => err instanceof ClientMetadataUnavailableError && err.status === 429,
    )
    strictEqual(
      (await resolveClientMetadata('https://v6client30.example/meta.json', '2001:db8:1:3::1')).clientName,
      'Test',
    )
  })
})
