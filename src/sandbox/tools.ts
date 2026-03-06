import { z } from 'zod'
import type { BridgeRequest, RequestHandler } from './bridge.ts'
import { createRequestBridge } from './bridge.ts'
import { executeInSandbox, type ExecuteResult, type SandboxOptions } from './isolate.ts'
import { extractTags, processSpec } from './spec.ts'

const CHARS_PER_TOKEN = 4
const DEFAULT_MAX_TOKENS = 6_000

const truncateResponse = (text: string, maxTokens = DEFAULT_MAX_TOKENS): string => {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  if (text.length <= maxChars) {
    return text
  }
  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN)
  return (
    text.slice(0, maxChars) +
    `\n\n--- TRUNCATED ---\nResponse was ~${estimatedTokens} tokens (limit: ${maxTokens}). Use more specific queries to reduce response size.`
  )
}

const SPEC_TYPES = `interface OperationInfo {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown; description?: string }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
}

interface PathItem {
  get?: OperationInfo;
  post?: OperationInfo;
  put?: OperationInfo;
  patch?: OperationInfo;
  delete?: OperationInfo;
}

declare const spec: {
  paths: Record<string, PathItem>;
};`

const createSearchDefinition = (context: { tags: string[]; endpointCount: number }) => {
  const parts: string[] = []
  parts.push('Search the API specification to discover available endpoints. All $refs are pre-resolved inline.')

  if (context.tags.length > 0) {
    const shown = context.tags.slice(0, 30).join(', ')
    const suffix = context.tags.length > 30 ? `... (${context.tags.length} total)` : ''
    parts.push(`Tags: ${shown}${suffix}`)
  }

  parts.push(`Endpoints: ${context.endpointCount}`)
  parts.push(`Types:\n${SPEC_TYPES}`)

  const exampleTag = context.tags[0]?.toLowerCase() ?? 'items'
  const discoverExample =
    context.tags.length > 0
      ? `// Find endpoints by tag
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase() === '${exampleTag}')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}`
      : `// List all endpoints
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      results.push({ method: method.toUpperCase(), path, summary: op.summary });
    }
  }
  return results;
}`

  parts.push(`Your code must be an async arrow function that returns the result.

Examples:

${discoverExample}

// Get endpoint with requestBody schema (refs are resolved)
async () => {
  const op = spec.paths['/example']?.post;
  return { summary: op?.summary, requestBody: op?.requestBody };
}

// Get endpoint parameters
async () => {
  const op = spec.paths['/example']?.get;
  return op?.parameters;
}`)

  return {
    name: 'search',
    title: 'Search Sevalla API Spec',
    description: parts.join('\n\n'),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.object({
      code: z.string().describe('JavaScript async arrow function to search the `spec` object'),
    }),
  }
}

const createExecuteDefinition = (namespace: string) => {
  const types = `
interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Response<T = unknown> {
  status: number;
  headers: Record<string, string>;
  body: T;
}

declare const ${namespace}: {
  request<T = unknown>(options: RequestOptions): Promise<Response<T>>;
};`

  return {
    name: 'execute',
    title: 'Execute Sevalla API Call',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    description: `Execute API calls by writing JavaScript code. First use the 'search' tool to find the right endpoints.

Available in your code:
${types}
Your code must be an async arrow function that returns the result.

Examples:

// List resources
async () => {
  const res = await ${namespace}.request({ method: "GET", path: "/v1/items" });
  return res.body;
}

// Create a resource
async () => {
  const res = await ${namespace}.request({
    method: "POST",
    path: "/v1/items",
    body: { name: "Widget" }
  });
  return { status: res.status, body: res.body };
}

// Chain multiple calls
async () => {
  const list = await ${namespace}.request({ method: "GET", path: "/v1/items" });
  const details = await Promise.all(
    list.body.map(item =>
      ${namespace}.request({ method: "GET", path: \`/v1/items/\${item.id}\` })
    )
  );
  return details.map(d => d.body);
}`,
    inputSchema: z.object({
      code: z
        .string()
        .describe(`JavaScript async arrow function that uses \`${namespace}.request()\` to make API calls`),
    }),
  }
}

export interface ToolDefinition {
  name: string
  title: string
  description: string
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
  inputSchema: z.ZodObject<any>
  handler: (_args: { code: string }) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>
}

export interface CreateToolsOptions {
  spec: Record<string, any>
  request: RequestHandler
  baseUrl: string
  namespace: string
  maxResponseTokens?: number
  maxRequests?: number
  maxResponseBytes?: number
  allowedHeaders?: string[]
  sandbox?: SandboxOptions
}

const formatResult = (result: ExecuteResult, maxTokens: number) => {
  if (result.error) {
    return { content: [{ type: 'text' as const, text: `Error: ${result.error}` }], isError: true }
  }
  const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result, null, 2)
  const text = raw ?? 'undefined'
  return { content: [{ type: 'text' as const, text: truncateResponse(text, maxTokens) }] }
}

export const createTools = (options: CreateToolsOptions): { definitions: ToolDefinition[] } => {
  const maxTokens = options.maxResponseTokens ?? DEFAULT_MAX_TOKENS
  const processed = processSpec(options.spec)
  const tags = extractTags(processed)
  const endpointCount = Object.keys(processed.paths).length

  const searchDef = createSearchDefinition({ tags, endpointCount })
  const executeDef = createExecuteDefinition(options.namespace)

  const searchHandler = async (args: { code: string }) => {
    const result = await executeInSandbox(args.code, { spec: processed }, options.sandbox)
    return formatResult(result, maxTokens)
  }

  const executeHandler = async (args: { code: string }) => {
    const bridge = createRequestBridge(options.request, options.baseUrl, {
      maxRequests: options.maxRequests,
      maxResponseBytes: options.maxResponseBytes,
      allowedHeaders: options.allowedHeaders,
    })
    const result = await executeInSandbox(
      args.code,
      { [options.namespace]: { request: (req: BridgeRequest) => bridge(req) } },
      options.sandbox,
    )
    return formatResult(result, maxTokens)
  }

  return {
    definitions: [
      { ...searchDef, handler: searchHandler },
      { ...executeDef, handler: executeHandler },
    ],
  }
}
