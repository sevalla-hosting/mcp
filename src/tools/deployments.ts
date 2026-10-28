import { z } from 'zod'
import { encodePath } from '../sevalla/client.ts'
import { readTool, ToolInputError, writeTool } from './define.ts'
import { formatLogLine, matchesText, sortLogs, toolResult, type LogEntry } from './format.ts'
import { summarizeDeployment } from './services.ts'
import { detail, serviceType, uuid, type ApiRecord, type Page } from './schemas.ts'

type ServiceType = 'application' | 'static_site'

const serviceBase = (type: ServiceType, id: string) =>
  type === 'application' ? encodePath`/applications/${id}` : encodePath`/static-sites/${id}`

const serviceId = uuid('Application or static site ID (list_services).')

const deploymentId = uuid('Deployment ID (list_deployments).')

export const listDeployments = readTool({
  name: 'list_deployments',
  title: 'List Sevalla deployments',
  description:
    'Lists deployments of a Sevalla application or static site, newest first, with status, trigger, branch, commit and timing.',
  input: z
    .object({
      service_type: serviceType,
      service_id: serviceId,
      limit: z.number().int().min(1).max(50).default(10).describe('Maximum deployments returned.'),
      offset: z.number().int().min(0).max(10_000).default(0).describe('Deployments skipped, for paging.'),
    })
    .strict(),
  run: async ({ service_type, service_id, limit, offset }, { api }) => {
    const page = await api.get<Page<ApiRecord>>(`${serviceBase(service_type, service_id)}/deployments`, {
      limit,
      offset,
    })
    return toolResult({ total: page.total, deployments: page.data.map(summarizeDeployment) })
  },
})

export const getDeployment = readTool({
  name: 'get_deployment',
  title: 'Get Sevalla deployment',
  description:
    'Returns a deployment of a Sevalla application or static site: status, steps, branch, commit, image and timing. It reports the progress of deployments started by trigger_deployment or rollback_deployment. Output and failure causes: get_deployment_logs.',
  input: z.object({ service_type: serviceType, service_id: serviceId, deployment_id: deploymentId, detail }).strict(),
  run: async ({ service_type, service_id, deployment_id, detail }, { api }) => {
    const deployment = await api.get<ApiRecord>(
      `${serviceBase(service_type, service_id)}${encodePath`/deployments/${deployment_id}`}`,
    )
    if (detail === 'full') {
      return toolResult(deployment)
    }
    return toolResult({ ...summarizeDeployment(deployment), steps: deployment.steps })
  },
})

const ERROR_PATTERN = /(error|exception)s?\b|\b(failed|failure|fatal|panic|cannot|denied|not found)\b|\berr!/i
const MAX_SCAN = 2000

const isErrorLine = (entry: LogEntry) => ERROR_PATTERN.test(entry.message ?? '')

export const getDeploymentLogs = readTool({
  name: 'get_deployment_logs',
  title: 'Get Sevalla deployment logs',
  description:
    'Returns the build and rollout log of a deployment of a Sevalla application or static site, one line per entry, by default the last 100 lines. errors_only keeps lines mentioning errors, failures or exceptions. Running application logs: search_runtime_logs.',
  input: z
    .object({
      service_type: serviceType,
      service_id: serviceId,
      deployment_id: deploymentId,
      errors_only: z.boolean().default(false).describe('Only lines that look like errors.'),
      search: z.string().min(1).max(200).optional().describe('Only lines containing this text (case-insensitive).'),
      limit: z.number().int().min(1).max(500).default(100).describe('Maximum lines returned.'),
      position: z.enum(['end', 'start']).default('end').describe('Last (end) or first (start) matching lines.'),
    })
    .strict(),
  run: async (args, { api }) => {
    const base = `${serviceBase(args.service_type, args.service_id)}${encodePath`/deployments/${args.deployment_id}`}`
    const deployment = await api.get<ApiRecord>(base)
    const startedAt = new Date(deployment.started_at ?? deployment.created_at ?? Date.now())
    const finishedAt = deployment.finished_at ? new Date(deployment.finished_at) : new Date()
    const from = new Date(startedAt.getTime() - 60_000).toISOString()
    const to = new Date(Math.min(finishedAt.getTime() + 120_000, Date.now())).toISOString()
    const scanning = args.errors_only || args.search !== undefined || args.position === 'start'
    const limit = scanning ? MAX_SCAN : args.limit
    const entries = sortLogs(await api.get<LogEntry[]>(`${base}/logs`, { from, to, limit }))
    const matching = entries.filter((e) => (!args.errors_only || isErrorLine(e)) && matchesText(e, args.search))
    const shown = args.position === 'end' ? matching.slice(-args.limit) : matching.slice(0, args.limit)
    const more = entries.length >= limit
    const scope = scanning
      ? `${shown.length} of ${matching.length} matching lines${more ? ` among the latest ${MAX_SCAN} lines` : ''}`
      : `the last ${shown.length} lines${more ? '; earlier lines exist' : ''}`
    const header = `Deployment ${deployment.id} (${deployment.status}): ${scope}.`
    return toolResult([header, ...shown.map(formatLogLine)].join('\n'))
  },
})

