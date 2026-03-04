import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const RESOURCE_URI = 'ui://static-site-analytics/app.html'

const htmlPromise = new Promise<string>((res) => {
  const htmlPath = resolve(import.meta.dirname, '../../../dist/src/apps/static-site-analytics/index.html')
  res(readFileSync(htmlPath, 'utf-8'))
})

export const registerStaticSiteAnalyticsApp = (server: McpServer, apiFetch: typeof fetch) => {
  registerAppTool(
    server,
    'static-site-analytics',
    {
      title: 'Static Site Analytics',
      description:
        'View HTTP analytics for a static site: requests per minute, response times, status codes, top countries, top paths, and slowest requests.',
      inputSchema: {
        static_site_id: z.string().describe('The static site ID'),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async ({ static_site_id }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ static_site_id }) }],
    }),
  )

  server.registerTool(
    'get-static-site-http-metrics',
    {
      description: 'Fetch HTTP analytics metrics for a static site',
      inputSchema: {
        static_site_id: z.string().describe('The static site ID'),
        from: z.string().describe('Start time in ISO 8601 format'),
        to: z.string().describe('End time in ISO 8601 format'),
        interval_in_seconds: z.number().describe('Interval between data points in seconds'),
      },
    },
    async ({ static_site_id, from, to, interval_in_seconds }) => {
      const qs = new URLSearchParams({ from, to, interval_in_seconds: String(interval_in_seconds) })
      const base = `https://api.sevalla.com/static-sites/${static_site_id}/metrics`

      const [
        rpm,
        responseTimeAvg,
        responseTimeP90,
        responseTimeP95,
        responseTimeP99,
        statusCodes,
        topCountries,
        topPages,
        slowestRequests,
      ] = await Promise.all([
        apiFetch(`${base}/requests-per-minute?${qs}`).then((r) => r.json()),
        apiFetch(`${base}/response-time-avg?${qs}`).then((r) => r.json()),
        apiFetch(`${base}/response-time?${qs}&percent=90`).then((r) => r.json()),
        apiFetch(`${base}/response-time?${qs}&percent=95`).then((r) => r.json()),
        apiFetch(`${base}/response-time?${qs}&percent=99`).then((r) => r.json()),
        apiFetch(`${base}/status-codes?${qs}`).then((r) => r.json()),
        apiFetch(`${base}/top-countries?${qs}&limit=10`).then((r) => r.json()),
        apiFetch(`${base}/top-pages?${qs}&limit=10`).then((r) => r.json()),
        apiFetch(`${base}/slowest-requests?${qs}&limit=10`).then((r) => r.json()),
      ])

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              rpm,
              responseTime: { avg: responseTimeAvg, p90: responseTimeP90, p95: responseTimeP95, p99: responseTimeP99 },
              statusCodes,
              topCountries,
              topPages,
              slowestRequests,
            }),
          },
        ],
      }
    },
  )

  registerAppResource(server, RESOURCE_URI, RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => {
    const html = await htmlPromise
    return { contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }] }
  })
}
