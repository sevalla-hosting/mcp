import { z } from 'zod'
import { ApiError, encodePath, type ReadOnlyClient, type SevallaClient } from '../sevalla/client.ts'
import { readTool, ToolInputError, writeTool } from './define.ts'
import { formatApiErrorShort, omitEmpty, toolResult } from './format.ts'
import { summarizeDeployment, summarizeDomain, summarizeProcess } from './services.ts'
import { serviceType, uuid, type ApiRecord, type Page } from './schemas.ts'

type Scope = 'application' | 'static_site' | 'global'

const scope = z
  .enum(['application', 'static_site', 'global'])
  .describe(
    'One application, one static site, or global (company-wide variables every application inherits unless it sets the same key).',
  )

const scopedServiceId = uuid('Application or static site ID (list_services). Not used with scope global.').optional()

const envBase = (s: Scope, serviceId: string | undefined): string => {
  if (s === 'global') {
    if (serviceId) {
      throw new ToolInputError('service_id is not used with scope global.')
    }
    return '/applications/global-env-vars'
  }
  if (!serviceId) {
    throw new ToolInputError(`service_id is required with scope ${s}.`)
  }
  return s === 'application'
    ? encodePath`/applications/${serviceId}/env-vars`
    : encodePath`/static-sites/${serviceId}/env-vars`
}

const MAX_VARIABLES = 1000

export const listAllVariables = async (api: ReadOnlyClient, base: string): Promise<ApiRecord[]> => {
  const all: ApiRecord[] = []
  while (all.length < MAX_VARIABLES) {
    const page = await api.get<Page<ApiRecord>>(base, { limit: 100, offset: all.length })
    all.push(...page.data)
    if (page.data.length < 100 || all.length >= page.total) {
      break
    }
  }
  return all
}

const summarizeVariable = (variable: ApiRecord) =>
  omitEmpty({
    key: variable.key,
    id: variable.id,
    runtime: variable.is_runtime ?? undefined,
    buildtime: variable.is_buildtime ?? undefined,
    production: variable.is_production ?? undefined,
    preview: variable.is_preview ?? undefined,
    branch: variable.branch ?? undefined,
  })

export const listEnvironmentVariables = readTool({
  name: 'list_environment_variables',
  title: 'List Sevalla environment variables',
  description:
    'Lists the environment variables of a Sevalla application, static site or the company-wide global set, with their build, runtime, preview and branch scoping. Stored values are withheld.',
  input: z.object({ scope, service_id: scopedServiceId }).strict(),
  run: async (args, { api }) => {
    const variables = await listAllVariables(api, envBase(args.scope, args.service_id))
    return toolResult({ total: variables.length, variables: variables.map(summarizeVariable) })
  },
})

const variableInput = z
  .object({
    key: z.string().min(1).max(255).describe('Name, e.g. DATABASE_URL.'),
    value: z.string().max(32_768).describe('Value; stored encrypted, never echoed.'),
    runtime: z.boolean().optional().describe('Applications, global: available at runtime (new: true).'),
    buildtime: z.boolean().optional().describe('Applications, global: available during builds (new: true).'),
    production: z.boolean().optional().describe('Static sites: used in production (new: true).'),
    preview: z.boolean().optional().describe('Static sites: used in previews (new: true).'),
    branch: z.string().min(1).max(255).optional().describe('Static sites: only this branch.'),
  })
  .strict()

const bodyFor = (s: Scope, v: z.infer<typeof variableInput>, includeKey: boolean) => {
  if (s === 'static_site') {
    if (v.runtime !== undefined || v.buildtime !== undefined) {
      throw new ToolInputError(
        `runtime and buildtime apply to applications and global variables, not static sites (${v.key}).`,
      )
    }
    return omitEmpty({
      key: includeKey ? v.key : undefined,
      value: v.value,
      is_production: v.production,
      is_preview: v.preview,
      branch: v.branch,
    })
  }
  if (v.production !== undefined || v.preview !== undefined || v.branch !== undefined) {
    throw new ToolInputError(`production, preview and branch apply to static sites only (${v.key}).`)
  }
  return omitEmpty({
    key: includeKey ? v.key : undefined,
    value: v.value,
    is_runtime: v.runtime,
    is_buildtime: v.buildtime,
  })
}

const redeploy = async (api: SevallaClient, s: Scope, serviceId: string | undefined) => {
  if (s === 'global' || !serviceId) {
    return undefined
  }
  const path =
    s === 'application'
      ? encodePath`/applications/${serviceId}/deployments`
      : encodePath`/static-sites/${serviceId}/deployments`
  return summarizeDeployment(await api.post<ApiRecord>(path, {}))
}

