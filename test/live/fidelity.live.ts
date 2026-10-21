import { after, before, describe, it } from 'node:test'
import { deepStrictEqual } from 'node:assert'
import { fillPath, getOperation, type Operation } from '../../src/sevalla/operations.ts'
import { IDS, startFakeApi, TOKENS, type FakeApi } from '../support/fake-api.ts'

const API_KEY = process.env.SEVALLA_E2E_API_KEY
const REAL_API = 'https://api.sevalla.com/v3'

const OPERATIONS = [
  'getCurrentApiKeyV3',
  'listApplicationsV3',
  'getApplicationV3',
  'listProcessesV3',
  'getProcessV3',
  'listApplicationDomainsV3',
  'listDeploymentsV3',
  'getDeploymentV3',
  'getApplicationDeploymentLogsV3',
  'getApplicationRuntimeLogsV3',
  'getApplicationAccessLogsV3',
  'getApplicationRequestsPerMinuteV3',
  'getApplicationResponseTimeAvgV3',
  'getApplicationTopStatusCodesV3',
  'getApplicationSlowestRequestsV3',
  'getApplicationStatusCodesV3',
  'getProcessCpuUsageV3',
  'getProcessMemoryUsageV3',
  'getProcessInstanceCountV3',
  'getProcessExitCodesV3',
  'listDatabasesV3',
  'getDatabaseV3',
  'listDatabaseBackupsV3',
  'listDatabaseInternalConnectionsV3',
  'getDatabaseCpuUsageV3',
  'getDatabaseMemoryUsageV3',
  'getDatabaseUsedStorageV3',
  'getDatabaseAllStorageV3',
  'listClustersV3',
  'listProcessResourceTypesV3',
  'listDatabaseResourceTypesV3',
  'listDatabaseVersionsV3',
  'listWebhooksV3',
]

interface Ids {
  app: string
  process: string
  deployment: string
  db: string
  cluster: string
}

interface Shape {
  types: Map<string, Set<string>>
  emptyArrays: Set<string>
}

const record = (value: unknown, path: string, shape: Shape) => {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  const types = shape.types.get(path) ?? new Set()
  types.add(type)
  shape.types.set(path, types)
  if (Array.isArray(value)) {
    if (value.length === 0 && !shape.types.has(`${path}[]`)) {
      shape.emptyArrays.add(path)
    }
    for (const item of value) {
      shape.emptyArrays.delete(path)
      record(item, `${path}[]`, shape)
    }
  } else if (type === 'object') {
    for (const [key, child] of Object.entries(value as object)) {
      record(child, path ? `${path}.${key}` : key, shape)
    }
  }
}

const shapeOf = (value: unknown): Shape => {
  const shape = { types: new Map(), emptyArrays: new Set<string>() }
  record(value, '', shape)
  return shape
}

const parentOf = (path: string) => path.replace(/(\[\]|\.[^.[\]]+)$/, '')

const differences = (fake: Shape, real: Shape): string[] => {
  const found: string[] = []
  for (const [path, fakeTypes] of fake.types) {
    if ([...real.emptyArrays].some((empty) => path.startsWith(`${empty}[]`))) {
      continue
    }
    const realTypes = real.types.get(path)
    if (!realTypes) {
      const parent = real.types.get(parentOf(path))
      if (parent && [...parent].some((t) => t !== 'null')) {
        found.push(`${path} is in the fake only`)
      }
      continue
    }
    const fakeKnown = [...fakeTypes].filter((t) => t !== 'null')
    const realKnown = [...realTypes].filter((t) => t !== 'null')
    if (fakeKnown.length > 0 && realKnown.length > 0 && !fakeKnown.some((t) => realKnown.includes(t))) {
      found.push(`${path} is ${fakeKnown.join('|')} in the fake and ${realKnown.join('|')} in the API`)
    }
  }
  return found
}

const idKey = (op: Operation, param: string): keyof Ids =>
  param === 'id'
    ? op.path.startsWith('/databases')
      ? 'db'
      : 'app'
    : param === 'process_id'
      ? 'process'
      : param === 'deployment_id'
        ? 'deployment'
        : 'cluster'

const idParams = (op: Operation) =>
  op.params.filter((p) => p.in === 'path' || (p.in === 'query' && p.name === 'cluster_id'))

const pathFor = (op: Operation, ids: Partial<Ids>) =>
  fillPath(
    op,
    Object.fromEntries(op.params.filter((p) => p.in === 'path').map((p) => [p.name, ids[idKey(op, p.name)]])),
  )

const queryFor = (op: Operation, ids: Partial<Ids>) => {
  const now = Date.now()
  const values: Record<string, string> = {
    from: new Date(now - 86_400_000).toISOString(),
    to: new Date(now).toISOString(),
    interval_in_seconds: '3600',
    cluster_id: ids.cluster as string,
  }
  const query = new URLSearchParams()
  for (const p of op.params.filter((x) => x.in === 'query' && values[x.name] !== undefined)) {
    query.set(p.name, values[p.name] as string)
  }
  return query.size > 0 ? `?${query}` : ''
}

const get = async (base: string, token: string, path: string) => {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`GET ${path} returned ${res.status}: ${text.slice(0, 200)}`)
  }
  return JSON.parse(text)
}

describe(
  'fake API fidelity against the Sevalla API (read-only)',
  { skip: !API_KEY && 'SEVALLA_E2E_API_KEY is not set' },
  () => {
    let fake: FakeApi
    let real: Partial<Ids>
    const fakeIds: Ids = {
      app: IDS.app,
      process: IDS.process,
      deployment: IDS.deployment,
      db: IDS.db,
      cluster: IDS.cluster,
    }
    const live = (path: string) => get(REAL_API, API_KEY as string, path)

    before(async () => {
      fake = await startFakeApi()
      const apps = (await live('/applications?limit=100')).data
      const app = apps.find((a: any) => a.status === 'deploymentSuccess') ?? apps[0]
      const none = { data: [] }
      const [processes, deployments, databases, clusters] = await Promise.all([
        app ? live(`/applications/${app.id}/processes`) : none,
        app ? live(`/applications/${app.id}/deployments?limit=1`) : none,
        live('/databases?limit=1'),
        live('/resources/clusters'),
      ])
      real = {
        app: app?.id,
        process: processes.data[0]?.id,
        deployment: deployments.data[0]?.id,
        db: databases.data[0]?.id,
        cluster: (clusters.data ?? clusters)[0]?.id,
      }
    })

    after(async () => {
      await fake?.close()
    })

    for (const id of OPERATIONS) {
      it(`${id} has the shape of the real response`, async (t) => {
        const op = getOperation(id) as Operation
        const missing = idParams(op).filter((p) => !real[idKey(op, p.name)])
        if (missing.length > 0) {
          t.skip(`the account has nothing for ${missing.map((p) => p.name).join(', ')}`)
          return
        }
        const [fakeBody, realBody] = await Promise.all([
          get(`${fake.url}/v3`, TOKENS.valid, `${pathFor(op, fakeIds)}${queryFor(op, fakeIds)}`),
          live(`${pathFor(op, real)}${queryFor(op, real)}`),
        ])
        deepStrictEqual(differences(shapeOf(fakeBody), shapeOf(realBody)), [])
      })
    }
  },
)
