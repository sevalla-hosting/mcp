const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const EXTRACTED_FIELDS = ['summary', 'description', 'tags', 'parameters', 'requestBody', 'responses'] as const
const DEFAULT_MAX_REF_DEPTH = 50

export const resolveRefs = (
  obj: any,
  root: any,
  seen = new Set<string>(),
  maxDepth = DEFAULT_MAX_REF_DEPTH,
  _cache = new Map<string, any>(),
): any => {
  if (obj === null || typeof obj !== 'object') {
    return obj
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveRefs(item, root, seen, maxDepth, _cache))
  }

  if (typeof obj.$ref === 'string') {
    const ref = obj.$ref as string
    if (maxDepth <= 0) {
      return { $circular: ref, $reason: 'max depth exceeded' }
    }
    if (seen.has(ref)) {
      return { $circular: ref }
    }
    if (_cache.has(ref)) {
      return _cache.get(ref)
    }

    const parts = ref.replace(/^#\//, '').split('/')
    if (parts.some((p: string) => DANGEROUS_KEYS.has(p))) {
      return { $ref: ref, $error: 'unsafe ref path' }
    }

    let resolved: any = root
    for (const part of parts) {
      resolved = resolved?.[part]
      if (resolved === undefined) {
        return obj
      }
    }

    const nextSeen = new Set(seen)
    nextSeen.add(ref)
    const result = resolveRefs(resolved, root, nextSeen, maxDepth - 1, _cache)
    _cache.set(ref, result)
    return result
  }

  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue
    }
    out[key] = resolveRefs(value, root, seen, maxDepth, _cache)
  }
  return out
}

const extractServerBasePath = (spec: any): string => {
  const serverUrl = spec.servers?.[0]?.url
  if (!serverUrl) {
    return ''
  }
  try {
    return new URL(serverUrl).pathname.replace(/\/+$/, '')
  } catch {
    const match = serverUrl.match(/^https?:\/\/[^/]+(\/.*?)?\/?$/)
    return match?.[1]?.replace(/\/+$/, '') ?? ''
  }
}

export const processSpec = (spec: any, maxRefDepth = DEFAULT_MAX_REF_DEPTH): { paths: Record<string, any> } => {
  const basePath = extractServerBasePath(spec)
  const paths: Record<string, any> = {}

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    const fullPath = basePath + path
    const pathItem: Record<string, any> = {}

    for (const method of HTTP_METHODS) {
      const op = (methods as any)[method]
      if (!op) {
        continue
      }

      const extracted: Record<string, any> = {}
      for (const field of EXTRACTED_FIELDS) {
        if (op[field] !== undefined) {
          extracted[field] = resolveRefs(op[field], spec, new Set(), maxRefDepth)
        }
      }
      pathItem[method] = extracted
    }

    if (Object.keys(pathItem).length > 0) {
      paths[fullPath] = pathItem
    }
  }

  return { paths }
}

export const extractTags = (spec: { paths: Record<string, any> }): string[] => {
  const counts = new Map<string, number>()
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = (methods as any)?.[method]
      if (!op?.tags) {
        continue
      }
      for (const tag of op.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag)
}
