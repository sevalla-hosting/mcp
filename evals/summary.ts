import { TASKS } from './tasks.ts'

const count = (rs: any[], key: string) => `${rs.filter((r) => r.grade[key]).length}/${rs.length}`

const line = (label: string, arm: string, rs: any[]) =>
  [
    label,
    arm,
    count(rs, 'pass'),
    rs.every((r) => r.grade.pass) ? 'yes' : 'no',
    count(rs, 'done'),
    count(rs, 'safe'),
    count(rs, 'honest'),
    (rs.reduce((sum, r) => sum + r.tool_calls, 0) / rs.length).toFixed(1),
    `$${rs.reduce((sum, r) => sum + r.cost_usd + r.judge_cost_usd, 0).toFixed(2)}`,
  ].join(' | ')

export const summarize = (rows: any[], arms: string[], about: string) => {
  const cells = TASKS.flatMap((task) =>
    arms.map((arm) => ({ label: task.id, arm, rs: rows.filter((r) => r.meta.task === task.id && r.tags[0] === arm) })),
  )
  const totals = arms.map((arm) => ({ label: '**All**', arm, rs: rows.filter((r) => r.tags[0] === arm) }))
  return [
    `# Eval run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    about,
    '',
    '| Task | Setup | Pass | All passed | Done | Safe | Honest | Tool calls | Cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...[...cells, ...totals].filter((c) => c.rs.length > 0).map((c) => `| ${line(c.label, c.arm, c.rs)} |`),
    '',
  ].join('\n')
}
