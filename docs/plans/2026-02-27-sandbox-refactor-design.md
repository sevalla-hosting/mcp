# Sandbox Module Refactoring Design

## Problem

`src/sandbox.ts` is a 631-line monolith containing 5 distinct concerns: OpenAPI spec processing, HTTP request bridging, V8 isolate execution, tool definition generation, and tool orchestration. Splitting into focused modules improves readability, testability, and maintainability.

## Target Structure

```
src/sandbox/
  index.ts     — barrel re-exports public API
  spec.ts      — OpenAPI spec processing (resolveRefs, processSpec, extractTags)
  bridge.ts    — HTTP request proxy with validation and security filtering
  isolate.ts   — V8 sandbox execution via isolated-vm
  tools.ts     — tool definitions, orchestration, response formatting
```

## Module Responsibilities

### spec.ts
- `resolveRefs` — recursive `$ref` resolution with cycle detection and caching
- `processSpec` — extract operations from OpenAPI spec, prepend server base path
- `extractTags` — collect and rank tags by frequency
- Helper: `extractServerBasePath`
- Constants: `DANGEROUS_KEYS`, `HTTP_METHODS`, `EXTRACTED_FIELDS`, `DEFAULT_MAX_REF_DEPTH`

### bridge.ts
- `createRequestBridge` — factory returning a request executor with rate limiting
- Helpers: `validatePath`, `filterHeaders`, `readResponseWithLimit`
- Constants: `ALLOWED_METHODS`, `BLOCKED_HEADER_PATTERNS`, `DEFAULT_MAX_REQUESTS`, `DEFAULT_MAX_RESPONSE_BYTES`
- Types: `RequestHandler`, `BridgeOptions`, `BridgeRequest`, `BridgeResponse`

### isolate.ts
- `executeInSandbox` — run user code in a V8 isolate with injected globals
- Helper: `isNamespaceWithMethods`
- Types: `SandboxOptions`, `ExecuteResult`

### tools.ts
- `createTools` — compose spec processing, bridge, and isolate into MCP tool definitions
- `createSearchDefinition` — build the `search` tool schema and description
- `createExecuteDefinition` — build the `execute` tool schema and description
- Helpers: `formatResult`, `truncateResponse`
- Constants: `CHARS_PER_TOKEN`, `DEFAULT_MAX_TOKENS`, `SPEC_TYPES`
- Types: `ToolDefinition`, `CreateToolsOptions`

### index.ts (barrel)
Re-exports all public symbols needed by consumers:
- From spec: `resolveRefs`, `processSpec`, `extractTags`
- From bridge: `createRequestBridge`
- From isolate: `executeInSandbox`
- From tools: `createTools`
- All public types

## Import Graph

```
spec.ts  <──  tools.ts  ──>  bridge.ts
                 │
                 └──>  isolate.ts
```

No circular dependencies. `spec.ts`, `bridge.ts`, and `isolate.ts` are leaf modules with no internal imports.

## Consumer Changes

- `src/index.ts`: `import { createTools } from './sandbox.ts'` → `import { createTools } from './sandbox/index.ts'`
- `test/sandbox.test.ts`: `import { ... } from '../src/sandbox.ts'` → `import { ... } from '../src/sandbox/index.ts'`

## Constraints

- No behavioral changes — pure structural refactor
- All existing tests must pass without modification (only import paths change)
- Follow existing code style: arrow functions, no comments, no semicolons, single quotes
- Types stay co-located with their module (no separate types file)
- Constants stay local to their module
