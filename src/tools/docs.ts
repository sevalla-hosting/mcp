import { z } from 'zod'
import { tokenize } from '../sevalla/operations.ts'
import { readTool } from './define.ts'
import { toolError, toolResult } from './format.ts'

const DEFAULT_DOCS_URL = 'https://docs.sevalla.com'
const CACHE_TTL_MS = 60 * 60 * 1000
const MAX_PAGES_CACHED = 100
const MAX_PAGE_BYTES = 512 * 1024
const EXCERPT_CHARS = 1_800
const FETCH_TIMEOUT_MS = 10_000

export const getDocsBaseUrl = () => process.env.SEVALLA_DOCS_URL || DEFAULT_DOCS_URL

interface DocEntry {
  title: string
  url: string
  description: string
  terms: { title: Set<string>; description: Set<string>; url: Set<string> }
}

let index: { entries: DocEntry[]; fetchedAt: number; base: string } | undefined
const pages = new Map<string, { text: string; fetchedAt: number }>()

const fetchText = async (url: string): Promise<string> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'error' })
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`)
  }
  const text = await res.text()
  return text.length > MAX_PAGE_BYTES ? text.slice(0, MAX_PAGE_BYTES) : text
}

const termSet = (text: string) => new Set(tokenize(text))

export const parseLlmsTxt = (text: string, origin: string): DocEntry[] =>
  text
    .split('\n')
    .map((line) => line.match(/^\s*-\s*\[(.+?)\]\((\S+?)\)(?::\s*(.*))?$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ title: m[1] ?? '', url: m[2] ?? '', description: (m[3] ?? '').trim() }))
    .filter((e) => {
      try {
        return new URL(e.url).origin === origin
      } catch {
        return false
      }
    })
    .map((e) => ({
      ...e,
      terms: { title: termSet(e.title), description: termSet(e.description), url: termSet(new URL(e.url).pathname) },
    }))

const loadIndex = async (): Promise<DocEntry[]> => {
  const base = getDocsBaseUrl()
  if (index && index.base === base && Date.now() - index.fetchedAt < CACHE_TTL_MS) {
    return index.entries
  }
  const entries = parseLlmsTxt(await fetchText(new URL('/llms.txt', base).toString()), new URL(base).origin)
  index = { entries, fetchedAt: Date.now(), base }
  return entries
}

const loadPage = async (url: string): Promise<string> => {
  const cached = pages.get(url)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.text
  }
  const text = await fetchText(url)
  if (pages.size >= MAX_PAGES_CACHED) {
    const oldest = pages.keys().next().value
    if (oldest !== undefined) {
      pages.delete(oldest)
    }
  }
  pages.set(url, { text, fetchedAt: Date.now() })
  return text
}

const countHits = (text: string, terms: string[]) => {
  const words = tokenize(text)
  return terms.reduce((sum, term) => sum + words.filter((w) => w === term || w.startsWith(term)).length, 0)
}

export const bestExcerpt = (markdown: string, terms: string[]): string => {
  const sections = markdown.split(/\n(?=#{1,6}\s)/)
  const best = sections
    .map((section, i) => ({ section, i, score: countHits(section, terms) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)[0]
  const text = (best?.section ?? markdown).trim()
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text
}

export const rankDocs = (entries: DocEntry[], query: string, limit: number): DocEntry[] => {
  const terms = [...new Set(tokenize(query))]
  return entries
    .map((entry) => ({
      entry,
      score: terms.reduce(
        (sum, t) =>
          sum +
          (entry.terms.title.has(t) ? 3 : 0) +
          (entry.terms.description.has(t) ? 2 : 0) +
          (entry.terms.url.has(t) ? 1 : 0),
        0,
      ),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.entry)
}

export const searchDocs = readTool({
  name: 'search_sevalla_docs',
  title: 'Search Sevalla documentation',
  description:
    'Searches the Sevalla documentation (docs.sevalla.com): features, settings, limits, builds, frameworks and migration guides. Returns the best-matching pages with their most relevant section. It reads public docs, not the account.',
  input: z
    .object({
      query: z.string().min(2).max(200).describe('What to look up, e.g. "nixpacks node version".'),
      limit: z.number().int().min(1).max(5).default(3).describe('Maximum pages returned.'),
    })
    .strict(),
  run: async ({ query, limit }) => {
    let entries: DocEntry[]
    try {
      entries = await loadIndex()
    } catch (err) {
      return toolError(
        `The Sevalla documentation index could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const matches = rankDocs(entries, query, limit)
    if (matches.length === 0) {
      return toolResult({ results: [], note: 'No documentation page matched. Different or fewer keywords may match.' })
    }
    const terms = [...new Set(tokenize(query))]
    const results = await Promise.all(
      matches.map(async (entry) => {
        const page = entry.url.replace(/\.md$/, '')
        try {
          return { title: entry.title, url: page, excerpt: bestExcerpt(await loadPage(entry.url), terms) }
        } catch {
          return { title: entry.title, url: page, excerpt: entry.description }
        }
      }),
    )
    return toolResult({ results })
  },
})

export const __resetDocsCache = () => {
  index = undefined
  pages.clear()
}
