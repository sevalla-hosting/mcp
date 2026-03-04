import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const RESOURCE_URI = 'ui://process-analytics/app.html'

const METRICS = ['cpu-usage', 'cpu-limit', 'memory-usage', 'memory-limit', 'instance-count'] as const

const htmlPromise = new Promise<string>((res) => {
  const htmlPath = resolve(import.meta.dirname, '../../../dist/src/apps/process-analytics/index.html')
  res(readFileSync(htmlPath, 'utf-8'))
})

export const registerProcessAnalyticsApp = (server: McpServer, apiFetch: typeof fetch) => {
  registerAppTool(
    server,
    'process-analytics',
    {
      title: 'Process Analytics',
      description: 'View CPU, memory, and instance metrics for application processes',
      inputSchema: {
        application_id: z.string().describe('The application ID to fetch process analytics for'),
      },
      _meta: {
        ui: { resourceUri: RESOURCE_URI },
      },
    },
    async ({ application_id }) => {
      const res = await apiFetch(`https://api.sevalla.com/applications/${application_id}/processes`)
      const data = await res.json()
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ application_id, processes: data }),
          },
        ],
      }
    },
  )

  server.registerTool(
    'list-processes',
    {
      description: 'List processes for an application',
      inputSchema: {
        application_id: z.string().describe('The application ID'),
      },
    },
    async ({ application_id }) => {
      const res = await apiFetch(`https://api.sevalla.com/applications/${application_id}/processes`)
      const data = await res.json()
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
      }
    },
  )

  server.registerTool(
    'get-process-metrics',
    {
      description: 'Get CPU, memory, and instance count metrics for a specific process',
      inputSchema: {
        application_id: z.string().describe('The application ID'),
        process_id: z.string().describe('The process ID'),
        from: z.string().describe('Start time in ISO 8601 format'),
        to: z.string().describe('End time in ISO 8601 format'),
        interval_in_seconds: z.number().describe('Interval between data points in seconds'),
      },
    },
    async ({ application_id, process_id, from, to, interval_in_seconds }) => {
      const query = new URLSearchParams({
        from,
        to,
        interval_in_seconds: String(interval_in_seconds),
      })

      const results = await Promise.all(
        METRICS.map(async (metric) => {
          const res = await apiFetch(
            `https://api.sevalla.com/applications/${application_id}/processes/${process_id}/metrics/${metric}?${query}`,
          )
          return { metric, data: await res.json() }
        }),
      )

      const metrics = Object.fromEntries(results.map(({ metric, data }) => [metric, data]))

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ application_id, process_id, from, to, interval_in_seconds, metrics }),
          },
        ],
      }
    },
  )

  registerAppResource(server, RESOURCE_URI, RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    const html = await htmlPromise
    return {
      contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
    }
  })
}
