# Sandbox Module Refactoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split `src/sandbox.ts` (631 lines) into 5 focused modules under `src/sandbox/` with no behavioral changes.

**Architecture:** Extract each concern (spec processing, HTTP bridge, V8 isolate, tool definitions, orchestration) into its own file. A barrel `index.ts` re-exports the public API so consumers only change import paths.

**Tech Stack:** TypeScript (Node.js native type-stripping), isolated-vm, node:test

---

### Task 1: Create src/sandbox/spec.ts

**Files:**
- Create: `src/sandbox/spec.ts`

**Step 1: Create the spec module**

Extract lines 1-122 from `src/sandbox.ts` — the OpenAPI spec processing functions. This module has no internal dependencies.

```typescript
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const EXTRACTED_FIELDS = ['summary', 'description', 'tags', 'parameters', 'requestBody', 'responses'] as const
const DEFAULT_MAX_REF_DEPTH = 50

export const resolveRefs = (
  obj: any,
  root: any,
  seen = new Set<string>(),
  maxDepth = DEFAULT_MAX_REF_DEPTH,
  _cache = new Map<string, any>(),
): any => {
  if (obj === null || typeof obj !== 'object') {
    return obj
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveRefs(item, root, seen, maxDepth, _cache))
  }

  if (typeof obj.$ref === 'string') {
    const ref = obj.$ref as string
    if (maxDepth <= 0) {
      return { $circular: ref, $reason: 'max depth exceeded' }
    }
    if (seen.has(ref)) {
      return { $circular: ref }
    }
    if (_cache.has(ref)) {
      return _cache.get(ref)
    }

    const parts = ref.replace(/^#\//, '').split('/')
    if (parts.some((p: string) => DANGEROUS_KEYS.has(p))) {
      return { $ref: ref, $error: 'unsafe ref path' }
    }

    let resolved: any = root
    for (const part of parts) {
      resolved = resolved?.[part]
      if (resolved === undefined) {
        return obj
      }
    }

    const nextSeen = new Set(seen)
    nextSeen.add(ref)
    const result = resolveRefs(resolved, root, nextSeen, maxDepth - 1, _cache)
    _cache.set(ref, result)
    return result
  }

  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue
    }
    out[key] = resolveRefs(value, root, seen, maxDepth, _cache)
  }
  return out
}

const extractServerBasePath = (spec: any): string => {
  const serverUrl = spec.servers?.[0]?.url
  if (!serverUrl) {
    return ''
  }
  try {
    return new URL(serverUrl).pathname.replace(/\/+$/, '')
  } catch {
    const match = serverUrl.match(/^https?:\/\/[^/]+(\/.*?)?\/?$/)
    return match?.[1]?.replace(/\/+$/, '') ?? ''
  }
}

export const processSpec = (spec: any, maxRefDepth = DEFAULT_MAX_REF_DEPTH): { paths: Record<string, any> } => {
  const basePath = extractServerBasePath(spec)
  const paths: Record<string, any> = {}

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    const fullPath = basePath + path
    const pathItem: Record<string, any> = {}

    for (const method of HTTP_METHODS) {
      const op = (methods as any)[method]
      if (!op) {
        continue
      }

      const extracted: Record<string, any> = {}
      for (const field of EXTRACTED_FIELDS) {
        if (op[field] !== undefined) {
          extracted[field] = resolveRefs(op[field], spec, new Set(), maxRefDepth)
        }
      }
      pathItem[method] = extracted
    }

    if (Object.keys(pathItem).length > 0) {
      paths[fullPath] = pathItem
    }
  }

  return { paths }
}

export const extractTags = (spec: { paths: Record<string, any> }): string[] => {
  const counts = new Map<string, number>()
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = (methods as any)?.[method]
      if (!op?.tags) {
        continue
      }
      for (const tag of op.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag)
}
```

**Step 2: Verify no syntax errors**

Run: `npx tsc --noEmit --skipLibCheck src/sandbox/spec.ts`
Expected: No errors

---

### Task 2: Create src/sandbox/bridge.ts

**Files:**
- Create: `src/sandbox/bridge.ts`

**Step 1: Create the bridge module**

Extract lines 124-285 from `src/sandbox.ts` — the HTTP request bridging with validation and security filtering. This module has no internal dependencies.

