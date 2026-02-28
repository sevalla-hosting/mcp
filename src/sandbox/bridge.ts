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
