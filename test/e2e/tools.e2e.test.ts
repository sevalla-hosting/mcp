import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert'
import { IDS, SECRET_VALUE, TOKENS } from '../support/fake-api.ts'
import { getOperation, OPERATIONS } from '../../src/sevalla/operations.ts'
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

const sent = new Map<string, Set<string>>()

afterEach(() => {
  for (const r of h.api.requests) {
    const fields = sent.get(r.operationId) ?? new Set()
    for (const key of [...Object.keys(r.query), ...Object.keys(r.body ?? {})]) {
      fields.add(key)
    }
    sent.set(r.operationId, fields)
  }
})

const last = (operationId: string) => {
  const calls = h.api.forOperation(operationId)
  const call = calls[calls.length - 1]
  if (!call) {
    throw new Error(`No upstream call for ${operationId}`)
  }
  return call
}

describe('e2e: protocol', () => {
  it('serves server instructions and 27 tools', async () => {
    ok(mcp.client.getInstructions()?.includes('Sevalla is a platform'))
    const { tools } = await mcp.client.listTools()
    strictEqual(tools.length, 27)
    const env = tools.find((t) => t.name === 'list_environment_variables')?.description ?? ''
    ok(env.includes('Stored values are withheld'))
  })

  it('rejects a connection with an invalid API key', async () => {
    await rejects(() => h.connect({ token: 'svl_bogus' }))
  })
})

describe('e2e: list_services', () => {
  it('lists every service type with IDs and totals', async () => {
    const res = await mcp.call('list_services')
    strictEqual(res.isError, false)
    strictEqual(res.json.applications.total, 2)
    deepStrictEqual(res.json.applications.items[1], {
      id: IDS.app2,
      name: 'worker-prod',
      display_name: 'Worker',
      status: 'deploymentFailed',
      source: 'dockerImage',
      suspended: true,
    })
    strictEqual(res.json.static_sites.items[0].id, IDS.site)
    strictEqual(res.json.databases.items[0].size, 'db-1')
  })

  it('passes filters upstream and filters static sites by name locally', async () => {
    const res = await mcp.call('list_services', { search: 'market', limit: 10 })
    strictEqual(res.json.static_sites.total, 1)
    deepStrictEqual(last('listApplicationsV3').query, { limit: '10', offset: '0', search: 'market' })
  })

  it('explains that static sites are not grouped into projects', async () => {
    const res = await mcp.call('list_services', { type: 'static_site', project_id: IDS.project })
    strictEqual(res.json.static_sites.note, 'Static sites are not grouped into projects.')
    strictEqual(h.api.forOperation('listStaticSitesV3').length, 0)
  })

  it('validates IDs before calling the API', async () => {
    const res = await mcp.call('list_services', { project_id: 'not-a-uuid' })
    strictEqual(res.isError, true)
    ok(res.text.includes('must be a UUID'))
  })
})

describe('e2e: get_application / get_static_site / get_database / get_platform_options', () => {
  it('summarizes an application with processes, domains and the latest deployment', async () => {
    const res = await mcp.call('get_application', { application_id: IDS.app })
    strictEqual(res.isError, false)
    strictEqual(res.json.name, 'api-prod')
    deepStrictEqual(res.json.processes[0].scaling, { instances: 2 })
    const custom = res.json.domains.find((d: any) => d.type === 'CUSTOM')
    deepStrictEqual(custom.errors, ['TXT record not found'])
    strictEqual(custom.dns_records[0].type, 'TXT')
    strictEqual(res.json.latest_deployment.commit, 'abcdef1')
    strictEqual(res.json.latest_deployment.commit_message, 'Fix checkout flow')
    ok(!res.text.includes('author_img'))
    strictEqual(res.json.more, undefined)
  })

  it('shows the health checks, disk and deployment timing of processes', async () => {
    const probe = { httpGet: { path: '/health', port: 8080 }, exec: null, periodSeconds: 10 }
    const disk = { resource_type_id: IDS.processSize, resource_type_name: 'ps1', size_gib: 10, mount_path: '/data' }
    h.api.override('listProcessesV3', () => ({
      body: {
        data: [
          { id: IDS.process, type: 'web', readiness_probe: probe, liveness_probe: {}, disk },
          { id: IDS.newResource, type: 'job', job_start_policy: 'beforeDeployment', disk: null },
        ],
        total: 2,
        offset: 0,
        limit: 100,
      },
    }))
    const res = await mcp.call('get_application', { application_id: IDS.app })
    const [web, job] = res.json.processes
    deepStrictEqual(web.readiness_probe, { httpGet: { path: '/health', port: 8080 }, periodSeconds: 10 })
    strictEqual(web.liveness_probe, undefined)
    deepStrictEqual(web.disk, disk)
    strictEqual(job.job_start_policy, 'beforeDeployment')
    strictEqual(job.disk, undefined)
  })

  it('names the operation that pages domains beyond the first 100', async () => {
    h.api.override('listApplicationDomainsV3', () => ({
      body: { data: [{ id: IDS.domain, name: 'a.example.com' }], total: 340, offset: 0, limit: 100 },
    }))
    const res = await mcp.call('get_application', { application_id: IDS.app })
    strictEqual(res.json.more, '1 of 340 shown; listApplicationDomainsV3 (sevalla_api_read) pages the rest.')
    strictEqual(last('listApplicationDomainsV3').query.limit, '100')
  })

  it('returns every field with detail=full', async () => {
    const res = await mcp.call('get_application', { application_id: IDS.app, detail: 'full' })
    strictEqual(res.json.namespace, 'ns')
    strictEqual(res.json.processes[0].liveness_probe !== undefined, true)
  })

  it('turns a 404 into an actionable error', async () => {
    const res = await mcp.call('get_application', { application_id: IDS.missing })
    strictEqual(res.isError, true)
    ok(res.text.startsWith('Not found: Application not found.'))
    ok(res.text.includes('list_services'))
  })

  it('summarizes a static site', async () => {
    const res = await mcp.call('get_static_site', { static_site_id: IDS.site })
    strictEqual(res.json.hostname, 'marketing.sevalla.page')
    strictEqual(res.json.latest_deployment.build_error, 'Build failed: missing dist')
  })

  it('summarizes a database without secrets', async () => {
    const res = await mcp.call('get_database', { database_id: IDS.db })
    strictEqual(res.json.internal_endpoint, 'main-db.internal:5432')
    strictEqual(res.json.external_endpoint, 'disabled')
    strictEqual(res.json.internal_connections[0].service_name, 'API')
    strictEqual(res.json.backups[0].type, 'daily')
    ok(!/password/i.test(res.text))
  })

  it('lists regions and sizes', async () => {
    const res = await mcp.call('get_platform_options', { kind: 'application' })
    strictEqual(res.json.clusters[0].name, 'Europe West')
    strictEqual(res.json.application_sizes[0].memory_mb, 2048)
    strictEqual(res.json.database_sizes, undefined)
  })
})

