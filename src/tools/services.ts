import { z } from 'zod'
import { encodePath, type ReadOnlyClient } from '../sevalla/client.ts'
import { readTool } from './define.ts'
import { firstLine, omitEmpty, shortSha, toolResult } from './format.ts'
import { detail, uuid, type ApiRecord, type Page } from './schemas.ts'

const summarizeApplicationListItem = (app: ApiRecord) =>
  omitEmpty({
    id: app.id,
    name: app.name,
    display_name: app.display_name,
    status: app.status,
    source: app.source,
    preview: app.type === 'previewApp' ? true : undefined,
    suspended: app.is_suspended === true ? true : undefined,
  })

const summarizeDatabaseListItem = (db: ApiRecord) =>
  omitEmpty({
    id: db.id,
    name: db.name,
    display_name: db.display_name,
    type: db.type,
    version: db.version,
    status: db.status,
    size: db.resource_type_name,
    suspended: db.is_suspended === true ? true : undefined,
  })

const summarizeStaticSiteListItem = (site: ApiRecord) =>
  omitEmpty({ id: site.id, name: site.name, display_name: site.display_name, status: site.status })

export const summarizeScaling = (strategy: ApiRecord | null | undefined) => {
  if (!strategy) {
    return undefined
  }
  if (strategy.type === 'manual') {
    return { instances: strategy.config?.instanceCount }
  }
  return omitEmpty({
    autoscaling_min: strategy.config?.minInstanceCount,
    autoscaling_max: strategy.config?.maxInstanceCount,
    target_cpu_percent: strategy.config?.targetCpuPercent,
    target_memory_percent: strategy.config?.targetMemoryPercent,
  })
}

const summarizeProbe = (probe: ApiRecord | null | undefined) => {
  const fields = omitEmpty(probe ?? {})
  return Object.keys(fields).length > 0 ? fields : undefined
}

export const summarizeProcess = (process: ApiRecord) =>
  omitEmpty({
    id: process.id,
    key: process.key,
    type: process.type,
    display_name: process.display_name,
    entrypoint: process.entrypoint,
    port: process.type === 'web' ? process.port : undefined,
    size: process.resource_type_name,
    cpu_millicores: process.cpu_limit,
    memory_mb: process.memory_limit,
    scaling: summarizeScaling(process.scaling_strategy),
    schedule: process.schedule,
    time_zone: process.schedule ? process.time_zone : undefined,
    job_start_policy: process.job_start_policy,
    readiness_probe: summarizeProbe(process.readiness_probe),
    liveness_probe: summarizeProbe(process.liveness_probe),
    disk: process.disk,
    internal_hostname: process.internal_hostname,
  })

export const summarizeDomain = (domain: ApiRecord) =>
  omitEmpty({
    id: domain.id,
    name: domain.name,
    type: domain.type,
    status: domain.status,
    primary: domain.is_primary === true ? true : undefined,
    enabled: domain.is_enabled === false ? false : undefined,
    wildcard: domain.is_wildcard === true ? true : undefined,
    dns_records: domain.dns_records,
    errors: Array.isArray(domain.errors) && domain.errors.length === 0 ? undefined : domain.errors,
  })

export const summarizeDeployment = (deployment: ApiRecord | undefined) =>
  deployment
    ? omitEmpty({
        id: deployment.id,
        status: deployment.status,
        type: deployment.type,
        trigger: deployment.trigger,
        branch: deployment.branch,
        commit: shortSha(deployment.commit_sha),
        commit_message: firstLine(deployment.commit_message),
        author: deployment.author_login,
        docker_image: deployment.docker_image_url,
        preview: deployment.is_preview === true ? true : undefined,
        build_error: firstLine(deployment.build_error, 500),
        created_at: deployment.created_at,
        started_at: deployment.started_at,
        finished_at: deployment.finished_at,
      })
    : undefined

const firstPage = (api: ReadOnlyClient, path: string) => api.get<Page<ApiRecord>>(path, { limit: 100 })

const unlisted = (pages: Record<string, Page<ApiRecord>>) => {
  const notes = Object.entries(pages)
    .filter(([, page]) => page.total > page.data.length)
    .map(([id, page]) => `${page.data.length} of ${page.total} shown; ${id} (sevalla_api_read) pages the rest.`)
  return notes.length > 0 ? notes.join(' ') : undefined
}

