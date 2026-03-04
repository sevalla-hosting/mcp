import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const RESOURCE_URI = 'ui://database-analytics/app.html'

const METRICS = ['cpu-usage', 'cpu-limit', 'memory-usage', 'memory-limit', 'storage-usage', 'storage-limit'] as const

const htmlPromise = new Promise<string>((res) => {
  const htmlPath = resolve(import.meta.dirname, '../../../dist/src/apps/database-analytics/index.html')
  res(readFileSync(htmlPath, 'utf-8'))
})

export const registerDatabaseAnalyticsApp = (server: McpServer, apiFetch: typeof fetch) => {
  registerAppTool(
    server,
    'database-analytics',
    {
      title: 'Database Analytics',
      description: 'View CPU, memory, and storage metrics for a database.',
      inputSchema: {
        database_id: z.string().describe('The database ID'),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ database_id }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ database_id }) }],
    }),
  )

  server.registerTool(
    'get-database-metrics',
    {
      description: 'Fetch CPU, memory, and storage metrics for a database',
      inputSchema: {
        database_id: z.string().describe('The database ID'),
        from: z.string().describe('Start time in ISO 8601 format'),
        to: z.string().describe('End time in ISO 8601 format'),
        interval_in_seconds: z.number().describe('Interval between data points in seconds'),
      },
    },
    async ({ database_id, from, to, interval_in_seconds }) => {
      const query = new URLSearchParams({ from, to, interval_in_seconds: String(interval_in_seconds) })

      const results = await Promise.all(
        METRICS.map(async (metric) => {
          const res = await apiFetch(`https://api.sevalla.com/databases/${database_id}/metrics/${metric}?${query}`)
          return { metric, data: await res.json() }
        }),
      )

      const metrics = Object.fromEntries(results.map(({ metric, data }) => [metric, data]))

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ database_id, from, to, interval_in_seconds, metrics }) },
        ],
      }
    },
  )

  registerAppResource(server, RESOURCE_URI, RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    const html = await htmlPromise
    return { contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }] }
  })
}
