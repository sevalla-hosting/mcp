import { Resolver } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

export interface ClientMetadata {
  clientId: string
  clientName: string
  redirectUris: string[]
}

export interface FetchedDocument {
  body: string
  ttlMs: number
}

export interface FetchTransport {
  request: typeof httpsRequest
  lookup: LookupFunction
}

export class ClientMetadataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientMetadataError'
  }
}

export class ClientMetadataUnavailableError extends Error {
  status: 429 | 503

  constructor(status: 429 | 503, message: string) {
    super(message)
    this.name = 'ClientMetadataUnavailableError'
    this.status = status
  }
}

const MAX_DOCUMENT_BYTES = 5_120
const FETCH_TIMEOUT_MS = 3_000
const RESOLVE_TIMEOUT_MS = 1_500
const DEFAULT_TTL_MS = 300_000
const MAX_TTL_MS = 86_400_000
const FAILURE_TTL_MS = 60_000
const CACHE_MAX_ENTRIES = 1_000
const MAX_CONCURRENT_FETCHES = 8
const FETCHES_PER_REQUESTER = 30
const ACTIVE_FETCHES_PER_REQUESTER = 2
const REQUESTER_WINDOW_MS = 60_000
const REQUESTERS_MAX = 10_000
const UNREACHABLE = 'could not be fetched'
const SHARED_SECRET_AUTH_METHODS = new Set(['client_secret_basic', 'client_secret_post', 'client_secret_jwt'])

const BLOCKED_RANGES: [string, number, 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.88.99.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 96, 'ipv6'],
  ['::ffff:0:0:0', 96, 'ipv6'],
  ['64:ff9b::', 32, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001::', 32, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['fec0::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
]

const blockList = new BlockList()
for (const [network, prefix, type] of BLOCKED_RANGES) {
  blockList.addSubnet(network, prefix, type)
}

const nat64 = new BlockList()
nat64.addSubnet('64:ff9b::', 96, 'ipv6')

const ipv6Groups = (address: string): number[] => {
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const [left, right] = canonical.split('::')
  const head = left ? left.split(':') : []
  const tail = right ? right.split(':') : []
  const zeros = right === undefined ? [] : Array.from({ length: 8 - head.length - tail.length }, () => '0')
  return [...head, ...zeros, ...tail].map((group) => parseInt(group, 16))
}

const nat64EmbeddedIpv4 = (address: string): string | undefined => {
  if (!nat64.check(address, 'ipv6')) {
    return undefined
  }
  const groups = ipv6Groups(address)
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
}

export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address)
  if (family === 0 || address.includes('%')) {
    return false
  }
  if (family === 6) {
    const embedded = nat64EmbeddedIpv4(address)
    if (embedded !== undefined) {
      return isPublicAddress(embedded)
    }
  }
  return !blockList.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

export const isClientMetadataUrl = (clientId: string): boolean => clientId.startsWith('https://')

export const validateClientIdUrl = (clientId: string): URL => {
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    throw new ClientMetadataError('client_id is not a valid URL')
  }
  if (url.protocol !== 'https:') {
    throw new ClientMetadataError('client_id must use the https scheme')
  }
  if (url.username || url.password) {
    throw new ClientMetadataError('client_id must not contain credentials')
  }
  if (clientId.includes('#')) {
    throw new ClientMetadataError('client_id must not contain a fragment')
  }
  if (url.port !== '') {
    throw new ClientMetadataError('client_id must not specify a port')
  }
  if (url.pathname === '/') {
    throw new ClientMetadataError('client_id must contain a path')
  }
  if (url.href !== clientId) {
    throw new ClientMetadataError('client_id must be a normalized URL without dot segments')
  }
  const host = url.hostname
  if (host.startsWith('[') || isIP(host) !== 0 || !host.includes('.') || host.endsWith('.')) {
    throw new ClientMetadataError('client_id must use a fully qualified DNS host name')
  }
  return url
}

export interface ResolvedAddress {
  address: string
  family: number
}

export const assertPublicAddresses = (hostname: string, addresses: ResolvedAddress[]): ResolvedAddress[] => {
  if (addresses.length === 0) {
    throw Object.assign(new Error(`${hostname} did not resolve`), { code: 'ENOTFOUND' })
  }
  if (!addresses.every((a) => isPublicAddress(a.address))) {
    throw Object.assign(new Error(`${hostname} does not resolve to a public address`), { code: 'EACCES' })
  }
  return addresses
}