export const listServices = readTool({
  name: 'list_services',
  title: 'List Sevalla services',
  description:
    'Lists the applications, static sites and databases in the Sevalla account with status, names and the IDs other tools take. One service in detail: get_application, get_static_site, get_database. Pipelines, projects, load balancers, buckets and lists by status, source or engine: sevalla_api_read.',
  input: z
    .object({
      type: z
        .enum(['application', 'static_site', 'database'])
        .optional()
        .describe('One service type only. Default: all.'),
      search: z.string().min(1).max(100).optional().describe('Text matched against names, case-insensitive.'),
      project_id: uuid('Project ID; filters applications and databases.').optional(),
      limit: z.number().int().min(1).max(100).default(50).describe('Maximum services per type.'),
      offset: z.number().int().min(0).max(10_000).default(0).describe('Services skipped per type, for paging.'),
    })
    .strict(),
  run: async (args, { api }) => {
    const types = args.type ? [args.type] : (['application', 'static_site', 'database'] as const)
    const query = { limit: args.limit, offset: args.offset, search: args.search, project_id: args.project_id }
    const result: Record<string, unknown> = {}
    await Promise.all(
      types.map(async (type) => {
        if (type === 'application') {
          const page = await api.get<Page<ApiRecord>>('/applications', query)
          result.applications = { total: page.total, items: page.data.map(summarizeApplicationListItem) }
        }
        if (type === 'database') {
          const page = await api.get<Page<ApiRecord>>('/databases', query)
          result.databases = { total: page.total, items: page.data.map(summarizeDatabaseListItem) }
        }
        if (type === 'static_site') {
          if (args.project_id) {
            result.static_sites = { total: 0, items: [], note: 'Static sites are not grouped into projects.' }
            return
          }
          const page = await api.get<Page<ApiRecord>>('/static-sites', { limit: args.limit, offset: args.offset })
          const needle = args.search?.toLowerCase()
          const items = page.data
            .filter((s) => !needle || `${s.name} ${s.display_name}`.toLowerCase().includes(needle))
            .map(summarizeStaticSiteListItem)
          result.static_sites = needle ? { total: items.length, items } : { total: page.total, items }
        }
      }),
    )
    return toolResult(result)
  },
})

export const getApplication = readTool({
  name: 'get_application',
  title: 'Get Sevalla application',
  description:
    'Returns a Sevalla application with its processes (web, worker, cron, job) with scaling, probes, disks and job timing, domains with DNS records and verification errors, and latest deployment. History: list_deployments. Logs: search_runtime_logs, get_deployment_logs.',
  input: z.object({ application_id: uuid('Application ID (list_services).'), detail }).strict(),
  run: async ({ application_id, detail }, { api }) => {
    const base = encodePath`/applications/${application_id}`
    const [app, processes, domains, deployments] = await Promise.all([
      api.get<ApiRecord>(base),
      firstPage(api, `${base}/processes`),
      firstPage(api, `${base}/domains`),
      api.get<Page<ApiRecord>>(`${base}/deployments`, { limit: 1 }),
    ])
    const more = unlisted({ listProcessesV3: processes, listApplicationDomainsV3: domains })
    if (detail === 'full') {
      return toolResult({
        ...app,
        processes: processes.data,
        domains: domains.data,
        latest_deployment: deployments.data[0] ?? null,
        more,
      })
    }
    return toolResult(
      omitEmpty({
        id: app.id,
        name: app.name,
        display_name: app.display_name,
        status: app.status,
        source: app.source,
        repo_url: app.repo_url,
        default_branch: app.default_branch,
        docker_image: app.docker_image,
        build_type: app.build_type,
        auto_deploy: app.auto_deploy,
        suspended: app.is_suspended === true ? true : undefined,
        hibernation_after_seconds: app.hibernation_enabled ? app.hibernate_after_seconds : undefined,
        cdn_enabled: app.is_cdn_enabled,
        edge_cache_enabled: app.is_edge_cache_enabled,
        project_id: app.project_id,
        cluster_id: app.cluster_id,
        processes: processes.data.map(summarizeProcess),
        domains: domains.data.map(summarizeDomain),
        latest_deployment: summarizeDeployment(deployments.data[0]),
        more,
      }),
    )
  },
})

export const getStaticSite = readTool({
  name: 'get_static_site',
  title: 'Get Sevalla static site',
  description:
    'Returns a Sevalla static site with its build settings, domains with DNS records and verification errors, and latest deployment. History: list_deployments.',
  input: z.object({ static_site_id: uuid('Static site ID (list_services).'), detail }).strict(),
  run: async ({ static_site_id, detail }, { api }) => {
    const base = encodePath`/static-sites/${static_site_id}`
    const [site, domains, deployments] = await Promise.all([
      api.get<ApiRecord>(base),
      firstPage(api, `${base}/domains`),
      api.get<Page<ApiRecord>>(`${base}/deployments`, { limit: 1 }),
    ])
    const more = unlisted({ listStaticSiteDomainsV3: domains })
    if (detail === 'full') {
      return toolResult({ ...site, domains: domains.data, latest_deployment: deployments.data[0] ?? null, more })
    }
    return toolResult(
      omitEmpty({
        id: site.id,
        name: site.name,
        display_name: site.display_name,
        status: site.status,
        hostname: site.hostname,
        repo_url: site.repo_url,
        default_branch: site.default_branch,
        auto_deploy: site.auto_deploy,
        preview_deployments: site.is_preview_enabled,
        install_command: site.install_command,
        build_command: site.build_command,
        published_directory: site.published_directory,
        root_directory: site.root_directory,
        node_version: site.node_version,
        project_id: site.project_id,
        domains: domains.data.map(summarizeDomain),
        latest_deployment: summarizeDeployment(deployments.data[0]),
        more,
      }),
    )
  },
})

