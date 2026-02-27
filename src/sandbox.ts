import ivm from 'isolated-vm'

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

type RequestHandler = (_url: string, _init?: RequestInit) => Promise<Response>

interface BridgeOptions {
  maxRequests?: number
  maxResponseBytes?: number
  allowedHeaders?: string[]
}

interface BridgeRequest {
  method: string
  path: string
  query?: Record<string, string | number | boolean>
  body?: unknown
  headers?: Record<string, string>
}

interface BridgeResponse {
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
    return ''
  }
  const reader = response.body.getReader()
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
    const body = contentType.includes('application/json') ? JSON.parse(text) : text

    return { status: response.status, headers: responseHeaders, body }
  }
}

interface SandboxOptions {
  memoryMB?: number
  timeoutMs?: number
  wallTimeMs?: number
}

interface ExecuteResult {
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
