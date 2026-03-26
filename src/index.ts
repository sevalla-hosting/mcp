import { serve } from '@hono/node-server'
import { StreamableHTTPTransport } from '@hono/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { cors } from 'hono/cors'
import { createAuthenticatedFetch, SEVALLA_API_BASE, SEVALLA_SPEC_URL } from './api.ts'
import { createOAuthRouter } from './oauth.ts'
import { INDEX_HTML } from './html.ts'
import { createTools } from './sandbox/index.ts'

const IS_STDIO = process.argv.includes('--stdio')
if (IS_STDIO) {
  console.log = console.error
}

const PORT = parseInt(process.env.PORT || '3000', 10)
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
      {
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>) => tool.handler(args as { code: string }),
    )
  }

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

app.get('/', (c) => c.html(INDEX_HTML))

app.get('/.well-known/glama.json', (c) => {
  return c.json({
    $schema: 'https://glama.ai/mcp/schemas/connector.json',
    maintainers: [{ email: 'kotapeter@gmail.com' }, { email: 'kristof@sevalla.com' }],
  })
})

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

if (IS_STDIO) {
  const spec = await loadSpec()
  const token = process.env.SEVALLA_API_KEY || ''
  const mcpServer = createMcpServer(spec, token)
  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
  console.log('Sevalla MCP server running in stdio mode')
} else {
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
}