const resolvePublicAddresses = async (hostname: string): Promise<ResolvedAddress[]> => {
  const resolver = new Resolver({ timeout: RESOLVE_TIMEOUT_MS, tries: 1 })
  const fqdn = `${hostname}.`
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(fqdn), resolver.resolve6(fqdn)])
  return assertPublicAddresses(hostname, [
    ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
    ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
  ])
}

export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  resolvePublicAddresses(hostname).then(
    (addresses) => {
      const candidates = addresses.filter((a) => !options.family || a.family === options.family)
      if (candidates.length === 0) {
        callback(
          Object.assign(new Error(`${hostname} has no address of the requested family`), { code: 'ENOTFOUND' }),
          '',
        )
        return
      }
      if (options.all) {
        callback(null, candidates)
        return
      }
      callback(null, candidates[0].address, candidates[0].family)
    },
    (err: NodeJS.ErrnoException) => callback(err, ''),
  )
}

export const cacheTtl = (cacheControl: string | undefined): number => {
  if (!cacheControl) {
    return DEFAULT_TTL_MS
  }
  const directives = cacheControl
    .toLowerCase()
    .split(',')
    .map((d) => d.trim())
  if (directives.some((d) => d === 'no-store' || d === 'no-cache')) {
    return 0
  }
  const maxAge = directives.find((d) => d.startsWith('max-age='))
  if (!maxAge) {
    return DEFAULT_TTL_MS
  }
  const seconds = Number(maxAge.slice('max-age='.length))
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_TTL_MS) : 0
}

const isJsonMediaType = (contentType: string | undefined): boolean => {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'))
}

const HTTPS_TRANSPORT: FetchTransport = { request: httpsRequest, lookup: publicOnlyLookup }

export const fetchClientMetadataDocument = (
  url: URL,
  transport: FetchTransport = HTTPS_TRANSPORT,
): Promise<FetchedDocument> =>
  new Promise((resolve, reject) => {
    const fail = (message: string, detail?: string) => {
      if (detail) {
        console.warn(`Client metadata document ${url.href} ${message}: ${detail}`)
      }
      reject(new ClientMetadataError(message))
    }
    const req = transport.request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'Sevalla-MCP' },
        lookup: transport.lookup,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          fail(UNREACHABLE, `HTTP ${res.statusCode}`)
          return
        }
        if (!isJsonMediaType(res.headers['content-type'])) {
          res.resume()
          fail('is not served as application/json')
          return
        }
        if (Number(res.headers['content-length']) > MAX_DOCUMENT_BYTES) {
          res.destroy()
          fail('is larger than 5 KB')
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_DOCUMENT_BYTES) {
            res.destroy()
            fail('is larger than 5 KB')
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () =>
          resolve({ body: Buffer.concat(chunks).toString('utf8'), ttlMs: cacheTtl(res.headers['cache-control']) }),
        )
        res.on('error', (err) => fail(UNREACHABLE, err.message))
      },
    )
    req.on('error', (err) => fail(UNREACHABLE, err.message))
    req.end()
  })

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

export const parseClientMetadata = (clientId: string, body: string): ClientMetadata => {
  let doc: unknown
  try {
    doc = JSON.parse(body)
  } catch {
    throw new ClientMetadataError('is not valid JSON')
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ClientMetadataError('is not a JSON object')
  }
  const fields = doc as Record<string, unknown>
  if (fields.client_id !== clientId) {
    throw new ClientMetadataError('has a client_id that does not match its URL')
  }
  if (typeof fields.client_name !== 'string' || fields.client_name.trim() === '') {
    throw new ClientMetadataError('has no client_name')
  }
  if (!isStringArray(fields.redirect_uris) || fields.redirect_uris.length === 0) {
    throw new ClientMetadataError('has no redirect_uris')
  }
  if (fields.client_secret !== undefined || fields.client_secret_expires_at !== undefined) {
    throw new ClientMetadataError('contains a client secret')
  }
  if (
    typeof fields.token_endpoint_auth_method === 'string' &&
    SHARED_SECRET_AUTH_METHODS.has(fields.token_endpoint_auth_method)
  ) {
    throw new ClientMetadataError('uses a shared-secret token endpoint authentication method')
  }
  if (
    fields.grant_types !== undefined &&
    !(isStringArray(fields.grant_types) && fields.grant_types.includes('authorization_code'))
  ) {
    throw new ClientMetadataError('does not allow the authorization_code grant')
  }
  if (
    fields.response_types !== undefined &&
    !(isStringArray(fields.response_types) && fields.response_types.includes('code'))
  ) {
    throw new ClientMetadataError('does not allow the code response type')
  }
  return { clientId, clientName: fields.client_name, redirectUris: fields.redirect_uris }
}

