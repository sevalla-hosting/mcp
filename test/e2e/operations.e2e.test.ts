import { after, before, describe, it } from 'node:test'
import { ok, strictEqual } from 'node:assert'
import {
  executorToolFor,
  isExecutable,
  OPERATIONS,
  unavailableReason,
  type Operation,
  type OperationParameter,
} from '../../src/sevalla/operations.ts'
import { TOKENS } from '../support/fake-api.ts'
import { startHarness, type Harness, type McpSession } from '../support/harness.ts'

const SAMPLE_UUID = '12345678-1234-4123-8123-123456789abc'

const sampleQueryValue = (param: OperationParameter): string | number | boolean => {
  const schema = param.schema
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0] as string
  }
  if (schema.format === 'date-time') {
    return new Date(Date.now() - 3_600_000).toISOString()
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    return typeof schema.minimum === 'number' ? schema.minimum : 1
  }
  if (schema.type === 'boolean') {
    return true
  }
  return 'sample'
}

const callArgs = (op: Operation) => {
  const pathParams = Object.fromEntries(
    op.params.filter((p) => p.in === 'path').map((p) => [p.name, p.schema.pattern ? SAMPLE_UUID : 'sample-value']),
  )
  const query = Object.fromEntries(
    op.params.filter((p) => p.in === 'query' && p.required).map((p) => [p.name, sampleQueryValue(p)]),
  )
  return {
    operation_id: op.id,
    ...(Object.keys(pathParams).length > 0 ? { path_params: pathParams } : {}),
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(op.body ? { body: {} } : {}),
  }
}

const expectedPath = (op: Operation) =>
  `/v3${op.path.replace(/\{([^}]+)\}/g, (_, name: string) =>
    op.params.find((p) => p.name === name)?.schema.pattern ? SAMPLE_UUID : 'sample-value',
  )}`

let h: Harness
let session: McpSession

before(async () => {
  h = await startHarness()
  session = await h.connect({ token: TOKENS.valid })
})

after(async () => {
  await h.close()
})

describe('e2e: every executable operation dispatches correctly', () => {
  const executable = OPERATIONS.filter((op) => isExecutable(op))

  it('covers every operation without a dedicated tool except sign-in plumbing and the terminal', () => {
    strictEqual(executable.length, 175)
  })

  for (const op of executable) {
    it(`${executorToolFor(op.class)} runs ${op.id} as ${op.method} ${op.path}`, async () => {
      const before = h.api.requests.length
      const res = await session.call(executorToolFor(op.class), callArgs(op))
      strictEqual(res.isError, false, res.text)
      const upstream = h.api.requests.slice(before)
      strictEqual(upstream.length, 1)
      strictEqual(upstream[0]?.method, op.method)
      strictEqual(upstream[0]?.path, expectedPath(op))
      strictEqual(upstream[0]?.operationId, op.id)
      strictEqual(upstream[0]?.token, TOKENS.valid)
    })
  }
})

describe('e2e: non-executable operations are refused without calling the API', () => {
  const refused = OPERATIONS.filter((op) => !isExecutable(op))

  for (const op of refused) {
    it(`${op.id} is refused`, async () => {
      const before = h.api.requests.length
      const res = await session.call(executorToolFor(op.class), callArgs(op))
      strictEqual(res.isError, true)
      const reason = unavailableReason(op)
      ok(op.dedicatedTool ? res.text.includes(op.dedicatedTool) : reason !== undefined && res.text.includes(reason))
      strictEqual(h.api.requests.length - before, 0)
    })
  }
})
