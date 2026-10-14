import type { AddressInfo } from 'node:net'
import { serve, type ServerType } from '@hono/node-server'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startFakeApi, TOKENS, type FakeApi } from './fake-api.ts'

export type ProtocolEra = 'modern' | 'legacy'

export const MODERN_PROTOCOL_VERSION = '2026-07-28'

export const TEST_ERA: ProtocolEra = process.env.MCP_TEST_ERA === 'legacy' ? 'legacy' : 'modern'

export interface ConnectOptions {
  token?: string
  era?: ProtocolEra
}

export interface Harness {
  api: FakeApi
  baseUrl: string
  connect: (_options?: ConnectOptions) => Promise<McpSession>
  close: () => Promise<void>
}

export interface ToolCall {
  isError: boolean
  text: string
  json: any
}

export interface McpSession {
  client: Client
  call: (_name: string, _args?: Record<string, unknown>) => Promise<ToolCall>
  close: () => Promise<void>
}

const parse = (text: string): any => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const startHarness = async (): Promise<Harness> => {
  const api = await startFakeApi()
  process.env.SEVALLA_API_URL = api.url
  process.env.SEVALLA_DOCS_URL = api.url
  const { app, __resetTokenCache } = await import('../../src/index.ts')
  __resetTokenCache()
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s))
  })
  const { port } = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`
  const sessions: McpSession[] = []

  const connect = async ({ token = TOKENS.valid, era = TEST_ERA }: ConnectOptions = {}): Promise<McpSession> => {
    const client = new Client(
      { name: 'sevalla-e2e', version: '1.0.0' },
      era === 'modern' ? { versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } } } : {},
    )
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    await client.connect(transport)
    const session: McpSession = {
      client,
      call: async (name, args = {}) => {
        const result = (await client.callTool({ name, arguments: args })) as {
          content: { type: string; text: string }[]
          isError?: boolean
        }
        const text = result.content.map((c) => c.text).join('\n')
        return { isError: result.isError === true, text, json: parse(text) }
      },
      close: () => client.close(),
    }
    sessions.push(session)
    return session
  }

  return {
    api,
    baseUrl,
    connect,
    close: async () => {
      await Promise.all(sessions.map((s) => s.close().catch(() => undefined)))
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await api.close()
    },
  }
}
