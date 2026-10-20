import { readFileSync } from 'node:fs'
import type { HttpMethod } from './client.ts'

export type OperationClass = 'read' | 'create' | 'update' | 'delete'

export interface ParameterSchema {
  type?: string
  enum?: unknown[]
  default?: unknown
  format?: string
  pattern?: string
  minimum?: number
  maximum?: number
  description?: string
  nullable?: boolean
  [key: string]: unknown
}

export interface OperationParameter {
  name: string
  in: 'path' | 'query'
  required: boolean
  description?: string
  schema: ParameterSchema
}

export interface Operation {
  id: string
  method: HttpMethod
  path: string
  tag: string
  summary: string
  description: string
  params: OperationParameter[]
  body: Record<string, unknown> | null
  bodyRequired: boolean
  permissions?: string[]
  class: OperationClass
  dedicatedTool?: string
}

interface Snapshot {
  source: string
  version: string
  operations: Omit<Operation, 'class' | 'dedicatedTool'>[]
}

export const API_DOCS_URL = 'https://api-docs.sevalla.com'

export const ADDITIVE_OPERATIONS = new Set([
  'addApplicationDomainV3',
  'addStaticSiteDomainV3',
  'cloneApplicationV3',
  'createApplicationInternalConnectionV3',
  'createApplicationPrivatePortV3',
  'createApplicationV3',
  'createDatabaseBackupV3',
  'createDatabaseInternalConnectionV3',
  'createDatabaseV3',
  'createDeviceCodeV3',
  'createDockerRegistryV3',
  'createEnvironmentVariableV3',
  'createGlobalEnvVarV3',
  'createLoadBalancerV3',
  'createObjectStorageV3',
  'createPipelineStageV3',
  'createPipelineV3',
  'createProcessV3',
  'createProjectV3',
  'createStaticSiteEnvVarV3',
  'createStaticSiteV3',
])

export const DEDICATED_TOOLS: Record<string, string> = {
  listApplicationsV3: 'list_services',
  listStaticSitesV3: 'list_services',
  listDatabasesV3: 'list_services',
  getApplicationV3: 'get_application',
  listProcessesV3: 'get_application',
  getProcessV3: 'get_application',
  listApplicationDomainsV3: 'get_application',
  getStaticSiteV3: 'get_static_site',
  listStaticSiteDomainsV3: 'get_static_site',
  getDatabaseV3: 'get_database',
  listDatabaseBackupsV3: 'get_database',
  listDatabaseInternalConnectionsV3: 'get_database',
  listClustersV3: 'get_platform_options',
  listProcessResourceTypesV3: 'get_platform_options',
  listDatabaseResourceTypesV3: 'get_platform_options',
  listDeploymentsV3: 'list_deployments',
  listStaticSiteDeploymentsV3: 'list_deployments',
  getDeploymentV3: 'get_deployment',
  getStaticSiteDeploymentV3: 'get_deployment',
  getApplicationDeploymentLogsV3: 'get_deployment_logs',
  getStaticSiteDeploymentLogsV3: 'get_deployment_logs',
  getApplicationRuntimeLogsV3: 'search_runtime_logs',
  getApplicationAccessLogsV3: 'search_access_logs',
  getStaticSiteAccessLogsV3: 'search_access_logs',
  listEnvironmentVariablesV3: 'list_environment_variables',
  listStaticSiteEnvVarsV3: 'list_environment_variables',
  listGlobalEnvVarsV3: 'list_environment_variables',
  createEnvironmentVariableV3: 'set_environment_variables',
  updateEnvironmentVariableV3: 'set_environment_variables',
  createStaticSiteEnvVarV3: 'set_environment_variables',
  updateStaticSiteEnvVarV3: 'set_environment_variables',
  createGlobalEnvVarV3: 'set_environment_variables',
  updateGlobalEnvVarV3: 'set_environment_variables',
  deleteEnvironmentVariableV3: 'delete_environment_variables',
  deleteStaticSiteEnvVarV3: 'delete_environment_variables',
  deleteGlobalEnvVarV3: 'delete_environment_variables',
  triggerDeploymentV3: 'trigger_deployment',
  deployStaticSiteV3: 'trigger_deployment',
  rollbackDeploymentV3: 'rollback_deployment',
  updateProcessV3: 'scale_process',
  addApplicationDomainV3: 'add_domain',
  addStaticSiteDomainV3: 'add_domain',
  createApplicationV3: 'create_application',
  createStaticSiteV3: 'create_static_site',
  createDatabaseV3: 'create_database',
  createDatabaseInternalConnectionV3: 'create_database',
}

