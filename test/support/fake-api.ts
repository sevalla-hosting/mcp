import { randomUUID } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OPERATIONS, type Operation } from '../../src/sevalla/operations.ts'

export const IDS = {
  app: '11111111-1111-4111-8111-111111111111',
  app2: '11111111-1111-4111-8111-222222222222',
  site: '22222222-2222-4222-8222-222222222222',
  db: '33333333-3333-4333-8333-333333333333',
  process: '44444444-4444-4444-8444-444444444444',
  deployment: '55555555-5555-4555-8555-555555555555',
  previousDeployment: '55555555-5555-4555-8555-666666666666',
  siteDeployment: '66666666-6666-4666-8666-666666666666',
  sitePreviousDeployment: '66666666-6666-4666-8666-777777777777',
  cluster: '77777777-7777-4777-8777-777777777777',
  processSize: '88888888-8888-4888-8888-888888888888',
  dbSize: '88888888-8888-4888-8888-999999999999',
  project: '99999999-9999-4999-8999-999999999999',
  backup: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  domain: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  missing: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  newResource: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
}

export const TOKENS = {
  valid: 'svl_valid_token',
  other: 'svl_other_token',
  readOnly: 'svl_read_only_token',
}

export const SECRET_VALUE = 'postgres://user:super-secret-password@db.internal:5432/app'

export interface RecordedRequest {
  method: string
  path: string
  query: Record<string, string>
  body: unknown
  headers: IncomingHttpHeaders
  token?: string
  operationId?: string
}

interface HandlerContext {
  params: Record<string, string>
  query: Record<string, string>
  body: any
  token: string
}

type Handler = (_ctx: HandlerContext) => { status?: number; body: unknown }

const now = Date.now()
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()

const routes = OPERATIONS.map((op) => ({
  op,
  pattern: new RegExp(`^/v3${op.path.replace(/\{[^}]+\}/g, '([^/]+)')}$`),
  names: [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string),
})).sort((a, b) => a.names.length - b.names.length || b.op.path.length - a.op.path.length)

const page = (data: unknown[], query: Record<string, string>) => ({
  data: data.slice(Number(query.offset ?? 0), Number(query.offset ?? 0) + Number(query.limit ?? 25)),
  total: data.length,
  offset: Number(query.offset ?? 0),
  limit: Number(query.limit ?? 25),
})

const deployment = (id: string, status: string, offsetMs: number, extra: Record<string, unknown> = {}) => ({
  id,
  app_id: IDS.app,
  status,
  type: 'manual',
  trigger: 'MANUAL_DEPLOY',
  steps: ['checkout', 'build', 'deploy'],
  docker_image_url: null,
  git_type: 'github',
  repo_url: 'https://github.com/acme/api',
  branch: 'main',
  commit_sha: 'abcdef1234567890',
  commit_message: 'Fix checkout flow\n\nLonger body',
  author_login: 'octocat',
  author_img: 'https://avatars.example.com/u/1',
  started_at: iso(offsetMs),
  finished_at: iso(offsetMs + 120_000),
  created_at: iso(offsetMs - 5_000),
  updated_at: iso(offsetMs + 120_000),
  ...extra,
})

const logEntry = (offsetMs: number, severity: string, message: string, attributes: Record<string, unknown> = {}) => ({
  id: `log-${offsetMs}`,
  message,
  service: 'APP_RUNTIME',
  severity,
  timestamp: iso(offsetMs),
  tags: { container: 'web' },
  attributes,
  unix_timestamp: (now + offsetMs) * 1000,
})

const series = (values: number[]) => values.map((value, i) => ({ time: iso(-60_000 * (values.length - i)), value }))

interface LogFilterSpec {
  key: string
  operator: string
  value?: string
  values?: string[]
}

const fieldOf = (entry: Record<string, any>, key: string): unknown => {
  if (key.startsWith('attributes.')) {
    return entry.attributes?.[key.slice('attributes.'.length)]
  }
  if (key.startsWith('tags.')) {
    return entry.tags?.[key.slice('tags.'.length)]
  }
  return entry[key]
}

