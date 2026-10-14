import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type CacheHint,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { createOAuthRouter, getBearerAuthChallenge, getPublicUrl, resolveBearerToken } from './oauth.ts'
import { ApiError, createSevallaClient } from './sevalla/client.ts'
import { registerTools, serverInstructions } from './tools/index.ts'

const INDEX_HTML = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const ICON_PNG = readFileSync(new URL('./assets/sevalla-256.png', import.meta.url))
const ICON_SVG = readFileSync(new URL('./assets/sevalla.svg', import.meta.url), 'utf8')

const IS_STDIO = process.argv.includes('--stdio')
if (IS_STDIO) {
  console.log = console.error
}

const PORT = parseInt(process.env.PORT || '3000', 10)
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10)
const VALID_TOKEN_TTL_MS = 60_000
const INVALID_TOKEN_TTL_MS = 15_000
const TOKEN_CACHE_MAX = 10_000
const MAX_REQUEST_BODY_BYTES = 1_048_576
const MAX_TOOL_INPUT_ELEMENTS = 10_000
const LIST_CACHE_HINT: CacheHint = { ttlMs: 3_600_000, cacheScope: 'public' }

export const SERVER_VERSION = '2.0.0'

let isShuttingDown = false

const tokenCache = new Map<string, { valid: boolean; expiresAt: number }>()

const cacheToken = (key: string, valid: boolean) => {
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const oldest = tokenCache.keys().next().value
    if (oldest !== undefined) {
      tokenCache.delete(oldest)
    }
  }
  tokenCache.set(key, { valid, expiresAt: Date.now() + (valid ? VALID_TOKEN_TTL_MS : INVALID_TOKEN_TTL_MS) })
}

export const validateToken = async (token: string): Promise<'valid' | 'invalid' | 'unknown'> => {
  const key = createHash('sha256').update(token).digest('hex')
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.valid ? 'valid' : 'invalid'
  }
  try {
    await createSevallaClient({ token, timeoutMs: 10_000 }).get('/api-keys/me')
    cacheToken(key, true)
    return 'valid'
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      cacheToken(key, false)
      return 'invalid'
    }
    console.error('Token validation could not be completed:', err instanceof Error ? err.message : err)
    return 'unknown'
  }
}

export const __resetTokenCache = () => tokenCache.clear()