const METRIC_PATH = /\/metrics\//

const UNAVAILABLE: Record<string, string> = {
  createDeviceCodeV3: 'Device authorization is part of the sign-in flow and is not available as a tool.',
  pollDeviceCodeV3: 'Device authorization is part of the sign-in flow and is not available as a tool.',
  openTerminalV3: 'Interactive terminal sessions need a WebSocket client and are not available as a tool.',
}

const ENV_VAR_VALUE_FIELDS: Record<string, string[]> = {
  listEnvironmentVariablesV3: ['value'],
  listStaticSiteEnvVarsV3: ['value'],
  listGlobalEnvVarsV3: ['value'],
  createEnvironmentVariableV3: ['value'],
  updateEnvironmentVariableV3: ['value'],
  createStaticSiteEnvVarV3: ['value'],
  updateStaticSiteEnvVarV3: ['value'],
  createGlobalEnvVarV3: ['value'],
  updateGlobalEnvVarV3: ['value'],
}

export const classify = (method: HttpMethod, id: string): OperationClass => {
  if (method === 'GET') {
    return 'read'
  }
  if (method === 'DELETE') {
    return 'delete'
  }
  return ADDITIVE_OPERATIONS.has(id) ? 'create' : 'update'
}

const loadSnapshot = (): Snapshot => JSON.parse(readFileSync(new URL('./operations.json', import.meta.url), 'utf8'))

const snapshot = loadSnapshot()

export const SNAPSHOT_SOURCE = snapshot.source

export const OPERATIONS: Operation[] = snapshot.operations.map((op) => ({
  ...op,
  class: classify(op.method, op.id),
  dedicatedTool: DEDICATED_TOOLS[op.id] ?? (METRIC_PATH.test(op.path) ? 'get_metrics' : undefined),
}))

const BY_ID = new Map(OPERATIONS.map((op) => [op.id, op]))

export const getOperation = (id: string): Operation | undefined => BY_ID.get(id)

export const unavailableReason = (op: Operation): string | undefined => UNAVAILABLE[op.id]

export const isExecutable = (op: Operation): boolean =>
  op.dedicatedTool === undefined && unavailableReason(op) === undefined

export const executorToolFor = (cls: OperationClass): string => `sevalla_api_${cls}`

export const secretFieldsFor = (op: Operation): Set<string> => new Set(ENV_VAR_VALUE_FIELDS[op.id] ?? [])

export class OperationInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperationInputError'
  }
}

const describeValue = (value: unknown): string => {
  if (value === null) {
    return 'null'
  }
  return Array.isArray(value) ? 'an array' : typeof value
}

