import type { McpServer } from '@modelcontextprotocol/server'
import { ApiError, type SevallaClient } from '../sevalla/client.ts'
import { API_DOCS_URL, isExecutable, OperationInputError, OPERATIONS } from '../sevalla/operations.ts'
import { API_TOOLS } from './api.ts'
import { CONFIGURATION_TOOLS } from './configuration.ts'
import { CREATE_TOOLS } from './create.ts'
import { annotationsFor, ToolInputError, type ServerContext, type Tool, type ToolResult } from './define.ts'
import { DEPLOYMENT_TOOLS } from './deployments.ts'
import { searchDocs } from './docs.ts'
import { formatApiError, toolError } from './format.ts'
import { OBSERVABILITY_TOOLS } from './observability.ts'
import { SERVICE_TOOLS } from './services.ts'

export const TOOLS: Tool[] = [
  ...SERVICE_TOOLS,
  ...DEPLOYMENT_TOOLS,
  ...OBSERVABILITY_TOOLS,
  ...CONFIGURATION_TOOLS,
  ...CREATE_TOOLS,
  searchDocs,
  ...API_TOOLS,
]

export const serverInstructions = (): string =>
  [
    "Sevalla is a platform for hosting applications, static sites and databases. Applications are built from a Git repository or a Docker image and run as processes (web, worker, cron or job) in a cluster (region). Static sites are built from Git and served from Cloudflare's edge. Databases are managed PostgreSQL, MySQL, MariaDB, Redis or Valkey servers.",
    'Resources belong to the company of the connected API key and can be grouped into projects. Identifiers are UUIDs; list_services returns them together with names.',
    'Deployments run asynchronously: trigger_deployment and rollback_deployment return a deployment whose progress get_deployment reports. Environment variable and scaling changes apply at the next deployment.',
    'Environment variable values are withheld; their keys and scoping are listed.',
    'Applications and databases are billed by size and instance count. Deleting a database breaks the applications connected to it; get_database lists its internal connections. A clone (cloneApplicationV3) copies the source, environment variables included, and deploys at once, so it runs against the same databases. Custom domains need a web process larger than the Hobby size (H1).',
    `Of the ${OPERATIONS.length} Sevalla API operations, ${OPERATIONS.filter(isExecutable).length} have no dedicated tool and run through sevalla_api_read, sevalla_api_create, sevalla_api_update and sevalla_api_delete. A task often has an operation of its own that the closest dedicated tool only approximates: cloning an application rather than creating a new one, suspending it rather than scaling its processes to zero, cancelling a deployment rather than rolling it back, or promoting a pipeline rather than redeploying. sevalla_api_search finds operations by keyword across the whole API, dedicated tools included, and names the tool that runs each (reference: ${API_DOCS_URL}).`,
  ].join('\n\n')

const SECURITY_SCHEMES = [{ type: 'oauth2', scopes: ['mcp:tools'] }]

export const runTool = async (tool: Tool, args: Record<string, unknown>, ctx: ServerContext): Promise<ToolResult> => {
  try {
    return await tool.execute(args, ctx)
  } catch (err) {
    if (err instanceof ApiError) {
      return toolError(formatApiError(err))
    }
    if (err instanceof ToolInputError || err instanceof OperationInputError) {
      return toolError(err.message)
    }
    console.error(`Tool ${tool.name} failed:`, err instanceof Error ? err.stack : err)
    return toolError(`The ${tool.name} tool failed unexpectedly. The request may succeed on a later attempt.`)
  }
}

export const registerTools = (server: McpServer, client: SevallaClient) => {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: annotationsFor(tool),
        _meta: { securitySchemes: SECURITY_SCHEMES },
      },
      async (args, ctx) => runTool(tool, args as Record<string, unknown>, { client, signal: ctx.mcpReq.signal }),
    )
  }
}
