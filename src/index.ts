import { serve } from '@hono/node-server'
import { StreamableHTTPTransport } from '@hono/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createTools } from './sandbox/index.ts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cors } from 'hono/cors'
import { createOAuthRouter } from './oauth.ts'
import { registerProcessAnalyticsApp } from './apps/process-analytics/tools.ts'

const PORT = parseInt(process.env.PORT || '3000', 10)
const SEVALLA_API_BASE = 'https://api.sevalla.com'
const SEVALLA_SPEC_URL = 'https://api.sevalla.com/v3/openapi.json'
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10)

let specPromise: Promise<Record<string, unknown>> | null = null
let isShuttingDown = false

const loadSpec = (): Promise<Record<string, unknown>> => {
  if (!specPromise) {
    specPromise = (async () => {
      console.log('Fetching OpenAPI spec from', SEVALLA_SPEC_URL)
      const res = await fetch(SEVALLA_SPEC_URL)
      if (!res.ok) {
        specPromise = null
        throw new Error(`Failed to fetch OpenAPI spec: ${res.status} ${res.statusText}`)
      }
      const spec = (await res.json()) as Record<string, unknown>
      console.log('OpenAPI spec loaded successfully')
      return spec
    })()
  }
  return specPromise
}

const createAuthenticatedFetch = (token: string) => {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? new URL(input) : new URL(input.toString())
    url.pathname = '/v3' + url.pathname

    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    headers.set('Content-Type', 'application/json')

    return fetch(url.toString(), { ...init, headers })
  }
}

const createMcpServer = (spec: Record<string, unknown>, token: string): McpServer => {
  const tools = createTools({
    spec,
    request: createAuthenticatedFetch(token),
    baseUrl: SEVALLA_API_BASE,
    namespace: 'sevalla',
  })

  const server = new McpServer({
    name: 'sevalla',
    version: '1.0.0',
  })

  for (const tool of tools.definitions) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => tool.handler(args as { code: string }),
    )
  }

  registerProcessAnalyticsApp(server, createAuthenticatedFetch(token))

  return server
}

const app = new Hono()

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
    exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
  }),
)

app.get('/health', (c) => {
  if (isShuttingDown) {
    return c.json({ status: 'shutting_down' }, 503)
  }
  return c.json({ status: 'ok' })
})

app.route('', createOAuthRouter())

app.get('/mcp', (c) => c.body(null, { status: 405, headers: { Allow: 'POST' } }))
app.delete('/mcp', (c) => c.body(null, { status: 405, headers: { Allow: 'POST' } }))

app.post('/mcp', async (c) => {
  if (isShuttingDown) {
    return c.json({ error: 'Server is shutting down' }, 503)
  }

  const authHeader = c.req.header('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    const publicUrl = process.env.PUBLIC_URL || 'https://mcp.sevalla.com'
    return c.json({ error: 'Missing or invalid Authorization header' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`,
    })
  }

  const token = authHeader.slice(7).trim()
  if (!token) {
    const publicUrl = process.env.PUBLIC_URL || 'https://mcp.sevalla.com'
    return c.json({ error: 'Empty token' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`,
    })
  }

  try {
    const spec = await loadSpec()
    const mcpServer = createMcpServer(spec, token)
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })

    transport.onerror = (err) => console.error('MCP transport error:', err)

    await mcpServer.connect(transport)

    const response = await transport.handleRequest(c)
    await mcpServer.close()
    return response ?? c.json({ error: 'No response from transport' }, 500)
  } catch (err) {
    if (err instanceof HTTPException) {
      throw err
    }
    console.error('MCP request error:', err)
    return c.json({ error: 'Internal server error' }, 500)
  }
})

await loadSpec()
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