export const fillPath = (op: Operation, pathParams: Record<string, unknown> = {}): string => {
  const expected = op.params.filter((p) => p.in === 'path')
  const unknown = Object.keys(pathParams).filter((name) => !expected.some((p) => p.name === name))
  if (unknown.length > 0) {
    throw new OperationInputError(
      `Unknown path parameter(s) for ${op.id}: ${unknown.join(', ')}. Expected: ${expected.map((p) => p.name).join(', ') || 'none'}.`,
    )
  }
  return expected.reduce((path, param) => {
    const value = pathParams[param.name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new OperationInputError(`path_params.${param.name} is required for ${op.id} (got ${describeValue(value)}).`)
    }
    if (param.schema.pattern && !new RegExp(param.schema.pattern).test(value)) {
      throw new OperationInputError(`path_params.${param.name} must be a valid ${param.description ?? param.name}.`)
    }
    if (/[/\\?#]|\.\./.test(value)) {
      throw new OperationInputError(`path_params.${param.name} contains characters that are not allowed.`)
    }
    return path.replace(`{${param.name}}`, encodeURIComponent(value))
  }, op.path)
}

export const checkQuery = (
  op: Operation,
  query: Record<string, unknown> = {},
): Record<string, string | number | boolean> => {
  const allowed = op.params.filter((p) => p.in === 'query')
  const out: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(query)) {
    const param = allowed.find((p) => p.name === name)
    if (!param) {
      throw new OperationInputError(
        `Unknown query parameter "${name}" for ${op.id}. Allowed: ${allowed.map((p) => p.name).join(', ') || 'none'}.`,
      )
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new OperationInputError(`query.${name} must be a string, number or boolean (got ${describeValue(value)}).`)
    }
    out[name] = value
  }
  for (const param of allowed) {
    if (param.required && out[param.name] === undefined) {
      throw new OperationInputError(`query.${param.name} is required for ${op.id}.`)
    }
  }
  return out
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'to',
  'for',
  'in',
  'on',
  'and',
  'or',
  'my',
  'me',
  'get',
  'with',
  'by',
  'into',
  'other',
  'another',
  'v3',
])

export const tokenize = (text: string): string[] =>
  text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t))

const stem = (token: string) => token.replace(/(ies|es|s)$/, (m) => (m === 'ies' ? 'y' : ''))

const SYNONYMS: Record<string, string[]> = {
  app: ['application'],
  db: ['database'],
  add: ['create'],
  remove: ['delete'],
  copy: ['clone'],
  duplicate: ['clone'],
  move: ['clone', 'add'],
  stop: ['suspend', 'cancel'],
  pause: ['suspend'],
  abort: ['cancel'],
  start: ['activate', 'trigger'],
  resume: ['activate'],
  restart: ['trigger'],
  deploy: ['deployment'],
  worker: ['process'],
  job: ['process'],
  region: ['cluster'],
  location: ['cluster'],
}

const bodyFields = (op: Operation) => Object.keys((op.body?.properties ?? {}) as Record<string, unknown>)

const SEARCH_INDEX = OPERATIONS.map((op) => ({
  op,
  primary: new Set([...tokenize(op.id), ...tokenize(op.summary)].map(stem)),
  tagged: new Set(tokenize(op.tag).map(stem)),
  secondary: new Set(
    [...tokenize(op.path), ...tokenize(op.description), ...bodyFields(op).flatMap(tokenize)].map(stem),
  ),
}))

const termScore = ({ primary, tagged, secondary }: (typeof SEARCH_INDEX)[number], term: string) =>
  (primary.has(term) ? 3 : tagged.has(term) ? 2 : 0) + (secondary.has(term) ? 1 : 0)

export interface SearchOptions {
  query?: string
  cls?: OperationClass
  tag?: string
  limit?: number
}

export const searchOperations = ({ query, cls, tag, limit = 5 }: SearchOptions): Operation[] => {
  const concepts = [...new Set(tokenize(query ?? '').map(stem))].map((term) => [
    term,
    ...(SYNONYMS[term] ?? []).map(stem),
  ])
  return SEARCH_INDEX.filter(
    ({ op }) => (!cls || op.class === cls) && (!tag || op.tag.toLowerCase() === tag.toLowerCase()),
  )
    .map((entry) => ({
      op: entry.op,
      score: concepts.reduce((sum, terms) => sum + Math.max(...terms.map((term) => termScore(entry, term))), 0),
      words: entry.primary.size,
    }))
    .filter(({ score }) => concepts.length === 0 || score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (concepts.length > 0 ? a.words - b.words : 0) ||
        Number(isExecutable(b.op)) - Number(isExecutable(a.op)) ||
        a.op.id.localeCompare(b.op.id),
    )
    .slice(0, limit)
    .map(({ op }) => op)
}

export const TAGS = [...new Set(OPERATIONS.map((op) => op.tag))].sort()
