# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Overview

Remote MCP server for the Sevalla PaaS API (mcp.sevalla.com). Exposes ~200 API endpoints
through 2 tools (`search` + `execute`) using sandboxed V8 isolates. Built with Hono,
MCP SDK, and isolated-vm. No build step — TypeScript runs natively on Node.js 24+.

## Commands

```bash
pnpm dev              # Development with --watch (native Node.js)
pnpm start            # Run server (node src/index.ts)
pnpm test             # Run all tests (node:test)
pnpm lint             # oxlint
pnpm fmt              # oxfmt (auto-fix)
pnpm fmt:check        # oxfmt (check only)
pnpm check:code       # Full check: tsc --noEmit --skipLibCheck && oxlint && oxfmt --check
```

### Running a Single Test

```bash
node --test test/oauth.test.ts          # Run one test file
node --test --test-name-pattern="encrypt" test/oauth.test.ts  # Run matching tests
```

The test runner is `node:test` (built-in). No Jest, Vitest, or Mocha.

### Type Checking

```bash
npx tsc --noEmit --skipLibCheck
```

## Node.js Version

**Node.js 24 required.** See `.nvmrc`. The `isolated-vm` native addon segfaults on Node 25.
TypeScript runs via Node's built-in type stripping — there is no build/compile step.

## Architecture

```
src/
├── index.ts            # Main server: Hono app, MCP handler, graceful shutdown
├── oauth.ts            # Stateless OAuth flow (HMAC-signed params, AES-256-GCM encrypted codes)
├── html.ts             # Landing page HTML template
└── sandbox/
    ├── index.ts         # Re-exports from all sandbox modules
    ├── bridge.ts        # HTTP request bridge with security filters (path validation, header filtering)
    ├── isolate.ts       # V8 isolate sandbox execution (isolated-vm)
    ├── spec.ts          # OpenAPI spec processing ($ref resolution, tag extraction)
    └── tools.ts         # MCP tool definitions (search + execute)
```

Each HTTP POST to `/mcp` creates a fresh `McpServer` + `CodeMode` + transport bound to the
caller's API key. Fully stateless — no sessions, no server-side storage.

## Code Style

### Formatting (oxfmt — `.oxfmtrc.json`)

- **120 character** line width
- **Single quotes** — never double quotes
- **No semicolons**
- Enforced by `pnpm fmt` / `pnpm fmt:check`

### Linting (oxlint — `.oxlintrc.json`)

- Plugins: `unicorn`, `typescript`, `unused-imports`
- `prefer-const` enforced — never use `let` when `const` works
- `no-var` — never use `var`
- Unused variables prefixed with `_` (e.g., `_unused`)
- No unused imports
- No empty functions
- No `@ts-ignore` without a 10+ char explanation
- No non-null assertions (`!`)
- Use `Array<T>` syntax (not `T[]`) per `@typescript-eslint/array-type`
- Use `Record<K, V>` over index signatures per `consistent-indexed-object-style`
- Prefer `for...of` over indexed loops
- Prefer function type over interface with single call signature

### Functions

- **Always use arrow functions.** Never use `function` declarations.
- Export as `export const name = (...) => { ... }`

```typescript
// Correct
export const createThing = (input: string): Thing => { ... }

// Wrong — never do this
export function createThing(input: string): Thing { ... }
```

### Comments

- **No comments in code.** Code should be self-documenting. No TODO, FIXME, or inline
  explanations. The only exception is fallback comments in catch blocks (e.g., `// fallback to raw text`).

### Imports

- **ESM only** (`"type": "module"` in package.json)
- Use `.ts` extensions in relative imports: `import { foo } from './bar.ts'`
- Use `node:` prefix for Node.js builtins: `import { randomBytes } from 'node:crypto'`
- Group imports: external packages first, then relative imports
- Use `type` imports when importing only types: `import type { Foo } from './bar.ts'`

```typescript
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createTools } from './sandbox/index.ts'
import type { BridgeRequest, RequestHandler } from './bridge.ts'
```

### Types and Interfaces

- TypeScript strict mode (`"strict": true`)
- Use `interface` for object shapes, `type` for unions/aliases
- Export types from barrel files (`sandbox/index.ts`)
- Use `Record<string, unknown>` over `object` or `any` where possible
- Zod (`zod` v4) for runtime input validation on tool schemas

### Naming Conventions

- `camelCase` for variables, functions, parameters
- `PascalCase` for types, interfaces
- `UPPER_SNAKE_CASE` for module-level constants
- Prefix unused parameters with `_`: `(_req: Request) => ...`

### Error Handling

- Use `try/catch` with `instanceof Error` checks
- Throw `new Error(message)` — never throw strings
- HTTP errors: return `c.json({ error: 'description' }, statusCode)` via Hono
- Re-throw `HTTPException` from Hono; catch everything else as 500
- Crypto/security failures: return immediately, never expose internals
- Use `timingSafeEqual` for signature comparisons

### Testing

- Framework: `node:test` (built-in `describe`, `it`, `mock`)
- Assertions: `node:assert` (`strictEqual`, `ok`, `notStrictEqual`, `throws`, `deepStrictEqual`)
- Test files: `test/*.test.ts`
- Pattern: mock `globalThis.fetch` with `mock.fn()`, restore in `finally` block
- Use Hono's `app.request()` for HTTP handler tests (no actual server needed)
- Always clean up `process.env` mutations in tests (`delete process.env.X`)

```typescript
import { describe, it, mock } from 'node:test'
import { strictEqual, ok } from 'node:assert'

describe('featureName', () => {
  it('does the expected thing', () => {
    strictEqual(actual, expected)
  })
})
```

### Security Patterns

- Path validation: reject `://`, `//`, null bytes, CR/LF, backslashes
- Header filtering: block `Authorization`, `Cookie`, `Host`, proxy headers
- Request limits: max 50 requests per sandbox execution
- Response size limits: 10MB per response
- Memory limits: 64MB per V8 isolate
- Timeouts: 30s CPU, 60s wall-clock per sandbox execution

## Environment Variables

| Variable               | Required  | Description                                             |
| ---------------------- | --------- | ------------------------------------------------------- |
| `PORT`                 | No        | Server port (default: 3000)                             |
| `OAUTH_SECRET`         | Prod only | Base64url-encoded 32-byte key for signing/encryption    |
| `PUBLIC_URL`           | No        | Public-facing URL (default: https://mcp.sevalla.com)    |
| `SEVALLA_FRONTEND_URL` | No        | Sevalla frontend URL (default: https://app.sevalla.com) |
| `NODE_ENV`             | No        | Set to `production` to require OAUTH_SECRET             |
| `SHUTDOWN_TIMEOUT_MS`  | No        | Graceful shutdown timeout (default: 30000)              |
