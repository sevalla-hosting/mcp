import { describe, it } from 'node:test'
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import {
  ADDITIVE_OPERATIONS,
  checkQuery,
  classify,
  DEDICATED_TOOLS,
  fillPath,
  getOperation,
  isExecutable,
  OperationInputError,
  OPERATIONS,
  searchOperations,
  secretFieldsFor,
  unavailableReason,
  type Operation,
} from '../src/sevalla/operations.ts'
import { TOOLS } from '../src/tools/index.ts'

const op = (id: string): Operation => {
  const found = getOperation(id)
  if (!found) {
    throw new Error(`missing operation ${id}`)
  }
  return found
}

const UUID = '12345678-1234-4123-8123-123456789abc'

describe('operation snapshot', () => {
  it('contains every operation of the v3 API exactly once', () => {
    strictEqual(OPERATIONS.length, 244)
    strictEqual(new Set(OPERATIONS.map((o) => o.id)).size, 244)
    for (const o of OPERATIONS) {
      ok(o.path.startsWith('/'), o.id)
      ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(o.method), o.id)
    }
  })

  it('types every path parameter and requires it', () => {
    for (const o of OPERATIONS) {
      for (const p of o.params.filter((param) => param.in === 'path')) {
        strictEqual(p.required, true, `${o.id}.${p.name}`)
        ok(o.path.includes(`{${p.name}}`), `${o.id}.${p.name}`)
      }
    }
  })
})

describe('classification', () => {
  it('derives the class from the method and the reviewed additive list', () => {
    strictEqual(classify('GET', 'anything'), 'read')
    strictEqual(classify('DELETE', 'anything'), 'delete')
    strictEqual(classify('POST', 'createProjectV3'), 'create')
    strictEqual(classify('POST', 'restoreDatabaseBackupV3'), 'update')
    strictEqual(classify('PATCH', 'updateApplicationV3'), 'update')
  })

  it('lists only existing POST operations as additive', () => {
    for (const id of ADDITIVE_OPERATIONS) {
      strictEqual(op(id).method, 'POST', id)
    }
  })

  it('pins the reviewed list of additive operations', () => {
    deepStrictEqual([...ADDITIVE_OPERATIONS].sort(), [
      'addApplicationDomainV3',
      'addStaticSiteDomainV3',
      'cloneApplicationV3',
      'createApplicationPrivatePortV3',
      'createApplicationV3',
      'createDatabaseBackupV3',
      'createDatabaseInternalConnectionV3',
      'createDatabaseV3',
      'createDeviceCodeV3',
      'createDockerRegistryV3',
      'createEnvironmentVariableV3',
      'createGlobalEnvVarV3',
      'createLoadBalancerV3',
      'createObjectStorageV3',
      'createPipelineStageV3',
      'createPipelineV3',
      'createProcessV3',
      'createProjectV3',
      'createStaticSiteEnvVarV3',
      'createStaticSiteV3',
    ])
  })

  it('treats operations that move data or credentials off the platform or open exposure as updates', () => {
    for (const id of [
      'createDatabaseBackupTargetV3',
      'createDatabaseExternalBackupV3',
      'createWebhookV3',
      'createApiKeyV3',
      'createUsageAlertConfigV3',
      'createApplicationTcpProxyV3',
      'createObjectStorageDomainV3',
      'createObjectStorageCorsPolicyV3',
      'addLoadBalancerDomainV3',
      'createLoadBalancerDestinationV3',
    ]) {
      strictEqual(op(id).class, 'update', id)
    }
  })

  it('treats state-changing POST operations as updates', () => {
    for (const id of [
      'execProcessCommandV3',
      'triggerProcessCronV3',
      'suspendApplicationV3',
      'promotePipelineV3',
      'purgeApplicationCacheV3',
      'restoreDatabaseBackupV3',
      'resetDatabasePasswordV3',
      'rollbackDeploymentV3',
    ]) {
      strictEqual(op(id).class, 'update', id)
    }
  })

  it('maps dedicated operations to tools that exist', () => {
    const names = new Set(TOOLS.map((t) => t.name))
    for (const [id, tool] of Object.entries(DEDICATED_TOOLS)) {
      ok(getOperation(id), id)
      ok(names.has(tool), tool)
    }
    for (const o of OPERATIONS.filter((x) => x.path.includes('/metrics/'))) {
      strictEqual(o.dedicatedTool, 'get_metrics', o.id)
    }
  })

  it('exposes the expected operation counts per class', () => {
    const counts: Record<string, number> = { read: 0, create: 0, update: 0, delete: 0 }
    for (const o of OPERATIONS.filter((x) => isExecutable(x))) {
      counts[o.class] = (counts[o.class] ?? 0) + 1
    }
    deepStrictEqual(counts, { read: 52, create: 10, update: 74, delete: 29 })
    strictEqual(OPERATIONS.filter((o) => o.dedicatedTool).length, 76)
  })
})

