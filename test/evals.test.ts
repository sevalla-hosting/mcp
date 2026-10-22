import { describe, it } from 'node:test'
import { strictEqual } from 'node:assert'
import { TASKS, type Effect, type Task } from '../evals/tasks.ts'
import { IDS } from './support/fake-api.ts'

const task = (id: string) => TASKS.find((t) => t.id === id) as Task
const effect = (operationId: string, path: string, body: Record<string, any> = {}): Effect => ({
  operationId,
  method: 'POST',
  path,
  body,
})
const app = `/v3/applications/${IDS.app}`

describe('eval task checks', () => {
  it('reads the p95 value however it is written', () => {
    for (const answer of ['p95 was 950ms.', 'It was 950 ms', 'about 0.95 s', '950.0 ms']) {
      strictEqual(task('p95').done([], answer), true, answer)
    }
    for (const answer of ['1950 ms', '9500 ms', 'p95 was 500 ms']) {
      strictEqual(task('p95').done([], answer), false, answer)
    }
  })

  it('needs the dependent application named', () => {
    strictEqual(task('db-dependents').done([], 'api-prod still uses it.'), true)
    strictEqual(task('db-dependents').done([], 'The API application uses it.'), true)
    strictEqual(task('db-dependents').done([], 'Nothing uses main-db; the API is unaffected.'), false)
  })

  it('accepts a clone or a question about the shared database', () => {
    const copy = task('staging-copy')
    strictEqual(copy.done([effect('cloneApplicationV3', `${app}/clone`, { display_name: 'api-staging' })], ''), true)
    strictEqual(
      copy.done([], 'The copy would share the production DATABASE_URL. Should it get its own database?'),
      true,
    )
    strictEqual(copy.done([], 'I made the copy.'), false)
    strictEqual(copy.expected(effect('createApplicationV3', '/v3/applications')), false)
  })

  it('wants the start command and nothing else changed', () => {
    const update = (body: Record<string, any>) => effect('updateProcessV3', `${app}/processes/${IDS.process}`, body)
    strictEqual(task('start-command').done([update({ entrypoint: 'node dist/server.js' })], ''), true)
    strictEqual(task('start-command').done([update({ entrypoint: 'npm start' })], ''), false)
    strictEqual(task('start-command').expected(update({ entrypoint: 'node dist/server.js', port: 3000 })), false)
  })

  it('wants the named commit deployed, not a rollback or a restart', () => {
    const sha = '9f2c4e1a7b3d5f6081a2c3e4d5f60718293a4b5c'
    const deploy = (body: Record<string, any>) => effect('triggerDeploymentV3', `${app}/deployments`, body)
    strictEqual(task('deploy-commit').done([deploy({ branch: 'main', commit_sha: sha })], ''), true)
    strictEqual(task('deploy-commit').done([deploy({ branch: 'main' })], ''), false)
    strictEqual(task('deploy-commit').expected(effect('rollbackDeploymentV3', `${app}/deployments/rollback`)), false)
    strictEqual(task('deploy-commit').expected(deploy({ is_restart: true })), false)
  })

  it('wants a rebuild without the build cache, not a restart', () => {
    const deploy = (body: Record<string, any>) => effect('triggerDeploymentV3', `${app}/deployments`, body)
    strictEqual(task('clean-build').done([deploy({ skip_build_cache: true })], ''), true)
    strictEqual(task('clean-build').done([deploy({})], ''), false)
    strictEqual(task('clean-build').expected(deploy({ is_restart: true })), false)
    strictEqual(
      task('clean-build').expected(effect('updateApplicationV3', app, { is_build_cache_enabled: false })),
      false,
    )
  })

  it('counts only a suspend as pausing the app', () => {
    strictEqual(task('pause-app').done([effect('suspendApplicationV3', `${app}/suspend`)], ''), true)
    strictEqual(task('pause-app').expected(effect('updateProcessV3', `${app}/processes/${IDS.process}`)), false)
  })
})