const matchesFilter = (entry: Record<string, any>, filter: LogFilterSpec): boolean => {
  const raw = fieldOf(entry, filter.key)
  const text = String(raw ?? '')
  switch (filter.operator) {
    case 'EQUALS':
      return text === filter.value
    case 'IS_IN':
      return (filter.values ?? []).includes(text)
    case 'STARTS_WITH':
      return text.startsWith(filter.value ?? '')
    case 'CONTAINS':
      return text.includes(filter.value ?? '')
    case 'GREATER_THAN_OR_EQUALS':
      return Number(raw) >= Number(filter.value)
    case 'LESS_THAN_OR_EQUALS':
      return Number(raw) <= Number(filter.value)
    default:
      throw new Error(`Unsupported operator ${filter.operator}`)
  }
}

export const applyLogFilters = <T extends Record<string, any>>(entries: T[], filters: string | undefined): T[] => {
  const parsed = filters ? (JSON.parse(filters) as LogFilterSpec[]) : []
  return entries.filter((entry) => parsed.every((filter) => matchesFilter(entry, filter)))
}

export interface FakeApi {
  url: string
  requests: RecordedRequest[]
  envVars: Map<string, Record<string, any>[]>
  validTokens: Set<string>
  override: (_operationId: string, _handler: Handler) => void
  reset: () => void
  close: () => Promise<void>
  forOperation: (_operationId: string) => RecordedRequest[]
}

const webProcess = (): Record<string, any> => ({
  id: IDS.process,
  app_id: IDS.app,
  key: 'web',
  type: 'web',
  display_name: 'Web',
  entrypoint: 'npm start',
  port: 8080,
  is_ingress_enabled: true,
  ingress_protocol: 'http',
  scaling_strategy: { type: 'manual', config: { instanceCount: 2 } },
  resource_type_id: IDS.processSize,
  resource_type_name: 'standard-1',
  cpu_limit: 1000,
  memory_limit: 2048,
  schedule: null,
  time_zone: null,
  concurrency_policy: null,
  active_deadline_seconds: null,
  job_start_policy: null,
  liveness_probe: {},
  readiness_probe: {},
  internal_hostname: 'web.api-prod.svc',
  created_at: iso(-1e7),
  updated_at: iso(-1e6),
})

const workerApp = {
  name: 'worker-prod',
  display_name: 'Worker',
  source: 'dockerImage',
  status: 'deploymentFailed',
  auto_deploy: false,
  is_suspended: true,
  is_cdn_enabled: false,
  git_type: null,
  repo_url: null,
  default_branch: null,
  docker_image: 'ghcr.io/acme/worker:1',
  build_type: 'dockerImage',
}

const workerProcess = (): Record<string, any> => ({
  ...webProcess(),
  id: '44444444-4444-4444-8444-555555555555',
  app_id: IDS.app2,
  key: 'worker',
  type: 'worker',
  display_name: 'Worker',
  entrypoint: 'node worker.js',
  port: null,
  is_ingress_enabled: false,
  ingress_protocol: null,
  scaling_strategy: { type: 'manual', config: { instanceCount: 1 } },
  internal_hostname: 'worker.worker-prod.svc',
})

interface World {
  processes: Map<string, Record<string, any>>
  suspended: Set<string>
  clones: Map<string, Record<string, any>>
}

const defaultEnvVars = () =>
  new Map<string, Record<string, any>[]>([
    [
      `application:${IDS.app}`,
      [
        {
          id: 'e1e1e1e1-1111-4111-8111-111111111111',
          app_id: IDS.app,
          key: 'DATABASE_URL',
          value: SECRET_VALUE,
          is_runtime: true,
          is_buildtime: false,
          created_at: iso(-1e6),
          updated_at: iso(-1e6),
        },
        {
          id: 'e1e1e1e1-1111-4111-8111-222222222222',
          app_id: IDS.app,
          key: 'NODE_ENV',
          value: 'production',
          is_runtime: true,
          is_buildtime: true,
          created_at: iso(-1e6),
          updated_at: iso(-1e6),
        },
      ],
    ],
    [
      `static_site:${IDS.site}`,
      [
        {
          id: 'e2e2e2e2-2222-4222-8222-222222222222',
          static_site_id: IDS.site,
          key: 'PUBLIC_API',
          value: 'https://api.example.com',
          is_production: true,
          is_preview: true,
          branch: null,
          created_at: iso(-1e6),
          updated_at: iso(-1e6),
        },
      ],
    ],
    [
      'global:',
      [
        {
          id: 'e3e3e3e3-3333-4333-8333-333333333333',
          key: 'SENTRY_DSN',
          value: 'https://secret@sentry.example.com/1',
          is_runtime: true,
          is_buildtime: true,
          created_at: iso(-1e6),
          updated_at: iso(-1e6),
        },
      ],
    ],
  ])