describe('e2e: deployments', () => {
  it('lists deployments of an application and of a static site', async () => {
    const apps = await mcp.call('list_deployments', { service_type: 'application', service_id: IDS.app, limit: 5 })
    strictEqual(apps.json.total, 2)
    strictEqual(apps.json.deployments[0].status, 'failed')
    await mcp.call('list_deployments', { service_type: 'static_site', service_id: IDS.site })
    strictEqual(last('listStaticSiteDeploymentsV3').path, `/v3/static-sites/${IDS.site}/deployments`)
  })

  it('gets a deployment with its steps', async () => {
    const res = await mcp.call('get_deployment', {
      service_type: 'application',
      service_id: IDS.app,
      deployment_id: IDS.deployment,
    })
    deepStrictEqual(res.json.steps, ['checkout', 'build', 'rollout'])
  })

  it('returns the tail of the build log for the deployment window', async () => {
    const res = await mcp.call('get_deployment_logs', {
      service_type: 'application',
      service_id: IDS.app,
      deployment_id: IDS.deployment,
      limit: 2,
    })
    const lines = res.text.split('\n')
    strictEqual(lines[0], `Deployment ${IDS.deployment} (failed): the last 2 lines; earlier lines exist.`)
    ok(lines[2]?.includes('ERROR Build failed with exit code 1'))
    const query = last('getApplicationDeploymentLogsV3').query
    strictEqual(query.limit, '2')
    ok(new Date(query.from as string) < new Date(query.to as string))
  })

  it('keeps only error lines with errors_only', async () => {
    const res = await mcp.call('get_deployment_logs', {
      service_type: 'application',
      service_id: IDS.app,
      deployment_id: IDS.deployment,
      errors_only: true,
    })
    const lines = res.text.split('\n').slice(1)
    strictEqual(lines.length, 2)
    ok(lines[0]?.includes('npm ERR!'))
    strictEqual(last('getApplicationDeploymentLogsV3').query.limit, '2000')
  })

  it('triggers deployments with the right body per service type', async () => {
    const res = await mcp.call('trigger_deployment', {
      service_type: 'application',
      service_id: IDS.app,
      branch: 'release',
      restart: false,
    })
    strictEqual(res.json.deployment.status, 'waiting')
    deepStrictEqual(last('triggerDeploymentV3').body, { branch: 'release', is_restart: false })
    const site = await mcp.call('trigger_deployment', {
      service_type: 'static_site',
      service_id: IDS.site,
      restart: true,
    })
    strictEqual(site.isError, true)
    ok(site.text.includes('applications only'))
    const commit = await mcp.call('trigger_deployment', {
      service_type: 'static_site',
      service_id: IDS.site,
      commit_sha: 'a'.repeat(40),
    })
    strictEqual(commit.isError, true)
    const short = await mcp.call('trigger_deployment', {
      service_type: 'application',
      service_id: IDS.app,
      commit_sha: 'abc1234',
    })
    strictEqual(short.isError, true)
    strictEqual(h.api.forOperation('triggerDeploymentV3').length, 1)
  })

  it('rolls back an application and a static site', async () => {
    const app = await mcp.call('rollback_deployment', { service_type: 'application', service_id: IDS.app })
    strictEqual(app.json.deployment.trigger, 'ROLLBACK_DEPLOYMENT')
    const misuse = await mcp.call('rollback_deployment', {
      service_type: 'application',
      service_id: IDS.app,
      deployment_id: IDS.deployment,
    })
    strictEqual(misuse.isError, true)
    const site = await mcp.call('rollback_deployment', { service_type: 'static_site', service_id: IDS.site })
    strictEqual(site.json.redeployed_from, IDS.sitePreviousDeployment)
    deepStrictEqual(last('deployStaticSiteV3').body, { deployment_id: IDS.sitePreviousDeployment })
  })
})