const endpoint = (host: unknown, port: unknown) =>
  typeof host === 'string' && host.length > 0 ? `${host}${port ? `:${port}` : ''}` : null

export const getDatabase = readTool({
  name: 'get_database',
  title: 'Get Sevalla database',
  description:
    'Returns a Sevalla database: engine, version, status, size, internal and external endpoints, recent backups and internal connections to applications. Passwords are not included. Usage over time: get_metrics.',
  input: z.object({ database_id: uuid('Database ID (list_services).'), detail }).strict(),
  run: async ({ database_id, detail }, { api }) => {
    const base = encodePath`/databases/${database_id}`
    const [db, backups, connections] = await Promise.all([
      api.get<ApiRecord>(base),
      api.get<ApiRecord[]>(`${base}/backups`),
      api.get<ApiRecord[]>(`${base}/internal-connections`),
    ])
    if (detail === 'full') {
      return toolResult({ ...db, backups, internal_connections: connections })
    }
    return toolResult(
      omitEmpty({
        id: db.id,
        name: db.name,
        display_name: db.display_name,
        type: db.type,
        version: db.version,
        status: db.status,
        suspended: db.is_suspended === true ? true : undefined,
        size: db.resource_type_name,
        cpu_millicores: db.cpu_limit,
        memory_mb: db.memory_limit,
        storage_mb: db.storage_size,
        db_name: db.db_name,
        db_user: db.db_user,
        internal_endpoint: endpoint(db.internal_hostname, db.internal_port),
        external_endpoint: endpoint(db.external_hostname, db.external_port) ?? 'disabled',
        cluster: db.cluster_display_name ?? db.cluster_id,
        project_id: db.project_id,
        backups: [...backups]
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          .slice(0, 10)
          .map((b) => ({ id: b.id, type: b.type, created_at: b.created_at, expires_at: b.expires_at })),
        backup_count: backups.length,
        internal_connections: connections.map((c) =>
          c.source_id === db.id
            ? {
                id: c.id,
                service_id: c.target_id,
                service_name: c.target_display_name ?? c.target_name,
                service_type: c.target_type,
              }
            : {
                id: c.id,
                service_id: c.source_id,
                service_name: c.source_display_name ?? c.source_name,
                service_type: c.source_type,
              },
        ),
      }),
    )
  },
})

export const getPlatformOptions = readTool({
  name: 'get_platform_options',
  title: 'Get Sevalla regions and sizes',
  description:
    'Lists Sevalla regions (clusters) and machine sizes for application processes and databases, with CPU, memory and storage limits. create_application, create_database and scale_process take these IDs.',
  input: z
    .object({
      kind: z.enum(['application', 'database']).optional().describe('Sizes for one kind only. Default: both.'),
    })
    .strict(),
  run: async ({ kind }, { api }) => {
    const [clusters, processSizes, databaseSizes] = await Promise.all([
      api.get<ApiRecord[]>('/resources/clusters'),
      kind === 'database' ? Promise.resolve(undefined) : api.get<ApiRecord[]>('/resources/process-resource-types'),
      kind === 'application' ? Promise.resolve(undefined) : api.get<ApiRecord[]>('/resources/database-resource-types'),
    ])
    return toolResult(
      omitEmpty({
        clusters: clusters.map((c) =>
          omitEmpty({ id: c.id, name: c.display_name ?? c.name, location: c.location, provider: c.provider }),
        ),
        application_sizes: processSizes?.map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          cpu_millicores: s.cpu_limit,
          memory_mb: s.memory_limit,
        })),
        database_sizes: databaseSizes?.map((s) => ({
          id: s.id,
          name: s.name,
          cpu_millicores: s.cpu_limit,
          memory_mb: s.memory_limit,
          storage_mb: s.storage_limit,
        })),
      }),
    )
  },
})

export const SERVICE_TOOLS = [listServices, getApplication, getStaticSite, getDatabase, getPlatformOptions]
