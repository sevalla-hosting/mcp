import { describe, it } from 'node:test'
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { ApiError } from '../src/sevalla/client.ts'
import {
  firstLine,
  formatApiError,
  formatLogLine,
  intervalFor,
  matchesText,
  omitEmpty,
  redact,
  resolveWindow,
  shortSha,
  summarizeSeries,
  truncate,
} from '../src/tools/format.ts'
import { bestExcerpt, parseLlmsTxt, rankDocs } from '../src/tools/docs.ts'

describe('truncate', () => {
  it('keeps short text and explains truncation of long text', () => {
    strictEqual(truncate('short', 10), 'short')
    const cut = truncate('x'.repeat(50), 10)
    ok(cut.startsWith('xxxxxxxxxx\n\n[Truncated: showing 10 of 50 characters.'))
  })
})

describe('redact', () => {
  it('replaces secret scalar fields at any depth', () => {
    const value = { data: [{ key: 'A', value: 's3cret', nested: { secret: 'x', keep: 'y' } }], total: 1 }
    deepStrictEqual(redact(value, new Set(['value', 'secret'])), {
      data: [{ key: 'A', value: '[redacted]', nested: { secret: '[redacted]', keep: 'y' } }],
      total: 1,
    })
  })

  it('returns the value unchanged when nothing is secret', () => {
    const value = { value: 'x' }
    strictEqual(redact(value, new Set()), value)
  })
})

describe('small helpers', () => {
  it('omits empty values but keeps false and zero', () => {
    deepStrictEqual(omitEmpty({ a: null, b: undefined, c: [], d: false, e: 0, f: 'x' }), { d: false, e: 0, f: 'x' })
  })

  it('shortens commit data', () => {
    strictEqual(firstLine('Title\nbody'), 'Title')
    strictEqual(firstLine(''), undefined)
    strictEqual(shortSha('abcdef123456'), 'abcdef1')
  })
})

describe('formatApiError', () => {
  it('turns status codes into actionable messages', () => {
    ok(formatApiError(new ApiError(401, 'Unauthorized')).includes('Reconnecting the Sevalla connector'))
    strictEqual(
      formatApiError(new ApiError(403, 'Forbidden', 'err-1')),
      'The Sevalla API refused the request: Forbidden.',
    )
    strictEqual(
      formatApiError(new ApiError(403, 'This API key is missing the APP:CREATE permission. Grant it to the key.')),
      'The Sevalla API refused the request: This API key is missing the APP:CREATE permission. Grant it to the key.',
    )
    ok(formatApiError(new ApiError(404, 'App not found')).includes('list_services'))
    ok(formatApiError(new ApiError(429, 'Too many', undefined, undefined, '30')).includes('after 30 seconds'))
    const serverError = formatApiError(new ApiError(500, 'Boom', 'err-9'))
    ok(serverError.includes('later attempt'))
    ok(!serverError.includes('err-9'))
    ok(formatApiError(new ApiError(422, 'Invalid', undefined, 'name is too short')).includes('name is too short'))
  })
})

describe('resolveWindow', () => {
  const now = new Date('2026-01-31T12:00:00.000Z')

  it('defaults to the last 60 minutes', () => {
    deepStrictEqual(resolveWindow({}, 60, now), {
      from: '2026-01-31T11:00:00.000Z',
      to: '2026-01-31T12:00:00.000Z',
      seconds: 3600,
    })
  })

  it('ends at end_time and honours since_minutes', () => {
    const window = resolveWindow({ since_minutes: 30, end_time: '2026-01-31T10:00:00Z' }, 60, now)
    strictEqual(window.from, '2026-01-31T09:30:00.000Z')
  })

  it('rejects invalid timestamps and windows longer than 30 days', () => {
    throws(() => resolveWindow({ end_time: 'yesterday' }, 60, now), /ISO 8601/)
    throws(() => resolveWindow({ since_minutes: 31 * 24 * 60 }, 60, now), /30 days/)
  })

  it('picks an interval of at least one minute', () => {
    strictEqual(intervalFor(3600), 60)
    strictEqual(intervalFor(86_400), 1440)
  })
})

describe('logs and series', () => {
  it('formats log lines from microsecond timestamps', () => {
    const line = formatLogLine({ message: 'hello\n', severity: 'warn', unix_timestamp: Date.UTC(2026, 0, 1) * 1000 })
    strictEqual(line, '2026-01-01T00:00:00.000Z WARN hello')
  })

  it('matches text in messages and attributes', () => {
    ok(matchesText({ message: 'Slow Query' }, 'slow'))
    ok(matchesText({ message: 'x', attributes: { clientRequestPath: '/api/orders' } }, 'orders'))
    ok(!matchesText({ message: 'x' }, 'y'))
  })

  it('summarizes and downsamples series', () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ time: `t${i}`, value: i }))
    const summary = summarizeSeries(points, 10)
    strictEqual(summary.min, 0)
    strictEqual(summary.max, 99)
    strictEqual(summary.last, 99)
    ok((summary.series?.length ?? 0) <= 10)
    deepStrictEqual(summarizeSeries([]), { points: 0 })
  })
})

describe('docs search helpers', () => {
  const llms = [
    '# Docs',
    '- [Custom domains](https://docs.sevalla.com/domains.md): Wildcard domains and SSL.',
    '- [Nixpacks](https://docs.sevalla.com/nixpacks.md): Node.js version for builds.',
    '- [Elsewhere](https://evil.example.com/x.md): Domains elsewhere.',
  ].join('\n')

  it('keeps only pages of the docs origin', () => {
    const entries = parseLlmsTxt(llms, 'https://docs.sevalla.com')
    deepStrictEqual(
      entries.map((e) => e.title),
      ['Custom domains', 'Nixpacks'],
    )
  })

  it('ranks by title, description and URL', () => {
    const entries = parseLlmsTxt(llms, 'https://docs.sevalla.com')
    strictEqual(rankDocs(entries, 'node version', 3)[0]?.title, 'Nixpacks')
    strictEqual(rankDocs(entries, 'wildcard ssl', 3)[0]?.title, 'Custom domains')
    deepStrictEqual(rankDocs(entries, 'kubernetes', 3), [])
  })

  it('picks the most relevant section of a page', () => {
    const page =
      '# Title\n\nIntro\n\n## Pricing\n\nCosts.\n\n## Wildcard SSL\n\nWildcard certificates are issued automatically.'
    ok(bestExcerpt(page, ['wildcard', 'ssl']).startsWith('## Wildcard SSL'))
  })
})
