import ivm from 'isolated-vm'

export interface SandboxOptions {
  memoryMB?: number
  timeoutMs?: number
  wallTimeMs?: number
}

export interface ExecuteResult {
  result: any
  error?: string
}

const isNamespaceWithMethods = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).some((v) => typeof v === 'function')

const wrapHostFunction = (fn: (..._args: any[]) => any) => {
  return async (...args: any[]) => {
    try {
      return { ok: true, value: await fn(...args) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

const HOST_CALL_UNWRAP =
  `.then((res) => {` +
  ` if (res && res.ok) { return res.value }` +
  ` throw new Error(res && res.error ? String(res.error) : 'Host function failed');` +
  ` })`

export const executeInSandbox = async (
  code: string,
  globals: Record<string, any>,
  options: SandboxOptions = {},
): Promise<ExecuteResult> => {
  const memoryMB = options.memoryMB ?? 64
  const timeoutMs = options.timeoutMs ?? 30_000
  const wallTimeMs = options.wallTimeMs ?? 60_000

  const isolate = new ivm.Isolate({ memoryLimit: memoryMB })
  let context: ivm.Context | undefined

  try {
    context = await isolate.createContext()
    const jail = context.global
    await jail.set('global', jail.derefInto())

    await context.eval(`globalThis.console = { log: () => {}, warn: () => {}, error: () => {} };`)

    let refCounter = 0
    for (const [name, value] of Object.entries(globals)) {
      if (typeof value === 'function') {
        const refName = `__ref${refCounter++}`
        await jail.set(refName, new ivm.Reference(wrapHostFunction(value)))
        await context.eval(
          `globalThis[${JSON.stringify(name)}] = function(...args) {` +
            `return ${refName}.apply(undefined, args, { arguments: { copy: true }, result: { promise: true, copy: true } })${HOST_CALL_UNWRAP};` +
            `};`,
        )
      } else if (isNamespaceWithMethods(value)) {
        const methodSetup: string[] = []
        methodSetup.push(`globalThis[${JSON.stringify(name)}] = {};`)

        for (const [key, val] of Object.entries(value)) {
          if (typeof val === 'function') {
            const refName = `__ref${refCounter++}`
            await jail.set(refName, new ivm.Reference(wrapHostFunction(val as (..._args: any[]) => any)))
            methodSetup.push(
              `globalThis[${JSON.stringify(name)}][${JSON.stringify(key)}] = function(...args) {` +
                `return ${refName}.apply(undefined, args, { arguments: { copy: true }, result: { promise: true, copy: true } })${HOST_CALL_UNWRAP};` +
                `};`,
            )
          }
        }

        await context.eval(methodSetup.join('\n'))

        const dataProps: Record<string, any> = {}
        for (const [key, val] of Object.entries(value)) {
          if (typeof val !== 'function') {
            dataProps[key] = val
          }
        }
        if (Object.keys(dataProps).length > 0) {
          await context.eval(`Object.assign(globalThis[${JSON.stringify(name)}], ${JSON.stringify(dataProps)});`)
        }
      } else {
        await context.eval(`globalThis[${JSON.stringify(name)}] = ${JSON.stringify(value)};`)
      }
    }

    const wrappedCode = `(${code})()`
    const script = await isolate.compileScript(wrappedCode)

    let wallTimer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      script.run(context, { timeout: timeoutMs, promise: true, copy: true }).finally(() => clearTimeout(wallTimer)),
      new Promise<never>((_, reject) => {
        wallTimer = setTimeout(() => reject(new Error('Wall-clock timeout exceeded')), wallTimeMs)
        if (typeof wallTimer === 'object' && 'unref' in wallTimer) {
          wallTimer.unref()
        }
      }),
    ])

    return { result }
  } catch (err) {
    return { result: undefined, error: err instanceof Error ? err.message : String(err) }
  } finally {
    context?.release()
    if (!isolate.isDisposed) {
      isolate.dispose()
    }
  }
}