describe('e2e: logs and metrics', () => {
  it('filters runtime logs by severity on the server', async () => {
    const res = await mcp.call('search_runtime_logs', { application_id: IDS.app, severity: 'ERROR' })
    const lines = res.text.split('\n')
    strictEqual(lines.length, 3)
    ok(lines[1]?.includes('TypeError'))
    ok(lines[2]?.includes('Database connection lost'))
    deepStrictEqual(JSON.parse(last('getApplicationRuntimeLogsV3').query.filters ?? '[]'), [
      { key: 'severity', operator: 'IS_IN', values: ['ERROR', 'error'] },
    ])
  })

  it('searches runtime logs on the server', async () => {
    const res = await mcp.call('search_runtime_logs', {
      application_id: IDS.app,
      search: 'SLOW QUERY',
      since_minutes: 30,
    })
    ok(res.text.includes('Slow query took 1200ms'))
    strictEqual(res.text.split('\n').length, 2)
    const query = last('getApplicationRuntimeLogsV3').query
    strictEqual(query.search, 'SLOW QUERY')
    strictEqual(query.limit, '100')
  })

  it('filters access logs by status class, method and path on the server', async () => {
    const res = await mcp.call('search_access_logs', {
      service_type: 'application',
      service_id: IDS.app,
      status: '5xx',
    })
    const lines = res.text.split('\n').slice(1)
    strictEqual(lines.length, 1)
    ok(lines[0]?.includes('502 POST /api/orders'))
    const statusQuery = last('getApplicationAccessLogsV3').query
    strictEqual(statusQuery.limit, '100')
    deepStrictEqual(JSON.parse(statusQuery.filters ?? '[]'), [
      { key: 'attributes.edgeResponseStatus', operator: 'GREATER_THAN_OR_EQUALS', value: '500' },
      { key: 'attributes.edgeResponseStatus', operator: 'LESS_THAN_OR_EQUALS', value: '599' },
    ])
    const byPath = await mcp.call('search_access_logs', {
      service_type: 'application',
      service_id: IDS.app,
      request_method: 'GET',
      path_prefix: '/api',
    })
    ok(byPath.text.includes('404 GET /api/orders/1'))
    ok(!byPath.text.includes('/health'))
    deepStrictEqual(JSON.parse(last('getApplicationAccessLogsV3').query.filters ?? '[]'), [
      { key: 'attributes.clientRequestMethod', operator: 'EQUALS', value: 'GET' },
      { key: 'attributes.clientRequestPath', operator: 'STARTS_WITH', value: '/api' },
    ])
    const exact = await mcp.call('search_access_logs', {
      service_type: 'application',
      service_id: IDS.app,
      status: '404',
    })
    deepStrictEqual(JSON.parse(last('getApplicationAccessLogsV3').query.filters ?? '[]'), [
      { key: 'attributes.edgeResponseStatus', operator: 'EQUALS', value: '404' },
    ])
    ok(exact.text.includes('404 GET /api/orders/1'))
    const invalid = await mcp.call('search_access_logs', {
      service_type: 'application',
      service_id: IDS.app,
      status: 'teapot',
    })
    strictEqual(invalid.isError, true)
  })

  it('searches access logs by client details on this server', async () => {
    const res = await mcp.call('search_access_logs', {
      service_type: 'application',
      service_id: IDS.app,
      search: '1.2.3.5',
    })
    const lines = res.text.split('\n').slice(1)
    strictEqual(lines.length, 1)
    ok(lines[0]?.includes('502 POST /api/orders'))
    const query = last('getApplicationAccessLogsV3').query
    strictEqual(query.search, undefined)
    strictEqual(query.limit, '1000')
  })

  it('explains responses that exceed the size limit', async () => {
    h.api.override('getApplicationRuntimeLogsV3', () => ({
      body: Array.from({ length: 6000 }, (_, i) => ({ id: String(i), message: 'x'.repeat(1000), severity: 'INFO' })),
    }))
    const res = await mcp.call('search_runtime_logs', { application_id: IDS.app })
    strictEqual(res.isError, true)
    ok(res.text.includes('larger than this connector reads'))
  })

  it('summarizes application metrics', async () => {
    const res = await mcp.call('get_metrics', { target: 'application', application_id: IDS.app })
    const rpm = res.json.metrics.requests_per_minute
    deepStrictEqual([rpm.min, rpm.max, rpm.avg, rpm.last], [10, 40, 25, 40])
    strictEqual(res.json.metrics.average_response_time_ms, 123.4)
    strictEqual(res.json.metrics.slowest_requests[0].client_request_path, '/api/orders')
    ok(Number(last('getApplicationRequestsPerMinuteV3').query.interval_in_seconds) >= 60)
  })

  it('summarizes process and database metrics', async () => {
    const proc = await mcp.call('get_metrics', { target: 'process', application_id: IDS.app, process_id: IDS.process })
    strictEqual(proc.json.metrics.instance_count.max, 3)
    strictEqual(proc.json.metrics.exit_codes[0].description, 'OOMKilled')
    const db = await mcp.call('get_metrics', { target: 'database', database_id: IDS.db })
    strictEqual(db.json.metrics.used_storage_bytes, 1024)
  })

  it('filters HTTP metrics by request and sets the response time percentile', async () => {
    const res = await mcp.call('get_metrics', {
      target: 'application',
      application_id: IDS.app,
      metrics: ['response_time_ms', 'top_pages'],
      status: '404',
      path_prefix: '/api',
      percentile: 99,
    })
    strictEqual(res.isError, false, res.text)
    const filters = [
      { key: 'attributes.edgeResponseStatus', operator: 'EQUALS', value: '404' },
      { key: 'attributes.clientRequestPath', operator: 'STARTS_WITH', value: '/api' },
    ]
    deepStrictEqual(JSON.parse(last('getApplicationResponseTimeV3').query.filters ?? ''), filters)
    strictEqual(last('getApplicationResponseTimeV3').query.percent, '99')
    strictEqual(last('getApplicationTopPagesV3').query.percent, undefined)
    const process = await mcp.call('get_metrics', {
      target: 'process',
      application_id: IDS.app,
      process_id: IDS.process,
      status: '5xx',
    })
    ok(process.text.includes('apply to applications and static sites'))
    const noSeries = await mcp.call('get_metrics', { target: 'application', application_id: IDS.app, percentile: 95 })
    ok(noSeries.text.includes('percentile applies to the response_time_ms metric'))
  })

  it('reports missing IDs and unknown metric names', async () => {
    const missing = await mcp.call('get_metrics', { target: 'process', application_id: IDS.app })
    strictEqual(missing.isError, true)
    ok(missing.text.includes('process_id is required'))
    const wrong = await mcp.call('get_metrics', { target: 'database', database_id: IDS.db, metrics: ['top_pages'] })
    strictEqual(wrong.isError, true)
    ok(wrong.text.includes('Available: cpu_usage_cores'))
  })
})