```typescript
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

const BLOCKED_HEADER_PATTERNS = [
  /^authorization$/i,
  /^cookie$/i,
  /^host$/i,
  /^origin$/i,
  /^referer$/i,
  /^x-forwarded-/i,
  /^x-real-ip$/i,
  /^x-client-ip$/i,
  /^cf-connecting-ip$/i,
  /^true-client-ip$/i,
  /^proxy-/i,
  /^transfer-encoding$/i,
  /^connection$/i,
  /^upgrade$/i,
  /^te$/i,
]

const DEFAULT_MAX_REQUESTS = 50
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024

export type RequestHandler = (_url: string, _init?: RequestInit) => Promise<Response>

export interface BridgeOptions {
  maxRequests?: number
  maxResponseBytes?: number
  allowedHeaders?: string[]
}

export interface BridgeRequest {
  method: string
  path: string
  query?: Record<string, string | number | boolean>
  body?: unknown
  headers?: Record<string, string>
}

export interface BridgeResponse {
  status: number
  headers: Record<string, string>
  body: any
}

const validatePath = (path: string) => {
  if (path.includes('://')) {
    throw new Error('Invalid path: must not contain "://"')
  }
  if (!path.startsWith('/')) {
    throw new Error('Invalid path: must start with "/"')
  }
  if (path.startsWith('//')) {
    throw new Error('Invalid path: must not start with "//"')
  }
  if (path.includes('\0')) {
    throw new Error('Invalid path: must not contain null bytes')
  }
  if (path.includes('\r') || path.includes('\n')) {
    throw new Error('Invalid path: must not contain CR/LF')
  }
  if (path.includes('\\')) {
    throw new Error('Invalid path: must not contain backslashes')
  }
}

const filterHeaders = (headers: Record<string, string>, allowedHeaders?: string[]): Record<string, string> => {
  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (allowedHeaders) {
      if (allowedHeaders.some((a) => a.toLowerCase() === key.toLowerCase())) {
        filtered[key] = value
      }
    } else if (!BLOCKED_HEADER_PATTERNS.some((p) => p.test(key))) {
      filtered[key] = value
    }
  }
  return filtered
}

const readResponseWithLimit = async (response: Response, maxBytes: number): Promise<string> => {
  if (!response.body) {
    return await response.text()
  }
  const reader = response.body.getReader()
  try {
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        throw new Error(`Response body exceeds ${maxBytes} byte limit`)
      }
      chunks.push(value)
    }
    return new TextDecoder().decode(Buffer.concat(chunks))
  } finally {
    reader.releaseLock()
  }
}

export const createRequestBridge = (
  handler: RequestHandler,
  baseUrl: string,
  options: BridgeOptions = {},
): ((_req: BridgeRequest) => Promise<BridgeResponse>) => {
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  let requestCount = 0

  return async (req: BridgeRequest): Promise<BridgeResponse> => {
    requestCount++
    if (requestCount > maxRequests) {
      throw new Error(`Request limit of ${maxRequests} exceeded`)
    }

    const method = req.method.toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error(`Method "${method}" not allowed`)
    }
    validatePath(req.path)

    const url = new URL(req.path, baseUrl)
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        url.searchParams.set(key, String(value))
      }
    }

    const headers = filterHeaders(req.headers ?? {}, options.allowedHeaders)
    const init: RequestInit = { method, headers }
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body)
      if (!headers['content-type'] && !headers['Content-Type']) {
        ;(init.headers as Record<string, string>)['content-type'] = 'application/json'
      }
    }

    const response = await handler(url.toString(), init)
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v
    })

    const text = await readResponseWithLimit(response, maxResponseBytes)
    const contentType = response.headers.get('content-type') ?? ''
    let body: any = text
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(text)
      } catch {
        // fallback to raw text
      }
    }

    return { status: response.status, headers: responseHeaders, body }
  }
}
```

**Step 2: Verify no syntax errors**

Run: `npx tsc --noEmit --skipLibCheck src/sandbox/bridge.ts`
Expected: No errors

---

### Task 3: Create src/sandbox/isolate.ts

**Files:**
- Create: `src/sandbox/isolate.ts`

**Step 1: Create the isolate module**

Extract lines 287-388 from `src/sandbox.ts` — the V8 isolate execution. This module depends only on `isolated-vm`.