export const serverInfo = () => {
  const publicUrl = getPublicUrl()
  return {
    name: 'sevalla',
    title: 'Sevalla',
    version: SERVER_VERSION,
    description: 'Deploy, monitor and manage applications, static sites and databases on Sevalla.',
    websiteUrl: 'https://sevalla.com',
    icons: [
      { src: `${publicUrl}/icon.png`, mimeType: 'image/png', sizes: ['256x256'] },
      { src: `${publicUrl}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
    ],
  }
}

export const createMcpServer = (token: string): McpServer => {
  const server = new McpServer(serverInfo(), {
    capabilities: { tools: { listChanged: false } },
    instructions: serverInstructions(),
    cacheHints: { 'tools/list': LIST_CACHE_HINT, 'server/discover': LIST_CACHE_HINT },
    maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
  })
  registerTools(server, createSevallaClient({ token }))
  return server
}

const tokenFrom = (authInfo: AuthInfo | undefined): string => {
  if (!authInfo?.token) {
    throw new Error('MCP request reached the server factory without authentication')
  }
  return authInfo.token
}

const modernHandler = createMcpHandler(({ authInfo }) => createMcpServer(tokenFrom(authInfo)), {
  legacy: 'reject',
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  onerror: (err) => console.error('MCP request rejected:', err.message),
})

const serveLegacyRequest = async (request: Request, authInfo: AuthInfo): Promise<Response> => {
  const server = createMcpServer(authInfo.token)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  })
  transport.onerror = (err) => console.error('MCP transport error:', err.message)
  try {
    await server.connect(transport)
    return await transport.handleRequest(request, { authInfo })
  } finally {
    await server.close().catch((err: unknown) => console.error('MCP server close error:', err))
  }
}

const app = new Hono()

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'Mcp-Protocol-Version',
      'Mcp-Method',
      'Mcp-Name',
      'Mcp-Session-Id',
      'Last-Event-ID',
    ],
    exposeHeaders: ['Mcp-Protocol-Version', 'Mcp-Session-Id', 'WWW-Authenticate'],
  }),
)

app.get('/', (c) => c.html(INDEX_HTML))

const ICON_HEADERS = { 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' }

app.get('/icon.png', (c) => c.body(ICON_PNG, 200, { ...ICON_HEADERS, 'content-type': 'image/png' }))

app.get('/icon.svg', (c) =>
  c.body(ICON_SVG, 200, {
    ...ICON_HEADERS,
    'content-type': 'image/svg+xml',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  }),
)

app.get('/.well-known/glama.json', (c) => {
  return c.json({
    $schema: 'https://glama.ai/mcp/schemas/connector.json',
    maintainers: [{ email: 'kotapeter@gmail.com' }, { email: 'kristof@sevalla.com' }],
  })
})

app.get('/.well-known/openai-apps-challenge', (c) => {
  const challenge = process.env.OPENAI_APPS_CHALLENGE
  return challenge ? c.text(challenge) : c.notFound()
})

app.get('/health', (c) => {
  if (isShuttingDown) {
    return c.json({ status: 'shutting_down' }, 503)
  }
  return c.json({ status: 'ok' })
})

app.route('', createOAuthRouter())

const unauthorized = (c: Context, message: string, error?: string) =>
  c.json({ error: message }, 401, { 'WWW-Authenticate': getBearerAuthChallenge('/mcp', error) })

app.get('/mcp', (c) => {
  if (c.req.header('authorization')?.startsWith('Bearer ')) {
    return c.body(null, { status: 405, headers: { Allow: 'POST' } })
  }
  return unauthorized(c, 'Missing or invalid Authorization header')
})

app.delete('/mcp', (c) => c.body(null, { status: 405, headers: { Allow: 'POST' } }))

app.post('/mcp', async (c) => {
  if (isShuttingDown) {
    return c.json({ error: 'Server is shutting down' }, 503)
  }

  const authHeader = c.req.header('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return unauthorized(c, 'Missing or invalid Authorization header')
  }

  const bearer = authHeader.slice(7).trim()
  if (!bearer) {
    return unauthorized(c, 'Empty token')
  }

  const token = resolveBearerToken(bearer)
  if (!token) {
    return unauthorized(c, 'The access token is invalid or was issued for another resource', 'invalid_token')
  }

  if ((await validateToken(token)) === 'invalid') {
    return unauthorized(c, 'The Sevalla API key is invalid, expired or revoked', 'invalid_token')
  }

  const authInfo: AuthInfo = { token, clientId: 'sevalla-mcp', scopes: ['mcp:tools'] }
  try {
    const request = c.req.raw
    if (await isLegacyRequest(request, undefined, { maxRequestBodySize: MAX_REQUEST_BODY_BYTES })) {
      return await serveLegacyRequest(request, authInfo)
    }
    return await modernHandler.fetch(request, { authInfo })
  } catch (err) {
    console.error('MCP request error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

const startServer = async () => {
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err)
  })

  if (IS_STDIO) {
    const token = process.env.SEVALLA_API_KEY || ''
    serveStdio(() => createMcpServer(token), {
      onerror: (err) => console.error('MCP stdio error:', err.message),
    })
    console.log('Sevalla MCP server running in stdio mode')
    return
  }

  console.log(`Sevalla MCP server starting on port ${PORT}`)

  const server = serve({
    fetch: app.fetch,
    port: PORT,
  })

  const shutdown = (signal: string) => {
    if (isShuttingDown) {
      return
    }
    isShuttingDown = true
    console.log(`${signal} received, starting graceful shutdown...`)

    const forceExit = setTimeout(() => {
      console.error('Graceful shutdown timed out, forcing exit')
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    forceExit.unref()

    server.close(() => {
      console.log('All connections closed, exiting')
      process.exit(0)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  console.log(`Sevalla MCP server listening on http://localhost:${PORT}`)
}

export { app }

export const __setShuttingDown = (value: boolean) => {
  isShuttingDown = value
}

if (import.meta.main) {
  await startServer()
}