describe('e2e: environment variables', () => {
  it('lists keys without values', async () => {
    const res = await mcp.call('list_environment_variables', { scope: 'application', service_id: IDS.app })
    deepStrictEqual(
      res.json.variables.map((v: any) => v.key),
      ['DATABASE_URL', 'NODE_ENV'],
    )
    ok(!res.text.includes(SECRET_VALUE))
    ok(!res.text.includes('production'))
  })

  it('upserts variables without echoing values and can redeploy', async () => {
    const res = await mcp.call('set_environment_variables', {
      scope: 'application',
      service_id: IDS.app,
      variables: [
        { key: 'DATABASE_URL', value: 'postgres://new-secret' },
        { key: 'FEATURE_FLAG', value: 'on', buildtime: false },
      ],
      redeploy: true,
    })
    strictEqual(res.isError, false)
    deepStrictEqual(res.json.created, ['FEATURE_FLAG'])
    deepStrictEqual(res.json.updated, ['DATABASE_URL'])
    strictEqual(res.json.deployment.status, 'waiting')
    ok(!res.text.includes('new-secret'))
    deepStrictEqual(last('updateEnvironmentVariableV3').body, { value: 'postgres://new-secret' })
    deepStrictEqual(last('createEnvironmentVariableV3').body, { key: 'FEATURE_FLAG', value: 'on', is_buildtime: false })
  })

  it('rejects flags that do not apply to the scope', async () => {
    const site = await mcp.call('set_environment_variables', {
      scope: 'static_site',
      service_id: IDS.site,
      variables: [{ key: 'A', value: 'b', runtime: true }],
    })
    strictEqual(site.isError, true)
    const global = await mcp.call('set_environment_variables', {
      scope: 'global',
      service_id: IDS.app,
      variables: [{ key: 'A', value: 'b' }],
    })
    strictEqual(global.isError, true)
    ok(global.text.includes('not used with scope global'))
  })

  it('deletes variables by key and reports unknown keys', async () => {
    const res = await mcp.call('delete_environment_variables', {
      scope: 'application',
      service_id: IDS.app,
      keys: ['NODE_ENV', 'NOPE'],
    })
    deepStrictEqual(res.json.deleted, ['NODE_ENV'])
    deepStrictEqual(res.json.not_found, ['NOPE'])
    strictEqual(last('deleteEnvironmentVariableV3').method, 'DELETE')
  })

  it('manages global variables', async () => {
    const res = await mcp.call('set_environment_variables', {
      scope: 'global',
      variables: [{ key: 'SENTRY_DSN', value: 'x' }],
    })
    deepStrictEqual(res.json.updated, ['SENTRY_DSN'])
    strictEqual(
      last('updateGlobalEnvVarV3').path,
      '/v3/applications/global-env-vars/e3e3e3e3-3333-4333-8333-333333333333',
    )
  })
})