describe('availability', () => {
  it('exposes every operation except sign-in plumbing and the terminal WebSocket', () => {
    const unavailable = OPERATIONS.filter((o) => unavailableReason(o))
      .map((o) => o.id)
      .sort()
    deepStrictEqual(unavailable, ['createDeviceCodeV3', 'openTerminalV3', 'pollDeviceCodeV3'])
  })

  it('allows deletes, API key management and secret issuance', () => {
    for (const id of [
      'deleteApplicationV3',
      'deleteDatabaseV3',
      'createApiKeyV3',
      'rotateApiKeyV3',
      'rollWebhookSecretV3',
      'getDeploymentHookV3',
      'getDatabaseExternalBackupDownloadUrlV3',
    ]) {
      strictEqual(isExecutable(op(id)), true, id)
    }
  })

  it('redacts environment variable values only', () => {
    ok(secretFieldsFor(op('listEnvironmentVariablesV3')).has('value'))
    ok(secretFieldsFor(op('updateGlobalEnvVarV3')).has('value'))
    strictEqual(secretFieldsFor(op('listWebhooksV3')).size, 0)
    strictEqual(secretFieldsFor(op('createApiKeyV3')).size, 0)
  })
})

describe('fillPath', () => {
  it('fills and encodes path parameters', () => {
    strictEqual(fillPath(op('getProjectV3'), { id: UUID }), `/projects/${UUID}`)
  })

  it('rejects missing, unknown and malformed parameters', () => {
    throws(() => fillPath(op('getProjectV3'), {}), OperationInputError)
    throws(() => fillPath(op('getProjectV3'), { id: UUID, other: 'x' }), /Unknown path parameter/)
    throws(() => fillPath(op('getProjectV3'), { id: 'not-a-uuid' }), /must be a valid/)
  })

  it('blocks path traversal in parameters without a UUID pattern', () => {
    const withFreeParam = OPERATIONS.find((o) => o.params.some((p) => p.in === 'path' && !p.schema.pattern))
    ok(withFreeParam, 'expected an operation with a free-form path parameter')
    const param = withFreeParam.params.find((p) => p.in === 'path' && !p.schema.pattern)?.name as string
    const others = Object.fromEntries(
      withFreeParam.params.filter((p) => p.in === 'path' && p.name !== param).map((p) => [p.name, UUID]),
    )
    for (const value of ['../applications', 'a/b', 'a?b=c', 'a#b', '..', 'a\\b']) {
      throws(() => fillPath(withFreeParam, { ...others, [param]: value }), OperationInputError, value)
    }
  })
})

describe('checkQuery', () => {
  it('accepts known parameters and rejects unknown ones', () => {
    deepStrictEqual(checkQuery(op('listProjectsV3'), { limit: 5, search: 'shop' }), { limit: 5, search: 'shop' })
    throws(() => checkQuery(op('listProjectsV3'), { nope: 1 }), /Unknown query parameter "nope"/)
    throws(() => checkQuery(op('listProjectsV3'), { limit: { $gt: 1 } }), /must be a string, number or boolean/)
  })

  it('enforces required query parameters', () => {
    const required = OPERATIONS.find((o) => o.params.some((p) => p.in === 'query' && p.required) && !o.dedicatedTool)
    if (required) {
      throws(() => checkQuery(required, {}), /is required/)
    }
  })
})

describe('searchOperations', () => {
  it('ranks relevant operations first', () => {
    const ids = searchOperations({ query: 'restore database backup' }).map((o) => o.id)
    ok(ids.slice(0, 3).includes('restoreDatabaseBackupV3'), ids.join(', '))
  })

  it('filters by class and limit', () => {
    const results = searchOperations({ query: 'load balancer', cls: 'delete', limit: 3 })
    ok(results.length > 0 && results.length <= 3)
    ok(results.every((o) => o.class === 'delete'))
  })

  it('matches everyday words for the API terms', () => {
    const top = (query: string) => searchOperations({ query })[0]?.id
    strictEqual(top('duplicate app'), 'cloneApplicationV3')
    strictEqual(top('move application to another region'), 'cloneApplicationV3')
    strictEqual(top('move app to project'), 'addServiceToProjectV3')
    strictEqual(top('pause app'), 'suspendApplicationV3')
    strictEqual(top('stop deployment'), 'cancelDeploymentV3')
    strictEqual(top('resume database'), 'activateDatabaseV3')
    strictEqual(top('restart app'), 'triggerDeploymentV3')
    strictEqual(top('restart database'), 'restartDatabaseV3')
    strictEqual(top('add worker to app'), 'createProcessV3')
    strictEqual(top('region'), 'listClustersV3')
  })

  it('ranks the operation the query names above longer names that contain it', () => {
    strictEqual(searchOperations({ query: 'create application' })[0]?.id, 'createApplicationV3')
    strictEqual(searchOperations({ query: 'list apps' })[0]?.id, 'listApplicationsV3')
  })
})