```typescript
import ivm from 'isolated-vm'

export interface SandboxOptions {
  memoryMB?: number
  timeoutMs?: number
  wallTimeMs?: number
}

export interface ExecuteResult {
  result: any
  error?: string
}

const isNamespaceWithMethods = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).some((v) => typeof v === 'function')

export const executeInSandbox = async (
  code: string,
  globals: Record<string, any>,
  options: SandboxOptions = {},
): Promise<ExecuteResult> => {
  const memoryMB = options.memoryMB ?? 64
  const timeoutMs = options.timeoutMs ?? 30_000
  const wallTimeMs = options.wallTimeMs ?? 60_000

  const isolate = new ivm.Isolate({ memoryLimit: memoryMB })
  let context: ivm.Context | undefined

  try {
    context = await isolate.createContext()
    const jail = context.global
    await jail.set('global', jail.derefInto())

    await context.eval(`globalThis.console = { log: () => {}, warn: () => {}, error: () => {} };`)

    let refCounter = 0
    for (const [name, value] of Object.entries(globals)) {
      if (typeof value === 'function') {
        const refName = `__ref${refCounter++}`
        await jail.set(refName, new ivm.Reference(value))
        await context.eval(
          `globalThis[${JSON.stringify(name)}] = function(...args) {` +
            `return ${refName}.apply(undefined, args, { arguments: { copy: true }, result: { promise: true, copy: true } });` +
            `};`,
        )
      } else if (isNamespaceWithMethods(value)) {
        const methodSetup: string[] = []
        methodSetup.push(`globalThis[${JSON.stringify(name)}] = {};`)

        for (const [key, val] of Object.entries(value)) {
          if (typeof val === 'function') {
            const refName = `__ref${refCounter++}`
            await jail.set(refName, new ivm.Reference(val))
            methodSetup.push(
              `globalThis[${JSON.stringify(name)}][${JSON.stringify(key)}] = function(...args) {` +
                `return ${refName}.apply(undefined, args, { arguments: { copy: true }, result: { promise: true, copy: true } });` +
                `};`,
            )
          }
        }

        await context.eval(methodSetup.join('\n'))

        const dataProps: Record<string, any> = {}
        for (const [key, val] of Object.entries(value)) {
          if (typeof val !== 'function') {
            dataProps[key] = val
          }
        }
        if (Object.keys(dataProps).length > 0) {
          await context.eval(`Object.assign(globalThis[${JSON.stringify(name)}], ${JSON.stringify(dataProps)});`)
        }
      } else {
        await context.eval(`globalThis[${JSON.stringify(name)}] = ${JSON.stringify(value)};`)
      }
    }

    const wrappedCode = `(${code})()`
    const script = await isolate.compileScript(wrappedCode)

    let wallTimer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      script.run(context, { timeout: timeoutMs, promise: true, copy: true }).finally(() => clearTimeout(wallTimer)),
      new Promise<never>((_, reject) => {
        wallTimer = setTimeout(() => reject(new Error('Wall-clock timeout exceeded')), wallTimeMs)
        if (typeof wallTimer === 'object' && 'unref' in wallTimer) {
          wallTimer.unref()
        }
      }),
    ])

    return { result }
  } catch (err) {
    return { result: undefined, error: err instanceof Error ? err.message : String(err) }
  } finally {
    context?.release()
    if (!isolate.isDisposed) {
      isolate.dispose()
    }
  }
}
```

**Step 2: Verify no syntax errors**

Run: `npx tsc --noEmit --skipLibCheck src/sandbox/isolate.ts`
Expected: No errors

---

### Task 4: Create src/sandbox/tools.ts

**Files:**
- Create: `src/sandbox/tools.ts`

**Step 1: Create the tools module**

Extract lines 390-631 from `src/sandbox.ts` — tool definitions and orchestration. This module imports from the three leaf modules.

```typescript
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
    description: parts.join('\n\n'),
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string' as const,
          description: 'JavaScript async arrow function to search the `spec` object',
        },
      },
      required: ['code'],
    },
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
    inputSchema: {
      type: 'object' as const,
      properties: {
        code: {
          type: 'string' as const,
          description: `JavaScript async arrow function that uses \`${namespace}.request()\` to make API calls`,
        },
      },
      required: ['code'],
    },
  }
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, any>
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
```

**Step 2: Verify no syntax errors**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: No errors

---

### Task 5: Create src/sandbox/index.ts (barrel) and update consumers

**Files:**
- Create: `src/sandbox/index.ts`
- Modify: `src/index.ts:4`
- Modify: `test/sandbox.test.ts:3-10`

**Step 1: Create the barrel**

```typescript
export { resolveRefs, processSpec, extractTags } from './spec.ts'
export { createRequestBridge, type RequestHandler, type BridgeOptions, type BridgeRequest, type BridgeResponse } from './bridge.ts'
export { executeInSandbox, type SandboxOptions, type ExecuteResult } from './isolate.ts'
export { createTools, type ToolDefinition, type CreateToolsOptions } from './tools.ts'
```

**Step 2: Update src/index.ts import**

Change line 4 from:
```typescript
import { createTools } from './sandbox.ts'
```
to:
```typescript
import { createTools } from './sandbox/index.ts'
```

**Step 3: Update test/sandbox.test.ts import**

Change import from:
```typescript
} from '../src/sandbox.ts'
```
to:
```typescript
} from '../src/sandbox/index.ts'
```

**Step 4: Delete src/sandbox.ts**

Run: `rm src/sandbox.ts`

**Step 5: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 6: Run full code checks**

Run: `pnpm check:code`
Expected: No errors from tsc, oxlint, oxfmt

**Step 7: Commit**

```bash
git add src/sandbox/ src/index.ts test/sandbox.test.ts
git rm src/sandbox.ts
git commit -m "refactor: split sandbox.ts into focused modules under src/sandbox/"
```