describe('e2e: scaling and domains', () => {
  it('scales a process and restarts the application', async () => {
    const res = await mcp.call('scale_process', { application_id: IDS.app, process_id: IDS.process, instances: 3 })
    strictEqual(res.isError, false)
    deepStrictEqual(last('updateProcessV3').body, {
      scaling_strategy: { type: 'manual', config: { instanceCount: 3 } },
    })
    deepStrictEqual(last('triggerDeploymentV3').body, { is_restart: true })
    deepStrictEqual(res.json.process.scaling, { instances: 3 })
  })

  it('configures autoscaling without restarting when apply_now is false', async () => {
    await mcp.call('scale_process', {
      application_id: IDS.app,
      process_id: IDS.process,
      autoscaling: { min_instances: 1, max_instances: 4, target_cpu_percent: 70 },
      apply_now: false,
    })
    deepStrictEqual(last('updateProcessV3').body, {
      scaling_strategy: {
        type: 'horizontal',
        config: { minInstanceCount: 1, maxInstanceCount: 4, targetCpuPercent: 70 },
      },
    })
    strictEqual(h.api.forOperation('triggerDeploymentV3').length, 0)
  })

  it('validates scaling input', async () => {
    const none = await mcp.call('scale_process', { application_id: IDS.app, process_id: IDS.process })
    strictEqual(none.isError, true)
    const both = await mcp.call('scale_process', {
      application_id: IDS.app,
      process_id: IDS.process,
      instances: 2,
      autoscaling: { min_instances: 1, max_instances: 3, target_cpu_percent: 50 },
    })
    strictEqual(both.isError, true)
  })

  it('adds a wildcard domain and returns its DNS records', async () => {
    const res = await mcp.call('add_domain', {
      service_type: 'application',
      service_id: IDS.app,
      domain: '*.example.com',
    })
    deepStrictEqual(last('addApplicationDomainV3').body, { domain_name: 'example.com', is_wildcard: true })
    strictEqual(res.json.domain.dns_records[0].type, 'A')
  })

  it('adds a domain with a custom certificate and does not echo its key', async () => {
    const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
    const key = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----'
    const res = await mcp.call('add_domain', {
      service_type: 'static_site',
      service_id: IDS.site,
      domain: 'www.example.com',
      ssl_certificate: cert,
      ssl_private_key: key,
    })
    deepStrictEqual(last('addStaticSiteDomainV3').body, {
      domain_name: 'www.example.com',
      is_wildcard: false,
      custom_ssl_cert: cert,
      custom_ssl_key: key,
    })
    ok(!res.text.includes('MIIE'))
    const keyless = await mcp.call('add_domain', {
      service_type: 'application',
      service_id: IDS.app,
      domain: 'api.example.com',
      ssl_certificate: cert,
    })
    strictEqual(keyless.isError, true)
    const swapped = await mcp.call('add_domain', {
      service_type: 'application',
      service_id: IDS.app,
      domain: 'api.example.com',
      ssl_certificate: key,
      ssl_private_key: cert,
    })
    strictEqual(swapped.isError, true)
  })
})

describe('e2e: create tools', () => {
  it('creates an application and starts its first deployment', async () => {
    const res = await mcp.call('create_application', {
      display_name: 'Orders',
      cluster_id: IDS.cluster,
      source: 'publicGit',
      repo_url: 'https://github.com/acme/orders',
    })
    strictEqual(res.json.application.id, IDS.newResource)
    strictEqual(res.json.deployment.status, 'waiting')
    strictEqual(last('triggerDeploymentV3').path, `/v3/applications/${IDS.newResource}/deployments`)
  })

  it('requires an image for Docker applications', async () => {
    const res = await mcp.call('create_application', {
      display_name: 'Img',
      cluster_id: IDS.cluster,
      source: 'dockerImage',
    })
    strictEqual(res.isError, true)
    ok(res.text.includes('docker_image is required'))
  })

  it('creates a static site', async () => {
    const res = await mcp.call('create_static_site', {
      display_name: 'Docs',
      repo_url: 'https://github.com/acme/docs',
      default_branch: 'main',
      build_command: 'npm run build',
    })
    strictEqual(res.json.static_site.hostname, 'new-site.sevalla.page')
    deepStrictEqual(last('createStaticSiteV3').body, {
      display_name: 'Docs',
      repo_url: 'https://github.com/acme/docs',
      default_branch: 'main',
      build_command: 'npm run build',
    })
  })

  it('refuses both deploy path rules at once', async () => {
    const res = await mcp.call('create_static_site', {
      display_name: 'Docs',
      repo_url: 'https://github.com/acme/docs',
      default_branch: 'main',
      allow_deploy_paths: ['docs/**'],
      ignore_deploy_paths: ['*.md'],
    })
    ok(res.text.includes('mutually exclusive'))
    strictEqual(h.api.forOperation('createStaticSiteV3').length, 0)
  })

  it('creates a database, connects it and never returns the password', async () => {
    const res = await mcp.call('create_database', {
      display_name: 'Orders DB',
      type: 'postgresql',
      version: '17',
      cluster_id: IDS.cluster,
      size_id: IDS.dbSize,
      connect_to_application_id: IDS.app,
      env_var_name: 'ORDERS_DATABASE_URL',
    })
    strictEqual(res.isError, false)
    const created = last('createDatabaseV3').body as Record<string, string>
    strictEqual(created.db_name, 'orders_db')
    strictEqual(created.db_user, 'app_user')
    strictEqual(created.db_password?.length, 32)
    ok(!res.text.includes(created.db_password as string))
    strictEqual(res.json.connection.internal_connection, 'created')
    strictEqual(res.json.connection.env_var, 'ORDERS_DATABASE_URL created')
    const stored = last('createEnvironmentVariableV3').body as { key: string; value: string }
    strictEqual(stored.key, 'ORDERS_DATABASE_URL')
    strictEqual(stored.value, `postgresql://app_user:${created.db_password}@main-db.internal:5432/orders_db`)
  })

  it('never overwrites an existing variable when connecting a database', async () => {
    const res = await mcp.call('create_database', {
      display_name: 'Second DB',
      type: 'postgresql',
      version: '17',
      cluster_id: IDS.cluster,
      size_id: IDS.dbSize,
      connect_to_application_id: IDS.app,
    })
    ok(res.json.connection.env_var.startsWith('DATABASE_URL already exists and was left unchanged'))
    strictEqual(h.api.forOperation('updateEnvironmentVariableV3').length, 0)
    strictEqual(h.api.forOperation('createEnvironmentVariableV3').length, 0)
  })

  it('uses the newest version of the engine in the cluster when none is given', async () => {
    const res = await mcp.call('create_database', {
      display_name: 'X DB',
      type: 'redis',
      cluster_id: IDS.cluster,
      size_id: IDS.dbSize,
    })
    strictEqual(res.isError, false)
    deepStrictEqual(last('listDatabaseVersionsV3').query, { cluster_id: IDS.cluster, type: 'redis' })
    strictEqual((last('createDatabaseV3').body as Record<string, string>).version, '8.0')
  })
})