export const triggerDeployment = writeTool('update', {
  name: 'trigger_deployment',
  title: 'Deploy Sevalla service',
  description:
    'Starts a deployment of a Sevalla application or static site: by default the latest commit of the default branch. Applications can also deploy a specific commit or rebuild without the build cache. It runs asynchronously and replaces the running version when it succeeds; get_deployment reports progress.',
  input: z
    .object({
      service_type: serviceType,
      service_id: serviceId,
      branch: z.string().min(1).max(255).optional().describe('Branch to deploy instead of the default branch.'),
      commit_sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional()
        .describe('Applications only: full 40-character SHA of a commit on the branch.'),
      docker_image: z.string().min(1).max(512).optional().describe('Image to deploy, for Docker-based applications.'),
      restart: z.boolean().optional().describe('Applications only: redeploy the current build without rebuilding.'),
      skip_build_cache: z.boolean().optional().describe('Applications only: rebuild without the build cache.'),
    })
    .strict(),
  run: async ({ service_type, service_id, branch, commit_sha, docker_image, restart, skip_build_cache }, { api }) => {
    if (
      service_type === 'static_site' &&
      [commit_sha, docker_image, restart, skip_build_cache].some((v) => v !== undefined)
    ) {
      throw new ToolInputError('commit_sha, docker_image, restart and skip_build_cache apply to applications only.')
    }
    const body =
      service_type === 'application'
        ? { branch, commit_sha, docker_image, is_restart: restart, skip_build_cache }
        : { branch }
    const deployment = await api.post<ApiRecord>(`${serviceBase(service_type, service_id)}/deployments`, body)
    return toolResult({ deployment: summarizeDeployment(deployment), next: 'get_deployment reports progress.' })
  },
})

export const rollbackDeployment = writeTool('update', {
  name: 'rollback_deployment',
  title: 'Roll back Sevalla service',
  description:
    'Rolls a Sevalla application or static site back to an earlier successful deployment. Applications redeploy the build of their most recent successful one. Static sites rebuild the commit of deployment_id or, by default, of the last successful one before the current, with the current settings and variables. get_deployment reports progress.',
  input: z
    .object({
      service_type: serviceType,
      service_id: serviceId,
      deployment_id: uuid('Static sites only: deployment to redeploy.').optional(),
    })
    .strict(),
  run: async ({ service_type, service_id, deployment_id }, { api }) => {
    const base = serviceBase(service_type, service_id)
    if (service_type === 'application') {
      if (deployment_id) {
        throw new ToolInputError(
          'Applications always roll back to their most recent successful deployment; deployment_id applies to static sites only.',
        )
      }
      const deployment = await api.post<ApiRecord>(`${base}/deployments/rollback`)
      return toolResult({ deployment: summarizeDeployment(deployment), next: 'get_deployment reports progress.' })
    }
    let target = deployment_id
    if (!target) {
      const page = await api.get<Page<ApiRecord>>(`${base}/deployments`, { limit: 25 })
      const live = page.data.findIndex((d) => d.status === 'success')
      target = page.data.slice(live + 1).find((d) => d.status === 'success')?.id
      if (!target) {
        throw new ToolInputError('No earlier successful deployment was found for this static site.')
      }
    }
    const deployment = await api.post<ApiRecord>(`${base}/deployments`, { deployment_id: target })
    return toolResult({
      deployment: summarizeDeployment(deployment),
      redeployed_from: target,
      next: 'get_deployment reports progress.',
    })
  },
})

export const DEPLOYMENT_TOOLS = [
  listDeployments,
  getDeployment,
  getDeploymentLogs,
  triggerDeployment,
  rollbackDeployment,
]