const redeployInput = z
  .boolean()
  .default(false)
  .describe('Deploy afterwards so the change takes effect now (applications and static sites).')

const pending = 'The change takes effect at the next deployment of each affected service.'

export const setEnvironmentVariables = writeTool('update', {
  name: 'set_environment_variables',
  title: 'Set Sevalla environment variables',
  idempotent: true,
  description:
    'Creates or updates environment variables of a Sevalla application, static site or the company-wide global set; other variables stay unchanged and values are never echoed. Changes apply at the next deployment.',
  input: z
    .object({
      scope,
      service_id: scopedServiceId,
      variables: z.array(variableInput).min(1).max(50).describe('Variables to create or update.'),
      redeploy: redeployInput,
    })
    .strict(),
  run: async (args, { api }) => {
    const base = envBase(args.scope, args.service_id)
    const keys = args.variables.map((v) => v.key)
    const duplicates = keys.filter((key, i) => keys.indexOf(key) !== i)
    if (duplicates.length > 0) {
      throw new ToolInputError(`Each key may appear once; repeated: ${[...new Set(duplicates)].join(', ')}.`)
    }
    const bodies = args.variables.map((v) => ({
      v,
      create: bodyFor(args.scope, v, true),
      update: bodyFor(args.scope, v, false),
    }))
    const existing = new Map((await listAllVariables(api, base)).map((v) => [v.key as string, v]))
    const created: string[] = []
    const updated: string[] = []
    const failed: { key: string; error: string }[] = []
    for (const { v, create, update } of bodies) {
      const current = existing.get(v.key)
      try {
        if (current) {
          await api.put(`${base}${encodePath`/${current.id}`}`, update)
          updated.push(v.key)
        } else {
          await api.post(base, create)
          created.push(v.key)
        }
      } catch (err) {
        if (!(err instanceof ApiError)) {
          throw err
        }
        failed.push({ key: v.key, error: formatApiErrorShort(err) })
      }
    }
    const deployment =
      args.redeploy && failed.length === 0 ? await redeploy(api, args.scope, args.service_id) : undefined
    return toolResult(
      omitEmpty({
        created,
        updated,
        failed,
        deployment,
        note: deployment ? 'get_deployment reports the progress of the deployment.' : pending,
      }),
    )
  },
})

export const deleteEnvironmentVariables = writeTool('delete', {
  name: 'delete_environment_variables',
  title: 'Delete Sevalla environment variables',
  description:
    'Deletes environment variables by key from a Sevalla application, static site or the company-wide global set. Changes apply at the next deployment.',
  input: z
    .object({
      scope,
      service_id: scopedServiceId,
      keys: z.array(z.string().min(1).max(255)).min(1).max(50).describe('Keys to delete.'),
      redeploy: redeployInput,
    })
    .strict(),
  run: async (args, { api }) => {
    const base = envBase(args.scope, args.service_id)
    const existing = await listAllVariables(api, base)
    const deleted: string[] = []
    const failed: { key: string; error: string }[] = []
    for (const key of new Set(args.keys)) {
      for (const variable of existing.filter((v) => v.key === key)) {
        try {
          await api.delete(`${base}${encodePath`/${variable.id}`}`)
          deleted.push(key)
        } catch (err) {
          if (!(err instanceof ApiError)) {
            throw err
          }
          failed.push({ key, error: formatApiErrorShort(err) })
        }
      }
    }
    const notFound = [...new Set(args.keys)].filter((key) => !existing.some((v) => v.key === key))
    const deployment =
      args.redeploy && deleted.length > 0 && failed.length === 0
        ? await redeploy(api, args.scope, args.service_id)
        : undefined
    return toolResult(
      omitEmpty({
        deleted,
        not_found: notFound,
        failed,
        deployment,
        note:
          deleted.length === 0
            ? undefined
            : deployment
              ? 'get_deployment reports the progress of the deployment.'
              : pending,
      }),
    )
  },
})

