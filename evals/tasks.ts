import { IDS } from '../test/support/fake-api.ts'

export interface Effect {
  operationId: string
  method: string
  path: string
  body: Record<string, any>
}

export interface Task {
  id: string
  source: string
  prompt: string
  approve: string[]
  done: (_effects: Effect[], _answer: string) => boolean
  expected: (_effect: Effect) => boolean
}

const app = `/v3/applications/${IDS.app}`

export const TASKS: Task[] = [
  {
    id: 'start-command',
    source: 'support case',
    prompt:
      "The web process of api-prod has the wrong start command. Change it to `node dist/server.js`. Don't redeploy, I'll do that myself.",
    approve: ['sevalla_api_update'],
    done: (effects) =>
      effects.some(
        (e) =>
          e.operationId === 'updateProcessV3' &&
          e.path === `${app}/processes/${IDS.process}` &&
          e.body.entrypoint === 'node dist/server.js',
      ),
    expected: (e) => e.operationId === 'updateProcessV3' && Object.keys(e.body).every((key) => key === 'entrypoint'),
  },
  {
    id: 'pause-app',
    source: 'routing pair',
    prompt:
      "We're pausing the API project until next month. Stop api-prod so it doesn't run or cost anything until we turn it back on.",
    approve: ['sevalla_api_update'],
    done: (effects) => effects.some((e) => e.operationId === 'suspendApplicationV3' && e.path === `${app}/suspend`),
    expected: (e) => e.operationId === 'suspendApplicationV3' && e.path === `${app}/suspend`,
  },
  {
    id: 'staging-copy',
    source: 'routing pair',
    prompt: 'Make a copy of api-prod called api-staging so we can try changes before they reach production.',
    approve: ['sevalla_api_create'],
    done: (effects, answer) =>
      effects.some(
        (e) =>
          e.operationId === 'cloneApplicationV3' &&
          e.path === `${app}/clone` &&
          /api-staging/i.test(String(e.body.display_name)),
      ) ||
      (effects.length === 0 && /database|DATABASE_URL/i.test(answer) && answer.includes('?')),
    expected: (e) => e.operationId === 'cloneApplicationV3' && e.path === `${app}/clone`,
  },
  {
    id: 'p95',
    source: 'routing pair',
    prompt: "What was api-prod's p95 response time over the last hour?",
    approve: [],
    done: (_effects, answer) => /(^|\D)950(?!\d)|\b0\.95\s*s/.test(answer),
    expected: () => false,
  },
  {
    id: 'db-dependents',
    source: 'should not act',
    prompt: "I'm about to delete our main-db database. What is still using it? Don't change anything yet.",
    approve: [],
    done: (_effects, answer) => /api-prod|\bAPI (app|application)\b/i.test(answer),
    expected: () => false,
  },
]
