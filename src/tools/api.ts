import { z } from 'zod'
import type { SevallaClient } from '../sevalla/client.ts'
import {
  API_DOCS_URL,
  checkQuery,
  executorToolFor,
  fillPath,
  getOperation,
  isExecutable,
  OPERATIONS,
  searchOperations,
  secretFieldsFor,
  unavailableReason,
  type Operation,
  type OperationClass,
  type ParameterSchema,
} from '../sevalla/operations.ts'
import { readTool, ToolInputError, writeTool, type Tool } from './define.ts'
import { redact, toolResult } from './format.ts'

const describeType = (schema: ParameterSchema | Record<string, any> | undefined): string => {
  if (!schema) {
    return 'any'
  }
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.map((s: Record<string, any>) => describeType(s)).join(' | ')
  }
  const base = Array.isArray(schema.enum)
    ? schema.enum.map((v: unknown) => JSON.stringify(v)).join('|')
    : schema.type === 'array'
      ? `${describeType(schema.items)}[]`
      : String(schema.type ?? 'any')
  return schema.nullable ? `${base} | null` : base
}

const fieldLine = (name: string, schema: Record<string, any>, required: boolean): string => {
  const extras = [
    schema.default !== undefined ? `default ${JSON.stringify(schema.default)}` : undefined,
    schema.minimum !== undefined ? `min ${schema.minimum}` : undefined,
    schema.maximum !== undefined ? `max ${schema.maximum}` : undefined,
  ].filter(Boolean)
  const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : ''
  const description = schema.description ? ` - ${schema.description}` : ''
  return `${name}${required ? ' (required)' : ''}: ${describeType(schema)}${suffix}${description}`
}

const toolFor = (op: Operation): string => {
  if (op.dedicatedTool) {
    return op.dedicatedTool
  }
  const reason = unavailableReason(op)
  return reason ? `unavailable: ${reason}` : executorToolFor(op.class)
}

const describeOperation = (op: Operation, full: boolean) => {
  const pathParams = op.params.filter((p) => p.in === 'path')
  const queryParams = op.params.filter((p) => p.in === 'query')
  const body = op.body as Record<string, any> | null
  const bodyRequired = new Set<string>(Array.isArray(body?.required) ? body.required : [])
  return {
    operation_id: op.id,
    tool: toolFor(op),
    summary: op.summary,
    http: `${op.method} ${op.path}`,
    ...(full ? { description: op.description } : {}),
    ...(pathParams.length > 0
      ? { path_params: pathParams.map((p) => fieldLine(p.name, { ...p.schema, pattern: undefined }, true)) }
      : {}),
    ...(queryParams.length > 0
      ? { query: queryParams.map((p) => fieldLine(p.name, { ...p.schema, description: p.description }, p.required)) }
      : {}),
    ...(body?.properties
      ? full
        ? { body: body }
        : {
            body: Object.entries(body.properties as Record<string, any>).map(([name, schema]) =>
              fieldLine(name, schema ?? {}, bodyRequired.has(name)),
            ),
          }
      : {}),
  }
}

const CLASS_NAMES: Record<OperationClass, string> = {
  read: 'read-only (GET)',
  create: 'create',
  update: 'update',
  delete: 'delete',
}

export const apiSearch = readTool({
  name: 'sevalla_api_search',
  title: 'Search Sevalla API operations',
  description: `Searches all ${OPERATIONS.length} operations of the Sevalla API v3 (reference: ${API_DOCS_URL}), including those behind dedicated tools, by keywords and returns their IDs, parameters, body fields and the tool that runs each. ${OPERATIONS.filter(isExecutable).length} have no dedicated tool, among them the clone, suspend, cancel and promote operations. operation_id returns one operation in full. It reads the API reference, not the account.`,
  input: z
    .object({
      query: z.string().min(1).max(200).optional().describe('Keywords, e.g. "load balancer destination".'),
      operation_id: z
        .string()
        .regex(/^[A-Za-z0-9]+$/)
        .optional()
        .describe('Exact ID for full details.'),
      class: z.enum(['read', 'create', 'update', 'delete']).optional().describe('Only this class.'),
      limit: z.number().int().min(1).max(10).default(5).describe('Maximum operations returned.'),
    })
    .strict(),
  run: async (args) => {
    if (args.operation_id) {
      const op = getOperation(args.operation_id)
      if (!op) {
        throw new ToolInputError(`Unknown operation ${args.operation_id}. A keyword search lists valid operation IDs.`)
      }
      return toolResult(describeOperation(op, true))
    }
    if (!args.query && !args.class) {
      throw new ToolInputError('At least one of query, operation_id or class is required.')
    }
    const results = searchOperations({ query: args.query, cls: args.class, limit: args.limit })
    return toolResult({ results: results.map((op) => describeOperation(op, false)) })
  },
})

