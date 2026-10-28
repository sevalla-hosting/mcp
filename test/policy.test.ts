import { after, describe, it } from 'node:test'
import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { z } from 'zod'
import { readOnly, createSevallaClient, type SevallaClient } from '../src/sevalla/client.ts'
import { API_DOCS_URL } from '../src/sevalla/operations.ts'
import { readTool, writeTool } from '../src/tools/define.ts'
import { toolResult } from '../src/tools/format.ts'
import { TOOLS } from '../src/tools/index.ts'
import { startHarness, type ProtocolEra } from './support/harness.ts'

const MAX_TOOLS_LIST_CHARS = 38_000

const MODEL_DIRECTED = [
  /\byou\b/i,
  /\byour\b/i,
  /\bmust\b/i,
  /\bshould\b/i,
  /\balways\b/i,
  /\bmake sure\b/i,
  /\bbe sure\b/i,
  /\bremember\b/i,
  /\bimportant\b/i,
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\bplease\b/i,
  /\bfirst (call|use)\b/i,
  /\bbefore (calling|using)\b/i,
  /\bignore\b/i,
]

const harness = await startHarness()

after(() => harness.close())

const listTools = async (era: ProtocolEra) => {
  const session = await harness.connect({ era })
  const { tools } = await session.client.listTools()
  return { tools, instructions: session.client.getInstructions() ?? '' }
}

const ERAS: Record<ProtocolEra, Awaited<ReturnType<typeof listTools>>> = {
  modern: await listTools('modern'),
  legacy: await listTools('legacy'),
}

const describedText = (schema: any): string[] => [
  ...(typeof schema?.description === 'string' ? [schema.description] : []),
  ...Object.values(schema?.properties ?? {}).flatMap((p) => describedText(p)),
  ...(schema?.items ? describedText(schema.items) : []),
]

for (const era of ['modern', 'legacy'] as const) {
  describe(`directory policy (${era} protocol)`, () => {
    const { tools, instructions } = ERAS[era]

    it('exposes every registered tool', () => {
      strictEqual(tools.length, TOOLS.length)
    })

    it('uses unique snake_case names of at most 64 characters', () => {
      const names = tools.map((t) => t.name)
      strictEqual(new Set(names).size, names.length)
      for (const name of names) {
        ok(/^[a-z][a-z0-9_]{2,63}$/.test(name), name)
      }
    })

    it('gives every tool a title, in the tool and in its annotations', () => {
      for (const tool of tools) {
        ok(tool.title && tool.title.length > 3, tool.name)
        strictEqual(tool.annotations?.title, tool.title, tool.name)
      }
    })

    it('sets all four hints explicitly as booleans', () => {
      for (const tool of tools) {
        for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
          strictEqual(typeof tool.annotations?.[hint], 'boolean', `${tool.name}.${hint}`)
        }
      }
    })

    it('keeps reads and writes in separate tools with consistent hints', () => {
      for (const tool of tools) {
        const kind = TOOLS.find((t) => t.name === tool.name)?.kind
        if (kind === 'read') {
          strictEqual(tool.annotations?.readOnlyHint, true, tool.name)
          strictEqual(tool.annotations?.destructiveHint, false, tool.name)
          strictEqual(tool.annotations?.openWorldHint, false, tool.name)
        } else {
          strictEqual(tool.annotations?.readOnlyHint, false, tool.name)
          strictEqual(tool.annotations?.destructiveHint, kind === 'update' || kind === 'delete', tool.name)
        }
      }
    })

    it('never accepts an HTTP method, URL or raw path from the model', () => {
      for (const tool of tools) {
        const props = Object.keys(tool.inputSchema.properties ?? {})
        for (const forbidden of ['method', 'http_method', 'url', 'path', 'endpoint', 'headers', 'code']) {
          ok(!props.includes(forbidden), `${tool.name} has a ${forbidden} parameter`)
        }
      }
    })

    it('types every input property', () => {
      for (const tool of tools) {
        for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {}) as [string, any][]) {
          ok(schema.type || schema.enum || schema.anyOf || schema.oneOf, `${tool.name}.${name} has no type`)
        }
      }
    })

    it('describes each tool narrowly and factually', () => {
      for (const tool of tools) {
        const description = tool.description ?? ''
        ok(description.length >= 60 && description.length <= 450, `${tool.name}: ${description.length} characters`)
        ok(description.includes('Sevalla'), `${tool.name} does not name Sevalla`)
        for (const text of [description, ...describedText(tool.inputSchema)]) {
          for (const pattern of MODEL_DIRECTED) {
            ok(!pattern.test(text), `${tool.name}: "${text}" matches ${pattern}`)
          }
        }
      }
    })

    it('names and links the Sevalla API on every tool that takes operation IDs', () => {
      for (const tool of tools.filter((t) => t.name.startsWith('sevalla_api_'))) {
        ok(tool.description?.includes('Sevalla API v3'), tool.name)
        ok(tool.description?.includes(API_DOCS_URL), tool.name)
      }
    })

    it('keeps the tool list within the token budget', () => {
      const size = JSON.stringify(tools).length
      ok(size <= MAX_TOOLS_LIST_CHARS, `tools/list is ${size} characters`)
    })

    it('keeps server instructions short and factual', () => {
      ok(instructions.length > 0 && instructions.length <= 2_000)
      for (const pattern of MODEL_DIRECTED) {
        ok(!pattern.test(instructions), `instructions match ${pattern}`)
      }
    })
  })
}

describe('directory policy across protocol eras', () => {
  it('serves identical tool definitions and instructions to both eras', () => {
    deepStrictEqual(ERAS.modern.tools, ERAS.legacy.tools)
    strictEqual(ERAS.modern.instructions, ERAS.legacy.instructions)
  })
})

describe('read-only enforcement', () => {
  it('gives read tools a client that can only send GET requests', () => {
    const api = readOnly(createSevallaClient({ token: 't', baseUrl: 'http://127.0.0.1:9' }))
    deepStrictEqual(Object.keys(api), ['get'])
  })

  it('passes the request abort signal to every API call', async () => {
    const seen: (AbortSignal | undefined)[] = []
    const request: SevallaClient['request'] = async (_method, _path, options) => {
      seen.push(options?.signal)
      return {} as never
    }
    const fake: SevallaClient = {
      request,
      get: (path) => request('GET', path),
      post: (path) => request('POST', path),
      put: (path) => request('PUT', path),
      patch: (path) => request('PATCH', path),
      delete: (path) => request('DELETE', path),
    }
    const input = z.object({})
    const reader = readTool({
      name: 'probe_read',
      title: 'Probe read',
      description: 'Reads one Sevalla resource for the signal test.',
      input,
      run: async (_args, { api }) => toolResult(await api.get('/x')),
    })
    const writer = writeTool('update', {
      name: 'probe_write',
      title: 'Probe write',
      description: 'Changes one Sevalla resource for the signal test.',
      input,
      run: async (_args, { api }) => toolResult(await api.post('/x', {})),
    })
    const controller = new AbortController()
    await reader.execute({}, { client: fake, signal: controller.signal })
    await writer.execute({}, { client: fake, signal: controller.signal })
    deepStrictEqual(seen, [controller.signal, controller.signal])
  })

  it('registers every read tool through readTool', () => {
    for (const tool of TOOLS.filter((t) => t.kind === 'read')) {
      ok(!/^(create|update|delete|set|trigger|rollback|scale|add)_/.test(tool.name), tool.name)
    }
  })
})
