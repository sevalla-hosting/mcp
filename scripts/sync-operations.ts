import { readFileSync, writeFileSync } from 'node:fs'

const SPEC_URL = process.env.SEVALLA_SPEC_URL || 'https://api.sevalla.com/v3/openapi.json'
const OUTPUT = new URL('../src/sevalla/operations.json', import.meta.url)
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const MAX_DESCRIPTION = 400
const MAX_FIELD_DESCRIPTION = 200
const MAX_DEPTH = 6

type Json = Record<string, any>

const clip = (text: unknown, max: number): string | undefined => {
  if (typeof text !== 'string' || text.length === 0) {
    return undefined
  }
  const singleLine = text.replace(/\s+/g, ' ').trim()
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine
}

const nonNull = (schemas: Json[]): Json[] => schemas.filter((s) => s.type !== 'null')

const trimSchema = (schema: Json | undefined, depth = 0, keepPattern = false): Json | undefined => {
  if (!schema || typeof schema !== 'object') {
    return undefined
  }
  const alternatives = schema.anyOf ?? schema.oneOf
  if (Array.isArray(alternatives)) {
    const options = nonNull(alternatives)
    const nullable = options.length < alternatives.length
    if (options.length === 1) {
      const single = trimSchema(
        { ...options[0], description: schema.description ?? options[0].description },
        depth,
        keepPattern,
      )
      return single && nullable ? { ...single, nullable: true } : single
    }
    const out: Json = { oneOf: options.map((o) => trimSchema(o, depth + 1, keepPattern)).filter(Boolean) }
    const description = clip(schema.description, MAX_FIELD_DESCRIPTION)
    if (description) {
      out.description = description
    }
    if (nullable) {
      out.nullable = true
    }
    return out
  }
  const out: Json = {}
  if (schema.type !== undefined) {
    out.type = schema.type
  }
  const description = clip(schema.description, MAX_FIELD_DESCRIPTION)
  if (description) {
    out.description = description
  }
  for (const key of [
    'enum',
    'const',
    'default',
    'format',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ]) {
    if (schema[key] !== undefined) {
      out[key] = schema[key]
    }
  }
  if (keepPattern && typeof schema.pattern === 'string') {
    out.pattern = schema.pattern
  }
  if (depth >= MAX_DEPTH) {
    return out
  }
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties as Json).map(([name, value]) => [name, trimSchema(value as Json, depth + 1)]),
    )
    if (Array.isArray(schema.required) && schema.required.length > 0) {
      out.required = schema.required
    }
  }
  if (schema.items) {
    out.items = trimSchema(schema.items, depth + 1)
  }
  return out
}

const trimParameter = (param: Json): Json => {
  const out: Json = { name: param.name, in: param.in, required: param.required === true }
  const description = clip(param.description, MAX_FIELD_DESCRIPTION)
  if (description) {
    out.description = description
  }
  out.schema = trimSchema(param.schema, 0, param.in === 'path') ?? {}
  return out
}

export const buildSnapshot = (spec: Json): Json => {
  const operations: Json[] = []
  for (const path of Object.keys(spec.paths ?? {}).sort()) {
    const item = spec.paths[path]
    for (const method of METHODS) {
      const op = item?.[method]
      if (!op) {
        continue
      }
      if (typeof op.operationId !== 'string') {
        throw new Error(`${method.toUpperCase()} ${path} has no operationId`)
      }
      const body = op.requestBody?.content?.['application/json']?.schema
      operations.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        tag: op.tags?.[0] ?? 'Other',
        summary: op.summary ?? op.operationId,
        description: clip(op.description, MAX_DESCRIPTION) ?? '',
        params: (op.parameters ?? []).filter((p: Json) => p.in === 'path' || p.in === 'query').map(trimParameter),
        body: body ? trimSchema(body) : null,
        bodyRequired: op.requestBody?.required === true,
        ...(Array.isArray(op['x-required-permissions']) ? { permissions: op['x-required-permissions'] } : {}),
      })
    }
  }
  const ids = new Set(operations.map((o) => o.id))
  if (ids.size !== operations.length) {
    throw new Error('Duplicate operationId in spec')
  }
  return { source: SPEC_URL, version: spec.info?.version ?? 'unknown', operations }
}

const serialize = (snapshot: Json): string => `${JSON.stringify(snapshot, null, 2)}\n`

const run = async () => {
  const res = await fetch(SPEC_URL)
  if (!res.ok) {
    throw new Error(`Failed to fetch ${SPEC_URL}: ${res.status} ${res.statusText}`)
  }
  const next = serialize(buildSnapshot((await res.json()) as Json))
  if (process.argv.includes('--check')) {
    const current = readFileSync(OUTPUT, 'utf8')
    if (JSON.stringify(JSON.parse(current)) !== JSON.stringify(JSON.parse(next))) {
      const before = new Set((JSON.parse(current).operations as Json[]).map((o) => JSON.stringify(o)))
      const after = (JSON.parse(next).operations as Json[]).filter((o) => !before.has(JSON.stringify(o)))
      const removed = (JSON.parse(current).operations as Json[]).filter(
        (o) => !(JSON.parse(next).operations as Json[]).some((n) => JSON.stringify(n) === JSON.stringify(o)),
      )
      console.error('The live Sevalla API spec differs from src/sevalla/operations.json.')
      console.error(`Added or changed: ${after.map((o) => o.id).join(', ') || 'none'}`)
      console.error(`Removed or changed: ${removed.map((o) => o.id).join(', ') || 'none'}`)
      console.error('Run `pnpm sync:operations`, review the classification in src/sevalla/operations.ts, and commit.')
      process.exit(1)
    }
    console.log('src/sevalla/operations.json matches the live spec.')
    return
  }
  writeFileSync(OUTPUT, next)
  console.log(`Wrote ${JSON.parse(next).operations.length} operations to src/sevalla/operations.json`)
}

if (import.meta.main) {
  await run()
}