describe('e2e: search_sevalla_docs', () => {
  it('returns matching pages with the relevant section and ignores foreign links', async () => {
    const res = await mcp.call('search_sevalla_docs', { query: 'wildcard domains ssl' })
    strictEqual(res.json.results[0].title, 'Custom domains')
    ok(res.json.results[0].excerpt.includes('Wildcard domains need a CNAME'))
    ok(res.json.results.every((r: any) => !r.url.includes('evil.example.com')))
  })
})

describe('e2e: generic API tools', () => {
  it('finds operations and names the tool that runs each', async () => {
    const res = await mcp.call('sevalla_api_search', { query: 'webhook deliveries' })
    const hit = res.json.results.find((r: any) => r.operation_id === 'listWebhookDeliveriesV3')
    strictEqual(hit.tool, 'sevalla_api_read')
    const dedicated = await mcp.call('sevalla_api_search', { operation_id: 'triggerDeploymentV3' })
    strictEqual(dedicated.json.tool, 'trigger_deployment')
    ok(dedicated.json.body)
    deepStrictEqual(dedicated.json.permissions, ['APP:UPDATE'])
    const blocked = await mcp.call('sevalla_api_search', { operation_id: 'createDeviceCodeV3' })
    ok(blocked.json.tool.startsWith('unavailable:'))
    const apiKeys = await mcp.call('sevalla_api_search', { operation_id: 'createApiKeyV3' })
    strictEqual(apiKeys.json.tool, 'sevalla_api_update')
    const deletion = await mcp.call('sevalla_api_search', { operation_id: 'deleteApplicationV3' })
    strictEqual(deletion.json.tool, 'sevalla_api_delete')
  })

  it('reads data and returns non-environment secrets unchanged', async () => {
    const res = await mcp.call('sevalla_api_read', { operation_id: 'listWebhooksV3', query: { limit: 5 } })
    strictEqual(res.json.data[0].secret, 'whsec_should_not_leak')
    strictEqual(last('listWebhooksV3').query.limit, '5')
  })

  it('routes each class only through its own tool', async () => {
    const dedicated = await mcp.call('sevalla_api_read', { operation_id: 'listStaticSitesV3' })
    ok(dedicated.text.includes('available as the list_services tool'))
    const wrongClass = await mcp.call('sevalla_api_read', { operation_id: 'createProjectV3' })
    ok(wrongClass.text.includes('run by sevalla_api_create'))
    const unknown = await mcp.call('sevalla_api_update', { operation_id: 'doesNotExistV3' })
    strictEqual(unknown.isError, true)
    strictEqual(h.api.requests.filter((r) => r.operationId !== 'getCurrentApiKeyV3').length, 0)
  })

  it('creates, updates and deletes through the matching tools', async () => {
    const created = await mcp.call('sevalla_api_create', {
      operation_id: 'createProjectV3',
      body: { display_name: 'Shop' },
    })
    strictEqual(created.json.echo.operation_id, 'createProjectV3')
    deepStrictEqual(last('createProjectV3').body, { display_name: 'Shop' })
    await mcp.call('sevalla_api_update', { operation_id: 'suspendApplicationV3', path_params: { id: IDS.app } })
    strictEqual(last('suspendApplicationV3').path, `/v3/applications/${IDS.app}/suspend`)
    await mcp.call('sevalla_api_update', {
      operation_id: 'updateProcessV3',
      path_params: { id: IDS.app, process_id: IDS.process },
      body: { entrypoint: 'node server.js' },
    })
    deepStrictEqual(last('updateProcessV3').body, { entrypoint: 'node server.js' })
    await mcp.call('sevalla_api_delete', {
      operation_id: 'deleteApplicationDomainV3',
      path_params: { id: IDS.app, domain_id: IDS.domain },
    })
    strictEqual(last('deleteApplicationDomainV3').method, 'DELETE')
  })

  it('deletes an entire service through sevalla_api_delete', async () => {
    const res = await mcp.call('sevalla_api_delete', {
      operation_id: 'deleteApplicationV3',
      path_params: { id: IDS.app },
    })
    strictEqual(res.isError, false)
    strictEqual(last('deleteApplicationV3').path, `/v3/applications/${IDS.app}`)
    const annotations = (await mcp.client.listTools()).tools.find((t) => t.name === 'sevalla_api_delete')?.annotations
    strictEqual(annotations?.destructiveHint, true)
  })

  it('passes on the permission the API reports as missing', async () => {
    const readOnly = await h.connect({ token: TOKENS.readOnly })
    const res = await readOnly.call('sevalla_api_update', {
      operation_id: 'execProcessCommandV3',
      path_params: { id: IDS.app, process_id: IDS.process },
      body: { command: ['rm', '-rf', '/tmp/x'] },
    })
    strictEqual(res.isError, true)
    strictEqual(
      res.text,
      'The Sevalla API refused the request: This API key is missing the APP:UPDATE permission. Grant it to the key or use a key that has it.',
    )
  })
})

