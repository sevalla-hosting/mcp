import { after, before, describe, it } from 'node:test'
import { ok, strictEqual } from 'node:assert'
import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const API_KEY = process.env.SEVALLA_E2E_API_KEY

let server: ServerType
let client: Client

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[]
    isError?: boolean
  }
  const text = result.content.map((c) => c.text).join('\n')
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { isError: result.isError === true, text, json }
}

describe(
  'live smoke test against the Sevalla API (read-only tools)',
  { skip: !API_KEY && 'SEVALLA_E2E_API_KEY is not set' },
  () => {
    before(async () => {
      delete process.env.SEVALLA_API_URL
      delete process.env.SEVALLA_DOCS_URL
      const { app } = await import('../../src/index.ts')
      server = await new Promise((resolve) => {
        const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s))
      })
      const { port } = server.address() as AddressInfo
      client = new Client({ name: 'sevalla-live-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${API_KEY}` } },
        }),
      )
    })

    after(async () => {
      await client?.close()
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    })

    it('negotiates the 2026-07-28 protocol and lists the tools', async () => {
      strictEqual(client.getNegotiatedProtocolVersion(), '2026-07-28')
      const { tools } = await client.listTools()
      strictEqual(tools.length, 27)
    })

    it('lists services and platform options', async () => {
      const services = await call('list_services', { limit: 5 })
      strictEqual(services.isError, false, services.text)
      ok(typeof services.json.applications.total === 'number')
      const options = await call('get_platform_options')
      strictEqual(options.isError, false, options.text)
      ok(options.json.clusters.length > 0)
    })

    it('searches the API reference and the documentation', async () => {
      const search = await call('sevalla_api_search', { query: 'list projects' })
      ok(search.json.results.some((r: any) => r.operation_id === 'listProjectsV3'))
      const projects = await call('sevalla_api_read', { operation_id: 'listProjectsV3', query: { limit: 5 } })
      strictEqual(projects.isError, false, projects.text)
      const docs = await call('search_sevalla_docs', { query: 'custom domain' })
      strictEqual(docs.isError, false, docs.text)
      ok(docs.json.results.length > 0)
    })

    it('reads the first application end to end', async (t) => {
      const services = await call('list_services', { type: 'application', limit: 1 })
      const app = services.json.applications.items[0]
      if (!app) {
        t.skip('the account has no applications')
        return
      }
      const detail = await call('get_application', { application_id: app.id })
      strictEqual(detail.isError, false, detail.text)
      const deployments = await call('list_deployments', { service_type: 'application', service_id: app.id, limit: 1 })
      strictEqual(deployments.isError, false, deployments.text)
      const latest = deployments.json.deployments[0]
      if (latest) {
        const logs = await call('get_deployment_logs', {
          service_type: 'application',
          service_id: app.id,
          deployment_id: latest.id,
          limit: 20,
        })
        strictEqual(logs.isError, false, logs.text)
      }
      const runtime = await call('search_runtime_logs', { application_id: app.id, limit: 20 })
      strictEqual(runtime.isError, false, runtime.text)
      const metrics = await call('get_metrics', { target: 'application', application_id: app.id })
      strictEqual(metrics.isError, false, metrics.text)
      const env = await call('list_environment_variables', { scope: 'application', service_id: app.id })
      strictEqual(env.isError, false, env.text)
      ok(env.json.variables.every((v: any) => v.value === undefined))
    })
  },
)