type CacheEntry = { expiresAt: number } & (
  | { ok: true; metadata: ClientMetadata }
  | { ok: false; error: ClientMetadataError }
)

let fetchDocument: (_url: URL) => Promise<FetchedDocument> = (url) => fetchClientMetadataDocument(url)

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<ClientMetadata>>()
const requesters = new Map<string, { count: number; windowStart: number }>()
const activeByRequester = new Map<string, number>()
let activeFetches = 0

export const requesterKey = (requester: string): string => {
  const address = requester.split('%')[0]
  if (isIP(address) !== 6) {
    return address
  }
  const groups = ipv6Groups(address)
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`
}

const evictOldest = <K, V>(map: Map<K, V>, max: number) => {
  if (map.size >= max) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) {
      map.delete(oldest)
    }
  }
}

const remember = (clientId: string, entry: CacheEntry) => {
  cache.delete(clientId)
  evictOldest(cache, CACHE_MAX_ENTRIES)
  cache.set(clientId, entry)
}

const consumeFetchAllowance = (requester: string) => {
  const now = Date.now()
  const current = requesters.get(requester)
  if (!current || now - current.windowStart >= REQUESTER_WINDOW_MS) {
    requesters.delete(requester)
    evictOldest(requesters, REQUESTERS_MAX)
    requesters.set(requester, { count: 1, windowStart: now })
    return
  }
  if (current.count >= FETCHES_PER_REQUESTER) {
    throw new ClientMetadataUnavailableError(
      429,
      'Too many client metadata documents were requested from this address. Try again in a minute.',
    )
  }
  current.count += 1
}

const load = async (clientId: string, url: URL, requester: string): Promise<ClientMetadata> => {
  if (activeFetches >= MAX_CONCURRENT_FETCHES) {
    throw new ClientMetadataUnavailableError(
      503,
      'Client metadata documents cannot be fetched right now. Try again shortly.',
    )
  }
  activeFetches += 1
  activeByRequester.set(requester, (activeByRequester.get(requester) ?? 0) + 1)
  try {
    const { body, ttlMs } = await fetchDocument(url)
    const metadata = parseClientMetadata(clientId, body)
    if (ttlMs > 0) {
      remember(clientId, { ok: true, metadata, expiresAt: Date.now() + ttlMs })
    }
    return metadata
  } catch (err) {
    if (err instanceof ClientMetadataError) {
      remember(clientId, { ok: false, error: err, expiresAt: Date.now() + FAILURE_TTL_MS })
    }
    throw err
  } finally {
    activeFetches -= 1
    const remaining = (activeByRequester.get(requester) ?? 1) - 1
    if (remaining > 0) {
      activeByRequester.set(requester, remaining)
    } else {
      activeByRequester.delete(requester)
    }
  }
}

export const resolveClientMetadata = async (clientId: string, requester = 'unknown'): Promise<ClientMetadata> => {
  const url = validateClientIdUrl(clientId)
  const cached = cache.get(clientId)
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.ok) {
      throw cached.error
    }
    return cached.metadata
  }
  const pending = inFlight.get(clientId)
  if (pending) {
    return pending
  }
  const key = requesterKey(requester)
  if ((activeByRequester.get(key) ?? 0) >= ACTIVE_FETCHES_PER_REQUESTER) {
    throw new ClientMetadataUnavailableError(
      429,
      'Too many client metadata documents are being fetched for this address. Try again shortly.',
    )
  }
  consumeFetchAllowance(key)
  const promise = load(clientId, url, key).finally(() => inFlight.delete(clientId))
  inFlight.set(clientId, promise)
  return promise
}

export const __setClientMetadataFetcher = (fetcher?: (_url: URL) => Promise<FetchedDocument>) => {
  fetchDocument = fetcher ?? ((url) => fetchClientMetadataDocument(url))
  cache.clear()
  inFlight.clear()
  requesters.clear()
  activeByRequester.clear()
  activeFetches = 0
}
