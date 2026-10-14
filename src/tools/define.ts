import type { z } from 'zod'
import { readOnly, withSignal, type ReadOnlyClient, type SevallaClient } from '../sevalla/client.ts'

export type ToolKind = 'read' | 'create' | 'update' | 'delete'

export interface ToolHints {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export const PRESETS: Record<ToolKind, ToolHints> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  update: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
}

export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolResult {
  content: TextContent[]
  isError?: boolean
  [key: string]: unknown
}

export interface ServerContext {
  client: SevallaClient
  signal?: AbortSignal
}

export interface ReadContext {
  api: ReadOnlyClient
  signal?: AbortSignal
}

export interface WriteContext {
  api: SevallaClient
  signal?: AbortSignal
}

export interface Tool {
  name: string
  title: string
  kind: ToolKind
  description: string
  input: z.ZodObject
  idempotent?: boolean
  openWorld?: boolean
  execute: (_args: Record<string, unknown>, _ctx: ServerContext) => Promise<ToolResult>
}

interface ToolSpec<T extends z.ZodObject, C> {
  name: string
  title: string
  description: string
  input: T
  idempotent?: boolean
  openWorld?: boolean
  run: (_args: z.infer<T>, _ctx: C) => Promise<ToolResult>
}

export const readTool = <T extends z.ZodObject>(spec: ToolSpec<T, ReadContext>): Tool => ({
  name: spec.name,
  title: spec.title,
  kind: 'read',
  description: spec.description,
  input: spec.input,
  idempotent: spec.idempotent,
  openWorld: spec.openWorld,
  execute: (args, ctx) =>
    spec.run(args as z.infer<T>, { api: readOnly(withSignal(ctx.client, ctx.signal)), signal: ctx.signal }),
})

export const writeTool = <T extends z.ZodObject>(
  kind: Exclude<ToolKind, 'read'>,
  spec: ToolSpec<T, WriteContext>,
): Tool => ({
  name: spec.name,
  title: spec.title,
  kind,
  description: spec.description,
  input: spec.input,
  idempotent: spec.idempotent,
  openWorld: spec.openWorld,
  execute: (args, ctx) => spec.run(args as z.infer<T>, { api: withSignal(ctx.client, ctx.signal), signal: ctx.signal }),
})

export const annotationsFor = (tool: Tool) => ({
  title: tool.title,
  ...PRESETS[tool.kind],
  ...(tool.idempotent === undefined ? {} : { idempotentHint: tool.idempotent }),
  ...(tool.openWorld === undefined ? {} : { openWorldHint: tool.openWorld }),
})

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}