export const startFakeApi = async (): Promise<FakeApi> => {
  const requests: RecordedRequest[] = []
  const overrides = new Map<string, Handler>()
  const validTokens = new Set([TOKENS.valid, TOKENS.other, TOKENS.readOnly])
  let envVars = defaultEnvVars()
  let worlds = new Map<string, World>()
  const worldOf = (token: string): World => {
    const existing = worlds.get(token)
    if (existing) {
      return existing
    }
    const created: World = { processes: new Map(), suspended: new Set(), clones: new Map() }
    worlds.set(token, created)
    return created
  }

  const envScope = (op: Operation, params: Record<string, string>) =>
    op.path.startsWith('/applications/global-env-vars')
      ? 'global:'
      : op.path.startsWith('/static-sites')
        ? `static_site:${params.id}`
        : `application:${params.id}`

  const handlers: Record<string, Handler> = {
    getCurrentApiKeyV3: () => ({
      body: { id: 'key-1', company_id: 'company-1', name: 'MCP', capabilities: [{ permission: 'APP:READ' }] },
    }),
    listApplicationsV3: ({ query, token }) => ({
      body: page(
        [
          {
            id: IDS.app,
            name: 'api-prod',
            display_name: 'API',
            status: 'deploymentSuccess',
            type: 'app',
            source: 'privateGit',
            is_suspended: false,
            created_at: iso(-1e7),
            updated_at: iso(-1e6),
          },
          {
            id: IDS.app2,
            name: 'worker-prod',
            display_name: 'Worker',
            status: 'deploymentFailed',
            type: 'app',
            source: 'dockerImage',
            is_suspended: true,
            created_at: iso(-1e7),
            updated_at: iso(-1e6),
          },
          ...worldOf(token).clones.values(),
        ]
          .map((a) => ({ ...a, is_suspended: a.is_suspended || worldOf(token).suspended.has(a.id) }))
          .filter((a) => !query.search || a.name.includes(query.search)),
        query,
      ),
    }),
    listStaticSitesV3: ({ query }) => ({
      body: page([{ id: IDS.site, name: 'marketing', display_name: 'Marketing', status: 'deploymentSuccess' }], query),
    }),
    listDatabasesV3: ({ query }) => ({
      body: page(
        [
          {
            id: IDS.db,
            name: 'main-db',
            display_name: 'Main DB',
            status: 'ready',
            type: 'postgresql',
            version: '17',
            resource_type_name: 'db-1',
            is_suspended: false,
            created_at: iso(-1e7),
            updated_at: iso(-1e6),
          },
        ],
        query,
      ),
    }),
    getApplicationV3: ({ params, token }) =>
      params.id === IDS.missing
        ? { status: 404, body: { message: 'Application not found', status: 404, data: { code: 'err-404' } } }
        : worldOf(token).clones.has(params.id)
          ? { body: worldOf(token).clones.get(params.id) }
          : {
              body: {
                id: params.id,
                company_id: 'company-1',
                project_id: IDS.project,
                name: 'api-prod',
                namespace: 'ns',
                display_name: 'API',
                source: 'privateGit',
                type: 'app',
                status: 'deploymentSuccess',
                build_cache_enabled: true,
                git_lfs_enabled: true,
                hibernation_enabled: false,
                hibernate_after_seconds: null,
                auto_deploy: true,
                is_suspended: worldOf(token).suspended.has(params.id),
                is_cdn_enabled: true,
                is_edge_cache_enabled: false,
                git_type: 'github',
                repo_url: 'https://github.com/acme/api',
                default_branch: 'main',
                docker_image: null,
                build_type: 'nixpacks',
                build_path: null,
                pack_builder: null,
                nixpacks_version: null,
                dockerfile_path: null,
                docker_context: null,
                allow_deploy_paths: [],
                ignore_deploy_paths: [],
                buildpacks: [],
                cluster_id: IDS.cluster,
                docker_registry_credential_id: null,
                created_by: 'user-1',
                created_at: iso(-1e7),
                updated_at: iso(-1e6),
                ...(params.id === IDS.app2 ? workerApp : {}),
              },
            },
    listProcessesV3: ({ params, query, token }) => ({
      body: page(
        params.id === IDS.app2
          ? [workerProcess()]
          : [{ ...webProcess(), ...worldOf(token).processes.get(IDS.process) }],
        query,
      ),
    }),
    getProcessV3: ({ params, token }) => ({
      body: { ...webProcess(), ...worldOf(token).processes.get(params.process_id), id: params.process_id },
    }),
    updateProcessV3: ({ params, body, token }) => {
      const process = {
        ...webProcess(),
        ...worldOf(token).processes.get(params.process_id),
        ...body,
        id: params.process_id,
        updated_at: new Date().toISOString(),
      }
      worldOf(token).processes.set(params.process_id, process)
      return { body: process }
    },
    suspendApplicationV3: ({ params, token }) => {
      worldOf(token).suspended.add(params.id)
      return { body: { message: 'Application suspension started' } }
    },
    cloneApplicationV3: ({ body, token }) => {
      const id = randomUUID()
      const clone = {
        id,
        company_id: 'company-1',
        project_id: null,
        name: `${String(body.display_name)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 5)}`,
        display_name: body.display_name,
        source: 'privateGit',
        type: 'app',
        status: 'deploymentSuccess',
        auto_deploy: false,
        is_suspended: false,
        repo_url: 'https://github.com/acme/api',
        default_branch: 'main',
        cluster_id: body.cluster_id ?? IDS.cluster,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      worldOf(token).clones.set(id, clone)
      return { status: 201, body: clone }
    },
    listApplicationDomainsV3: ({ params, query }) => ({
      body: page(
        params.id === IDS.app2
          ? []
          : [
              {
                id: IDS.domain,
                name: 'api-prod.sevalla.app',
                status: 'ACTIVE',
                type: 'SYSTEM',
                is_enabled: true,
                is_wildcard: false,
                is_primary: false,
                dns_records: null,
                errors: [],
                created_at: iso(-1e7),
                updated_at: iso(-1e6),
              },
              {
                id: 'bbbbbbbb-bbbb-4bbb-8bbb-cccccccccccc',
                name: 'api.example.com',
                status: 'VERIFICATION',
                type: 'CUSTOM',
                is_enabled: true,
                is_wildcard: false,
                is_primary: true,
                dns_records: [{ type: 'TXT', name: '_cf-custom-hostname.api.example.com', value: 'abc' }],
                errors: ['TXT record not found'],
                created_at: iso(-1e6),
                updated_at: iso(-1e6),
              },
            ],
        query,
      ),
    }),
    listDeploymentsV3: ({ query }) => ({
      body: page(
        [deployment(IDS.deployment, 'failed', -600_000), deployment(IDS.previousDeployment, 'success', -86_400_000)],
        query,
      ),
    }),
    getDeploymentV3: ({ params }) => ({ body: deployment(params.deployment_id as string, 'failed', -600_000) }),
    getApplicationDeploymentLogsV3: ({ query }) => ({
      body: [
        logEntry(-599_000, 'INFO', 'Cloning repository'),
        logEntry(-598_000, 'INFO', 'npm ci'),
        logEntry(-590_000, 'INFO', 'npm ERR! Missing script: "build"'),
        logEntry(-589_000, 'ERROR', 'Build failed with exit code 1'),
      ].slice(-Number(query.limit ?? 1000)),
    }),
    triggerDeploymentV3: ({ body }) => ({
      body: deployment(IDS.newResource, 'waiting', 0, {
        branch: body.branch ?? 'main',
        commit_sha: body.commit_sha ?? 'abcdef1234567890',
        started_at: null,
        finished_at: null,
      }),
    }),
    rollbackDeploymentV3: () => ({
      body: deployment(IDS.newResource, 'waiting', 0, {
        trigger: 'ROLLBACK_DEPLOYMENT',
        started_at: null,
        finished_at: null,
      }),
    }),
    getApplicationRuntimeLogsV3: ({ query }) => {
      const entries = [
        logEntry(-300_000, 'INFO', 'Server listening on 8080'),
        logEntry(-200_000, 'WARN', 'Slow query took 1200ms'),
        logEntry(-100_000, 'ERROR', 'TypeError: cannot read properties of undefined (reading "id")'),
        logEntry(-90_000, 'error', 'Database connection lost'),
      ].filter((e) => !query.search || e.message.toLowerCase().includes(query.search.toLowerCase()))
      return { body: applyLogFilters(entries, query.filters).slice(-Number(query.limit ?? 1000)) }
    },
    getApplicationAccessLogsV3: ({ query }) => ({
      body: applyLogFilters(
        [
          logEntry(-50_000, 'INFO', 'GET /health 200', {
            edgeResponseStatus: '200',
            clientRequestMethod: 'GET',
            clientRequestPath: '/health',
            clientIP: '1.2.3.4',
          }),
          logEntry(-40_000, 'INFO', 'POST /api/orders 502', {
            edgeResponseStatus: '502',
            clientRequestMethod: 'POST',
            clientRequestPath: '/api/orders',
            clientIP: '1.2.3.5',
          }),
          logEntry(-30_000, 'INFO', 'GET /api/orders/1 404', {
            edgeResponseStatus: '404',
            clientRequestMethod: 'GET',
            clientRequestPath: '/api/orders/1',
            clientIP: '1.2.3.6',
          }),
        ].map((entry) => ({ ...entry, tags: { idApp: IDS.app, isPreview: 'false' } })),
        query.filters,
      ).slice(-Number(query.limit ?? 1000)),
    }),
    getApplicationRequestsPerMinuteV3: () => ({ body: series([10, 20, 30, 40]) }),
    getApplicationResponseTimeV3: ({ query }) => ({
      body: series(Array(4).fill(query.percent ? Number(query.percent) * 10 : 500)),
    }),
    getApplicationResponseTimeAvgV3: () => ({ body: { average_response_time_ms: 123.4 } }),
    getApplicationTopStatusCodesV3: () => ({
      body: [
        { status: '200', total: 100 },
        { status: '502', total: 4 },
      ],
    }),
    getApplicationSlowestRequestsV3: () => ({
      body: [
        {
          id: 'r1',
          client_request_method: 'POST',
          client_request_path: '/api/orders',
          average_response_time_ms: 2400,
          count_of_requests: 12,
        },
      ],
    }),
    getApplicationStatusCodesV3: () => ({
      body: [
        { time: iso(-120_000), value: { '1xx': 0, '2xx': 10, '3xx': 0, '4xx': 0, '5xx': 1 } },
        { time: iso(-60_000), value: { '1xx': 0, '2xx': 5, '3xx': 0, '4xx': 0, '5xx': 0 } },
      ],
    }),
    getProcessCpuUsageV3: () => ({ body: series([0.1, 0.5, 0.25]) }),
    getProcessMemoryUsageV3: () => ({ body: series([100, 200, 150]) }),
    getProcessInstanceCountV3: () => ({ body: series([2, 2, 3]) }),
    getProcessExitCodesV3: () => ({ body: [{ time: iso(-60_000), value: '137', description: 'OOMKilled' }] }),
    getDatabaseCpuUsageV3: () => ({ body: series([0.2, 0.4]) }),
    getDatabaseMemoryUsageV3: () => ({ body: series([500, 600]) }),
    getDatabaseUsedStorageV3: () => ({ body: { value: 1024 } }),
    getDatabaseAllStorageV3: () => ({ body: { value: 10240 } }),
    getStaticSiteV3: ({ params }) => ({
      body: {
        id: params.id,
        company_id: 'company-1',
        project_id: null,
        name: 'marketing',
        display_name: 'Marketing',
        status: 'deploymentSuccess',
        source: 'privateGit',
        repo_url: 'https://github.com/acme/site',
        default_branch: 'main',
        auto_deploy: true,
        is_preview_enabled: false,
        git_lfs_enabled: false,
        git_type: 'github',
        hostname: 'marketing.sevalla.page',
        install_command: 'npm ci',
        build_command: 'npm run build',
        published_directory: 'dist',
        root_directory: null,
        node_version: '22',
        index_file: 'index.html',
        error_file: null,
        allow_deploy_paths: [],
        ignore_deploy_paths: [],
        created_at: iso(-1e7),
        updated_at: iso(-1e6),
      },
    }),
    listStaticSiteDomainsV3: ({ query }) => ({
      body: page(
        [
          {
            id: IDS.domain,
            name: 'marketing.sevalla.page',
            status: 'ACTIVE',
            type: 'SYSTEM',
            is_enabled: true,
            is_wildcard: false,
            is_primary: true,
            dns_records: null,
            errors: null,
          },
        ],
        query,
      ),
    }),
    listStaticSiteDeploymentsV3: ({ query }) => ({
      body: page(
        [
          {
            id: IDS.siteDeployment,
            static_site_id: IDS.site,
            status: 'failed',
            type: 'manual',
            branch: 'main',
            build_error: 'Build failed: missing dist',
            commit_sha: 'fedcba9876543210',
            commit_message: 'Update copy',
            created_at: iso(-60_000),
          },
          {
            id: IDS.sitePreviousDeployment,
            static_site_id: IDS.site,
            status: 'success',
            type: 'manual',
            branch: 'main',
            build_error: null,
            commit_sha: '0123456789abcdef',
            commit_message: 'Initial',
            created_at: iso(-86_400_000),
          },
        ],
        query,
      ),
    }),
    deployStaticSiteV3: ({ body }) => ({
      status: 201,
      body: {
        id: IDS.newResource,
        static_site_id: IDS.site,
        status: 'waiting',
        type: 'manual',
        branch: body.branch ?? 'main',
        created_at: iso(0),
        redeploy_of: body.deployment_id ?? null,
      },
    }),
    getDatabaseV3: ({ params }) => ({
      body: {
        id: params.id,
        company_id: 'company-1',
        project_id: IDS.project,
        name: 'main-db',
        display_name: 'Main DB',
        type: 'postgresql',
        version: '17',
        status: 'ready',
        is_suspended: false,
        cluster_id: IDS.cluster,
        cluster_display_name: 'Europe West',
        cluster_location: 'europe-west3',
        resource_type_id: IDS.dbSize,
        resource_type_name: 'db-1',
        cpu_limit: 500,
        memory_limit: 1024,
        storage_size: 10240,
        db_name: 'app',
        internal_hostname: 'main-db.internal',
        internal_port: '5432',
        external_hostname: null,
        external_port: null,
        created_at: iso(-1e7),
        updated_at: iso(-1e6),
      },
    }),
    listDatabaseBackupsV3: () => ({
      body: [
        {
          id: IDS.backup,
          name: 'b1',
          display_name: 'Daily',
          type: 'daily',
          created_at: iso(-3_600_000),
          expires_at: iso(6 * 86_400_000),
        },
      ],
    }),
    listDatabaseInternalConnectionsV3: () => ({
      body: [
        {
          id: 'conn-1',
          source_id: IDS.db,
          source_type: 'dbResource',
          source_name: 'main-db',
          source_display_name: 'Main DB',
          target_id: IDS.app,
          target_type: 'appResource',
          target_name: 'api-prod',
          target_display_name: 'API',
        },
      ],
    }),
    listClustersV3: () => ({
      body: [
        { id: IDS.cluster, name: 'eu-west', display_name: 'Europe West', location: 'europe-west3', provider: 'gcp' },
      ],
    }),
    listProcessResourceTypesV3: () => ({
      body: [{ id: IDS.processSize, name: 'standard-1', cpu_limit: 1000, memory_limit: 2048, category: 'standard' }],
    }),
    listDatabaseResourceTypesV3: () => ({
      body: [{ id: IDS.dbSize, name: 'db-1', cpu_limit: 500, memory_limit: 1024, storage_limit: 10240 }],
    }),
    listDatabaseVersionsV3: () => ({
      body: [
        { type: 'postgresql', versions: ['16', '17', '18'] },
        { type: 'redis', versions: ['7.2', '8.0'] },
      ],
    }),
    createApplicationV3: ({ body }) => ({
      status: 201,
      body: {
        id: IDS.newResource,
        name: 'new-app',
        display_name: body.display_name,
        status: null,
        source: body.source,
        repo_url: body.repo_url ?? null,
        default_branch: body.default_branch ?? 'main',
        docker_image: body.docker_image ?? null,
        build_type: 'nixpacks',
      },
    }),
    createStaticSiteV3: ({ body }) => ({
      status: 201,
      body: {
        id: IDS.newResource,
        name: 'new-site',
        display_name: body.display_name,
        status: 'deploymentInProgress',
        hostname: 'new-site.sevalla.page',
        repo_url: body.repo_url,
        default_branch: body.default_branch,
      },
    }),
    createDatabaseV3: ({ body }) => ({
      status: 201,
      body: {
        id: IDS.newResource,
        name: 'new-db',
        display_name: body.display_name,
        type: body.type,
        version: body.version,
        status: 'creating',
        resource_type_name: 'db-1',
      },
    }),
    createDatabaseInternalConnectionV3: () => ({ status: 201, body: { id: 'conn-new' } }),
    addApplicationDomainV3: ({ body }) => ({
      status: 201,
      body: {
        id: IDS.newResource,
        name: body.domain_name,
        status: 'VERIFICATION',
        type: 'CUSTOM',
        is_enabled: true,
        is_wildcard: body.is_wildcard ?? false,
        is_primary: false,
        dns_records: [{ type: 'A', name: body.domain_name, value: '1.2.3.4' }],
        errors: null,
      },
    }),
    addStaticSiteDomainV3: ({ body }) => ({
      status: 201,
      body: {
        id: IDS.newResource,
        name: body.domain_name,
        status: 'VERIFICATION',
        type: 'CUSTOM',
        dns_records: [{ type: 'CNAME', name: body.domain_name, value: 'marketing.sevalla.page' }],
        errors: null,
      },
    }),
    createDeviceCodeV3: () => ({ status: 201, body: { code: 'DEVICE123', expires_at: iso(300_000) } }),
    pollDeviceCodeV3: () => ({ body: { status: 'approved', token: TOKENS.valid } }),
    listWebhooksV3: ({ query }) => ({
      body: page(
        [
          {
            id: 'wh-1',
            endpoint: 'https://hooks.example.com',
            secret: 'whsec_should_not_leak',
            old_secret: 'whsec_old',
            is_enabled: true,
          },
        ],
        query,
      ),
    }),
  }
  handlers.getStaticSiteDeploymentV3 = handlers.getDeploymentV3 as Handler
  handlers.getStaticSiteDeploymentLogsV3 = handlers.getApplicationDeploymentLogsV3 as Handler
  handlers.getStaticSiteAccessLogsV3 = handlers.getApplicationAccessLogsV3 as Handler

  const envHandlers = (op: Operation): Handler | undefined => {
    if (!/env-vars/.test(op.path)) {
      return undefined
    }
    return ({ params, query, body }) => {
      const scope = envScope(op, params)
      const list = envVars.get(scope) ?? []
      const varId = params.env_var_id ?? (op.path.startsWith('/applications/global-env-vars/') ? params.id : undefined)
      if (op.method === 'GET') {
        return { body: page(list, query) }
      }
      if (op.method === 'POST') {
        if (list.some((v) => v.key === body.key)) {
          return { status: 409, body: { message: 'Environment variable already exists', status: 409 } }
        }
        const created = {
          id: `e9e9e9e9-9999-4999-8999-${String(list.length + 100).padStart(12, '0')}`,
          key: body.key,
          value: body.value,
          is_runtime: body.is_runtime ?? true,
          is_buildtime: body.is_buildtime ?? true,
          created_at: iso(0),
          updated_at: iso(0),
        }
        envVars.set(scope, [...list, created])
        return { status: 201, body: created }
      }
      const existing = list.find((v) => v.id === varId)
      if (!existing) {
        return { status: 404, body: { message: 'Environment variable not found', status: 404 } }
      }
      if (op.method === 'PUT') {
        Object.assign(existing, body, { updated_at: iso(0) })
        return { body: existing }
      }
      envVars.set(
        scope,
        list.filter((v) => v.id !== varId),
      )
      return { body: { message: 'Deleted' } }
    }
  }

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url ?? '/', 'http://localhost')
    const send = (status: number, body: unknown, contentType = 'application/json') => {
      res.writeHead(status, { 'content-type': contentType })
      res.end(typeof body === 'string' ? body : JSON.stringify(body))
    }

    if (url.pathname === '/llms.txt') {
      const base = `http://${req.headers.host}`
      return send(
        200,
        `# Sevalla docs\n\n- [Custom domains](${base}/applications/domains.md): Add custom domains, wildcard domains and SSL.\n- [Nixpacks](${base}/applications/build-options/nixpacks.md): Configure Nixpacks builds and the Node.js version.\n- [External site](https://evil.example.com/x.md): Not a Sevalla page.\n`,
        'text/plain',
      )
    }
    if (url.pathname.endsWith('.md')) {
      return send(
        200,
        `# Page\n\nIntro text.\n\n## Wildcard domains\n\nWildcard domains need a CNAME for _acme-challenge and SSL is issued automatically.\n\n## Other\n\nUnrelated.`,
        'text/markdown',
      )
    }

    const route = routes.find((r) => r.op.method === req.method && r.pattern.test(url.pathname))
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined
    const record: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: raw.length > 0 ? JSON.parse(raw) : undefined,
      headers: req.headers,
      token,
      operationId: route?.op.id,
    }
    requests.push(record)

    if (!route) {
      return send(404, { message: `No route for ${req.method} ${url.pathname}`, status: 404 })
    }
    const isAuthRoute = route.op.id === 'createDeviceCodeV3' || route.op.id === 'pollDeviceCodeV3'
    if (!isAuthRoute && (!token || !validTokens.has(token))) {
      return send(401, { message: 'Unauthorized', status: 401, data: { code: 'err-401' } })
    }
    if (raw.length === 0 && String(req.headers['content-type'] ?? '').includes('application/json')) {
      return send(400, {
        message: "Body cannot be empty when content-type is set to 'application/json'",
        status: 400,
        data: {},
      })
    }
    if (token === TOKENS.readOnly && route.op.method !== 'GET') {
      return send(403, {
        message: 'This API key is missing the APP:UPDATE permission. Grant it to the key or use a key that has it.',
        status: 403,
        data: { code: 'err-403' },
      })
    }
    const values = route.pattern.exec(url.pathname)?.slice(1) ?? []
    const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(values[i] ?? '')]))
    const handler = overrides.get(route.op.id) ?? envHandlers(route.op) ?? handlers[route.op.id]
    const ctx = { params, query: record.query, body: record.body ?? {}, token: token ?? '' }
    if (!handler) {
      return send(route.op.method === 'POST' ? 201 : 200, {
        echo: { operation_id: route.op.id, params, query: record.query, body: record.body ?? null },
      })
    }
    const result = handler(ctx)
    return send(result.status ?? 200, result.body)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get envVars() {
      return envVars
    },
    validTokens,
    override: (operationId, handler) => overrides.set(operationId, handler),
    reset: () => {
      requests.length = 0
      overrides.clear()
      envVars = defaultEnvVars()
      worlds = new Map()
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
    forOperation: (operationId) => requests.filter((r) => r.operationId === operationId),
  }
}