const operationId = z
  .string()
  .regex(/^[A-Za-z0-9]+$/, 'must be an operation ID such as listProjectsV3')
  .describe('Operation ID from sevalla_api_search, e.g. listProjectsV3.')

const pathParams = z.record(z.string(), z.string()).optional().describe('Path parameters by name, e.g. {"id": "…"}.')

const query = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe('Query parameters by name.')

const body = z.record(z.string(), z.unknown()).optional().describe('JSON request body.')

interface OperationArgs {
  operation_id: string
  path_params?: Record<string, string>
  query?: Record<string, string | number | boolean>
  body?: Record<string, unknown>
}

const runOperation = async (cls: OperationClass, args: OperationArgs, api: Pick<SevallaClient, 'request'>) => {
  const op = getOperation(args.operation_id)
  if (!op) {
    throw new ToolInputError(`Unknown operation ${args.operation_id}. sevalla_api_search lists valid operation IDs.`)
  }
  if (op.dedicatedTool) {
    throw new ToolInputError(`${op.id} is available as the ${op.dedicatedTool} tool.`)
  }
  const reason = unavailableReason(op)
  if (reason) {
    throw new ToolInputError(reason)
  }
  if (op.class !== cls) {
    throw new ToolInputError(`${op.id} is a ${CLASS_NAMES[op.class]} operation, run by ${executorToolFor(op.class)}.`)
  }
  if (!isExecutable(op)) {
    throw new ToolInputError(`${op.id} is not available through this connector.`)
  }
  if (args.body !== undefined && !op.body) {
    throw new ToolInputError(`${op.id} takes no request body.`)
  }
  if (args.body === undefined && op.bodyRequired) {
    throw new ToolInputError(`${op.id} requires a request body; sevalla_api_search with operation_id lists its fields.`)
  }
  const path = fillPath(op, args.path_params)
  const data = await api.request(op.method, path, {
    query: checkQuery(op, args.query),
    body: op.body ? (args.body ?? {}) : undefined,
  })
  return toolResult(data === null ? { ok: true, operation_id: op.id } : redact(data, secretFieldsFor(op)))
}

const docsLink = `Sevalla API v3 (reference: ${API_DOCS_URL})`

export const apiRead = readTool({
  name: 'sevalla_api_read',
  title: 'Read from the Sevalla API',
  description: `Runs one read-only (GET) operation of the ${docsLink} by operation ID, for data without a dedicated tool: projects, pipelines, load balancers, buckets, webhooks, usage alerts, repository files, users, API keys and more.`,
  input: z.object({ operation_id: operationId, path_params: pathParams, query }).strict(),
  run: async (args, { api }) =>
    runOperation('read', args, {
      request: (method, path, options) =>
        method === 'GET'
          ? api.get(path, options?.query)
          : Promise.reject(new ToolInputError('Only GET operations can run here.')),
    }),
})

export const apiCreate = writeTool('create', {
  name: 'sevalla_api_create',
  title: 'Create through the Sevalla API',
  description: `Runs one operation of the ${docsLink} that only adds something new, by operation ID: a project, pipeline, process, backup, bucket, webhook, load balancer and the like. New resources may be billed.`,
  input: z.object({ operation_id: operationId, path_params: pathParams, query, body }).strict(),
  run: async (args, { api }) => runOperation('create', args, api),
})

export const apiUpdate = writeTool('update', {
  name: 'sevalla_api_update',
  title: 'Update through the Sevalla API',
  description: `Runs one operation of the ${docsLink} that changes existing state, by operation ID: settings updates, suspend or activate, database restart or backup restore, pipeline promotion, cache purges, maintenance mode, or a command in a running process (execProcessCommandV3).`,
  input: z.object({ operation_id: operationId, path_params: pathParams, query, body }).strict(),
  run: async (args, { api }) => runOperation('update', args, api),
})

export const apiDelete = writeTool('delete', {
  name: 'sevalla_api_delete',
  title: 'Delete through the Sevalla API',
  description: `Permanently deletes one resource through an operation of the ${docsLink} by operation ID: from a domain, process, backup, webhook or API key up to an entire application, static site, database, pipeline, project, load balancer or bucket.`,
  input: z.object({ operation_id: operationId, path_params: pathParams, query, body }).strict(),
  run: async (args, { api }) => runOperation('delete', args, api),
})

export const API_TOOLS: Tool[] = [apiSearch, apiRead, apiCreate, apiUpdate, apiDelete]
