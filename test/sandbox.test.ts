import { describe, it } from 'node:test'
import { deepStrictEqual, strictEqual } from 'node:assert'
import { resolveRefs, processSpec, extractTags } from '../src/sandbox.ts'

describe('resolveRefs', () => {
  it('resolves a simple $ref', () => {
    const spec = {
      paths: { '/a': { $ref: '#/components/schemas/A' } },
      components: { schemas: { A: { type: 'string' } } },
    }
    const result = resolveRefs(spec.paths, spec)
    deepStrictEqual(result, { '/a': { type: 'string' } })
  })

  it('detects circular references', () => {
    const spec = {
      paths: { '/a': { $ref: '#/components/schemas/A' } },
      components: { schemas: { A: { self: { $ref: '#/components/schemas/A' } } } },
    }
    const result = resolveRefs(spec.paths, spec)
    deepStrictEqual(result['/a'].self, { $circular: '#/components/schemas/A' })
  })

  it('blocks dangerous keys in ref paths', () => {
    const spec = {
      paths: { '/a': { $ref: '#/__proto__/bad' } },
      __proto__: { bad: { type: 'object' } },
    }
    const result = resolveRefs(spec.paths, spec)
    strictEqual(result['/a'].$error, 'unsafe ref path')
  })

  it('respects max depth', () => {
    const spec = {
      paths: { '/a': { $ref: '#/components/schemas/A' } },
      components: { schemas: { A: { nested: { $ref: '#/components/schemas/A' } } } },
    }
    const result = resolveRefs(spec.paths, spec, new Set(), 1)
    strictEqual(result['/a'].nested.$reason, 'max depth exceeded')
  })
})

describe('processSpec', () => {
  it('extracts operations with server base path prepended', () => {
    const spec = {
      servers: [{ url: 'https://api.example.com/v3' }],
      paths: {
        '/items': {
          get: { summary: 'List items', tags: ['items'], description: 'Gets all items' },
          post: { summary: 'Create item', tags: ['items'], requestBody: { required: true } },
        },
      },
      components: {},
    }
    const result = processSpec(spec)
    strictEqual(result.paths['/v3/items'] !== undefined, true)
    strictEqual(result.paths['/v3/items'].get.summary, 'List items')
    strictEqual(result.paths['/v3/items'].post.summary, 'Create item')
    strictEqual(result.paths['/items'], undefined)
  })

  it('drops fields not in the extraction list', () => {
    const spec = {
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/items': {
          get: { summary: 'List', operationId: 'listItems', deprecated: true, security: [] },
        },
      },
      components: {},
    }
    const result = processSpec(spec)
    strictEqual(result.paths['/items'].get.summary, 'List')
    strictEqual(result.paths['/items'].get.operationId, undefined)
    strictEqual(result.paths['/items'].get.deprecated, undefined)
  })
})

describe('extractTags', () => {
  it('returns tags sorted by frequency', () => {
    const spec = {
      paths: {
        '/a': { get: { tags: ['common', 'rare'] }, post: { tags: ['common'] } },
        '/b': { get: { tags: ['medium'] }, put: { tags: ['medium', 'common'] } },
      },
    }
    const tags = extractTags(spec)
    deepStrictEqual(tags, ['common', 'medium', 'rare'])
  })

  it('returns empty array when no tags', () => {
    const spec = { paths: { '/a': { get: { summary: 'no tags' } } } }
    deepStrictEqual(extractTags(spec), [])
  })
})