export const scaleProcess = writeTool('update', {
  name: 'scale_process',
  title: 'Scale Sevalla process',
  idempotent: true,
  openWorld: false,
  description:
    'Sets how a Sevalla application process scales: fixed instances or an autoscaling range, and/or its machine size. Bigger sizes and more instances cost more. By default the application restarts from its current build so the change applies now. The start command, port, health checks and cron schedule are other fields of updateProcessV3, which sevalla_api_update runs.',
  input: z
    .object({
      application_id: uuid('Application ID (list_services).'),
      process_id: uuid('Process ID (get_application).'),
      instances: z.number().int().min(0).max(50).optional().describe('Fixed instance count; 0 stops the process.'),
      autoscaling: z
        .object({
          min_instances: z.number().int().min(0).max(50),
          max_instances: z.number().int().min(1).max(50),
          target_cpu_percent: z.number().int().min(1).max(100).optional(),
          target_memory_percent: z.number().int().min(1).max(100).optional(),
        })
        .strict()
        .optional()
        .describe('Autoscaling range with CPU and/or memory targets.'),
      size_id: uuid('Size ID (get_platform_options).').optional(),
      apply_now: z.boolean().default(true).describe('Restart now so the change applies.'),
    })
    .strict(),
  run: async (args, { api }) => {
    if (args.instances === undefined && args.autoscaling === undefined && args.size_id === undefined) {
      throw new ToolInputError('At least one of instances, autoscaling or size_id is required.')
    }
    if (args.instances !== undefined && args.autoscaling !== undefined) {
      throw new ToolInputError('instances (fixed scaling) and autoscaling are mutually exclusive.')
    }
    if (args.autoscaling && args.autoscaling.min_instances > args.autoscaling.max_instances) {
      throw new ToolInputError('autoscaling.min_instances must not exceed autoscaling.max_instances.')
    }
    if (args.autoscaling && !args.autoscaling.target_cpu_percent && !args.autoscaling.target_memory_percent) {
      throw new ToolInputError('autoscaling needs target_cpu_percent and/or target_memory_percent.')
    }
    const scaling =
      args.instances !== undefined
        ? { type: 'manual', config: { instanceCount: args.instances } }
        : args.autoscaling
          ? {
              type: 'horizontal',
              config: omitEmpty({
                minInstanceCount: args.autoscaling.min_instances,
                maxInstanceCount: args.autoscaling.max_instances,
                targetCpuPercent: args.autoscaling.target_cpu_percent,
                targetMemoryPercent: args.autoscaling.target_memory_percent,
              }),
            }
          : undefined
    const process = await api.patch<ApiRecord>(
      encodePath`/applications/${args.application_id}/processes/${args.process_id}`,
      omitEmpty({ scaling_strategy: scaling, resource_type_id: args.size_id }),
    )
    const deployment = args.apply_now
      ? summarizeDeployment(
          await api.post<ApiRecord>(encodePath`/applications/${args.application_id}/deployments`, { is_restart: true }),
        )
      : undefined
    return toolResult(
      omitEmpty({
        process: summarizeProcess(process),
        deployment,
        note: deployment
          ? 'get_deployment reports the progress of the restart.'
          : 'The change takes effect at the next deployment.',
      }),
    )
  },
})

const HOSTNAME = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

export const addDomain = writeTool('create', {
  name: 'add_domain',
  title: 'Add Sevalla custom domain',
  description:
    'Adds a custom domain to a Sevalla application or static site and returns the DNS records to create at the DNS provider. Sevalla then verifies them and issues SSL, or serves a custom certificate when one is given; get_application or get_static_site shows the status.',
  input: z
    .object({
      service_type: serviceType,
      service_id: uuid('Application or static site ID (list_services).'),
      domain: z
        .string()
        .regex(HOSTNAME, 'must be a hostname such as app.example.com')
        .describe('Domain, e.g. app.example.com.'),
      wildcard: z.boolean().default(false).describe('Also serve all subdomains.'),
      ssl_certificate: z
        .string()
        .max(32_000)
        .regex(/-----BEGIN CERTIFICATE-----/, 'must be a PEM certificate')
        .optional()
        .describe('Custom SSL certificate (PEM, with its chain) instead of an issued one.'),
      ssl_private_key: z
        .string()
        .max(32_000)
        .regex(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'must be a PEM private key')
        .optional()
        .describe('PEM private key of ssl_certificate; not returned.'),
    })
    .strict(),
  run: async ({ service_type, service_id, domain, wildcard, ssl_certificate, ssl_private_key }, { api }) => {
    if ((ssl_certificate === undefined) !== (ssl_private_key === undefined)) {
      throw new ToolInputError('ssl_certificate and ssl_private_key are both required when either is given.')
    }
    const path =
      service_type === 'application'
        ? encodePath`/applications/${service_id}/domains`
        : encodePath`/static-sites/${service_id}/domains`
    const created = await api.post<ApiRecord>(
      path,
      omitEmpty({
        domain_name: domain.replace(/^\*\./, ''),
        is_wildcard: wildcard || domain.startsWith('*.'),
        custom_ssl_cert: ssl_certificate,
        custom_ssl_key: ssl_private_key,
      }),
    )
    return toolResult({
      domain: summarizeDomain(created),
      next: 'The domain becomes active once these DNS records exist and verification completes.',
    })
  },
})

export const CONFIGURATION_TOOLS = [
  listEnvironmentVariables,
  setEnvironmentVariables,
  deleteEnvironmentVariables,
  scaleProcess,
  addDomain,
]
