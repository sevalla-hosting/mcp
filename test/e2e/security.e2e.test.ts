import { after, before, beforeEach, describe, it } from 'node:test'
import { ok, strictEqual } from 'node:assert'
import { IDS, SECRET_VALUE } from '../support/fake-api.ts'
import { startHarness, type Harness, type McpSession } from '../support/harness.ts'

let h: Harness
let mcp: McpSession

before(async () => {
  h = await startHarness()
  mcp = await h.connect()
})

after(async () => {
  await h.close()
})

beforeEach(() => {
  h.api.reset()
})

const upstreamCalls = () => h.api.requests.length

describe('e2e security: request construction', () => {
  for (const value of ['../../applications/x', 'abc/def', 'abc?x=1', '..', 'a#b', 'a\\b']) {
    it(`rejects the free-form path parameter ${JSON.stringify(value)} without calling the API`, async () => {
      const res = await mcp.call('sevalla_api_delete', {
        operation_id: 'deleteDatabaseBackupV3',
        path_params: { id: IDS.db, backup_id: value },
      })
      strictEqual(res.isError, true)
      strictEqual(upstreamCalls(), 0)
    })
  }

  it('rejects operation IDs that are not plain identifiers', async () => {
    const res = await mcp.call('sevalla_api_read', { operation_id: '../../v2/applications' })
    strictEqual(res.isError, true)
    strictEqual(upstreamCalls(), 0)
  })

  it('rejects unknown query parameters and bodies on read operations', async () => {
    const query = await mcp.call('sevalla_api_read', { operation_id: 'listProjectsV3', query: { admin: true } })
    strictEqual(query.isError, true)
    ok(query.text.includes('Unknown query parameter'))
    const body = await mcp.call('sevalla_api_read', { operation_id: 'listProjectsV3', body: { x: 1 } })
    strictEqual(body.isError, true)
    strictEqual(upstreamCalls(), 0)
  })

  it('rejects a body on operations that take none', async () => {
    const res = await mcp.call('sevalla_api_update', {
      operation_id: 'suspendApplicationV3',
      path_params: { id: IDS.app },
      body: { force: true },
    })
    strictEqual(res.isError, true)
    ok(res.text.includes('takes no request body'))
  })

  it('only ever calls the configured Sevalla API host', async () => {
    await mcp.call('list_services')
    await mcp.call('sevalla_api_read', { operation_id: 'listProjectsV3' })
    ok(h.api.requests.length > 0)
    ok(h.api.requests.every((r) => r.path.startsWith('/v3/')))
  })
})

describe('e2e security: environment variable values and secret issuance', () => {
  it('withholds stored environment variable values', async () => {
    for (const args of [
      { scope: 'application', service_id: IDS.app },
      { scope: 'static_site', service_id: IDS.site },
      { scope: 'global' },
    ]) {
      const res = await mcp.call('list_environment_variables', args)
      strictEqual(res.isError, false)
      ok(!res.text.includes(SECRET_VALUE))
      ok(!res.text.includes('https://api.example.com'))
      ok(!res.text.includes('sentry.example.com'))
    }
  })

  it('refuses the raw environment variable operations on the generic tools', async () => {
    const res = await mcp.call('sevalla_api_read', {
      operation_id: 'listEnvironmentVariablesV3',
      path_params: { id: IDS.app },
    })
    strictEqual(res.isError, true)
    ok(res.text.includes('list_environment_variables'))
    strictEqual(upstreamCalls(), 0)
  })

  it('refuses sign-in plumbing and the terminal WebSocket', async () => {
    const cases: [string, string, Record<string, string>][] = [
      ['sevalla_api_create', 'createDeviceCodeV3', {}],
      ['sevalla_api_read', 'pollDeviceCodeV3', { code: 'ABC' }],
      ['sevalla_api_read', 'openTerminalV3', { id: IDS.app, process_id: IDS.process }],
    ]
    for (const [tool, operation_id, path_params] of cases) {
      const res = await mcp.call(tool, {
        operation_id,
        ...(Object.keys(path_params).length > 0 ? { path_params } : {}),
      })
      strictEqual(res.isError, true, operation_id)
      ok(res.text.includes('not available as a tool'), operation_id)
    }
    strictEqual(upstreamCalls(), 0)
  })

  it('creates API keys through the destructive tool and returns the token', async () => {
    h.api.override('createApiKeyV3', () => ({ status: 201, body: { id: 'key-2', token: 'svl_new_token', name: 'CI' } }))
    const res = await mcp.call('sevalla_api_update', {
      operation_id: 'createApiKeyV3',
      body: { name: 'CI', role_ids: [] },
    })
    strictEqual(res.isError, false)
    strictEqual(res.json.token, 'svl_new_token')
  })

  it('returns a newly issued secret from an approved rotation', async () => {
    h.api.override('rollWebhookSecretV3', () => ({
      body: { id: 'wh-1', secret: 'whsec_new', old_secret: 'whsec_old' },
    }))
    const res = await mcp.call('sevalla_api_update', {
      operation_id: 'rollWebhookSecretV3',
      path_params: { id: IDS.app },
      body: {},
    })
    strictEqual(res.isError, false)
    strictEqual(res.json.secret, 'whsec_new')
  })
})