describe('e2e: isolation between users', () => {
  it('forwards each connection its own API key', async () => {
    const other = await h.connect({ token: TOKENS.other })
    await Promise.all([
      mcp.call('list_services', { type: 'database' }),
      other.call('list_services', { type: 'database' }),
    ])
    const tokens = h.api
      .forOperation('listDatabasesV3')
      .map((r) => r.token)
      .sort()
    deepStrictEqual(tokens, [TOKENS.other, TOKENS.valid].sort())
  })
})

describe('e2e: every tool input reaches the API', () => {
  const send = async (tool: string, args: Record<string, unknown>) => {
    const res = await mcp.call(tool, args)
    strictEqual(res.isError, false, res.text)
  }
  const pem = (label: string) => `-----BEGIN ${label}-----\nMIIB\n-----END ${label}-----`

  it('lists the services of a project', () => send('list_services', { project_id: IDS.project }))

  it('reads every metric of every target', async () => {
    const http = [
      'requests_per_minute',
      'response_time_ms',
      'average_response_time_ms',
      'status_codes',
      'top_status_codes',
      'top_countries',
      'slowest_requests',
      'top_pages',
    ]
    const filters = { status: '5xx', request_method: 'GET', path_prefix: '/api', percentile: 95 }
    await send('get_metrics', { target: 'application', application_id: IDS.app, metrics: http, ...filters })
    await send('get_metrics', { target: 'static_site', static_site_id: IDS.site, metrics: http, ...filters })
    await send('get_metrics', {
      target: 'process',
      application_id: IDS.app,
      process_id: IDS.process,
      metrics: ['cpu_usage_cores', 'cpu_limit_cores', 'memory_usage_bytes', 'memory_limit_bytes', 'instance_count'],
    })
    await send('get_metrics', {
      target: 'database',
      database_id: IDS.db,
      metrics: [
        'cpu_usage_cores',
        'cpu_limit_cores',
        'memory_usage_bytes',
        'memory_limit_bytes',
        'storage_usage_bytes',
        'storage_limit_bytes',
      ],
    })
  })

  it('searches the logs of both service types', async () => {
    for (const [service_type, service_id] of [
      ['application', IDS.app],
      ['static_site', IDS.site],
    ]) {
      await send('search_access_logs', { service_type, service_id, status: '5xx', request_method: 'GET', limit: 10 })
    }
    await send('get_deployment_logs', {
      service_type: 'static_site',
      service_id: IDS.site,
      deployment_id: IDS.siteDeployment,
    })
  })

  it('creates and updates variables in every scope', async () => {
    await send('set_environment_variables', {
      scope: 'application',
      service_id: IDS.app,
      variables: [
        { key: 'NEW_KEY', value: 'v', runtime: true, buildtime: true },
        { key: 'NODE_ENV', value: 'v', runtime: true, buildtime: false },
      ],
    })
    await send('set_environment_variables', {
      scope: 'static_site',
      service_id: IDS.site,
      variables: [
        { key: 'NEW_KEY', value: 'v', production: true, preview: false, branch: 'main' },
        { key: 'PUBLIC_API', value: 'v', production: true, preview: false, branch: 'main' },
      ],
    })
    await send('set_environment_variables', {
      scope: 'global',
      variables: [
        { key: 'NEW_KEY', value: 'v', runtime: true, buildtime: true },
        { key: 'SENTRY_DSN', value: 'v', runtime: true, buildtime: false },
      ],
    })
  })

  it('deploys an image and a branch', async () => {
    await send('trigger_deployment', { service_type: 'application', service_id: IDS.app, docker_image: 'nginx:1.27' })
    await send('trigger_deployment', {
      service_type: 'application',
      service_id: IDS.app,
      commit_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      skip_build_cache: true,
    })
    await send('trigger_deployment', { service_type: 'static_site', service_id: IDS.site, branch: 'main' })
  })

  it('adds an application domain with a custom certificate', () =>
    send('add_domain', {
      service_type: 'application',
      service_id: IDS.app,
      domain: 'api.example.com',
      ssl_certificate: pem('CERTIFICATE'),
      ssl_private_key: pem('PRIVATE KEY'),
    }))

  it('creates services with every option', async () => {
    await send('create_application', {
      display_name: 'Git app',
      cluster_id: IDS.cluster,
      source: 'publicGit',
      repo_url: 'https://github.com/acme/shop',
      git_type: 'github',
      default_branch: 'main',
      project_id: IDS.project,
      deploy: false,
    })
    await send('create_application', {
      display_name: 'Image app',
      cluster_id: IDS.cluster,
      source: 'dockerImage',
      docker_image: 'ghcr.io/acme/shop:1',
      docker_registry_credential_id: IDS.newResource,
      deploy: false,
    })
    await send('create_static_site', {
      display_name: 'Docs',
      repo_url: 'https://github.com/acme/docs',
      default_branch: 'main',
      source: 'publicGit',
      git_type: 'github',
      install_command: 'npm ci',
      build_command: 'npm run build',
      published_directory: 'dist',
      root_directory: 'site',
      node_version: '22',
      auto_deploy: true,
      allow_deploy_paths: ['site/**'],
      is_preview_enabled: true,
      index_file: 'index.html',
      error_file: '404.html',
      project_id: IDS.project,
    })
    await send('create_static_site', {
      display_name: 'Blog',
      repo_url: 'https://github.com/acme/blog',
      default_branch: 'main',
      ignore_deploy_paths: ['*.md'],
    })
    await send('create_database', {
      display_name: 'Orders',
      type: 'postgresql',
      cluster_id: IDS.cluster,
      size_id: IDS.dbSize,
      extensions: { vector: true },
      project_id: IDS.project,
    })
  })
})

const AGGREGATE = 'An aggregate over the window, not a series.'
const SORTED_HERE = 'Entries are sorted on this server; end_time reaches older ones.'
const MATCHED_HERE =
  'Matched on this server: the API searches only the message, without client IP, country or user agent.'
const FILTERED_HERE = 'get_deployment_logs filters and sorts the lines on this server.'
const BY_KEY = 'Variables are matched by key, so an update never renames one.'

const httpMetricGaps = (scope: string) =>
  Object.fromEntries(
    ['ResponseTimeAvg', 'SlowestRequests', 'TopCountries', 'TopPages', 'TopStatusCodes'].map((metric) => [
      `get${scope}${metric}V3`,
      { interval_in_seconds: AGGREGATE },
    ]),
  )

const UNSENT: Record<string, Record<string, string>> = {
  ...httpMetricGaps('Application'),
  ...httpMetricGaps('StaticSite'),
  getApplicationAccessLogsV3: { search: MATCHED_HERE, order: SORTED_HERE },
  getStaticSiteAccessLogsV3: { search: MATCHED_HERE, order: SORTED_HERE },
  getApplicationRuntimeLogsV3: { order: SORTED_HERE },
  getApplicationDeploymentLogsV3: { search: FILTERED_HERE, filters: FILTERED_HERE, order: FILTERED_HERE },
  getStaticSiteDeploymentLogsV3: { search: FILTERED_HERE, filters: FILTERED_HERE, order: FILTERED_HERE },
  listDatabaseBackupsV3: { type: 'Every backup type is listed.' },
  updateEnvironmentVariableV3: { key: BY_KEY },
  updateStaticSiteEnvVarV3: { key: BY_KEY },
  updateGlobalEnvVarV3: { key: BY_KEY },
}

describe('e2e: dedicated tools cover every field of their operations', () => {
  it('sends each query and body field, or pins why not', () => {
    const gaps: string[] = []
    for (const op of OPERATIONS.filter((o) => o.dedicatedTool)) {
      const fields = [
        ...op.params.filter((p) => p.in === 'query').map((p) => p.name),
        ...Object.keys((op.body?.properties ?? {}) as object),
      ]
      const unsent = UNSENT[op.id] ?? {}
      const used = sent.get(op.id) ?? new Set()
      gaps.push(
        ...fields.filter((f) => !used.has(f) && !unsent[f]).map((f) => `${op.id} (${op.dedicatedTool}): ${f}`),
        ...Object.keys(unsent)
          .filter((f) => !fields.includes(f) || used.has(f))
          .map((f) => `${op.id}: ${f} is pinned as unsent but is sent or not in the spec`),
      )
    }
    gaps.push(...Object.keys(UNSENT).filter((id) => !getOperation(id)?.dedicatedTool))
    deepStrictEqual(gaps, [])
  })
})
