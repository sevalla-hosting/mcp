# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Overview

Remote MCP server for the Sevalla PaaS API (mcp.sevalla.com). Exposes 27 tools: 22 purpose-built
workflow tools and 5 generic tools that run any other v3 operation by operation ID, split into
read, create, update and delete. Built with Hono and MCP SDK v2 (`@modelcontextprotocol/server`); it
serves the 2026-07-28 protocol and 2025-era clients from the same tools. No build step — TypeScript
runs natively on Node.js 26 (24 also works).

## Commands

```bash
pnpm dev              # Development with --watch (native Node.js)
pnpm start            # Run server (node src/index.ts)
pnpm test             # Run unit and e2e tests (node:test), e2e in both protocol eras
pnpm test:e2e         # End-to-end tests in both eras (real HTTP server, MCP SDK client, fake Sevalla API)
pnpm test:live        # Live checks: client metadata documents; API smoke test with SEVALLA_E2E_API_KEY
pnpm sync:operations  # Regenerate src/sevalla/operations.json from the live API spec
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

**Node.js 26** (`.nvmrc`, Volta, Docker); Node.js 24 is supported and tested in CI. TypeScript runs via
Node's built-in type stripping — there is no build/compile step, so only erasable syntax works (no enums,
namespaces or parameter properties). pnpm 12 (`packageManager`); its settings go in `pnpm-workspace.yaml`
when needed (there is none today), and it refuses packages published less than a day ago.

## Architecture

```
src/
├── index.ts              # Hono app: /mcp, token validation, era routing, per-request MCP server, icons
├── oauth.ts              # Stateless OAuth (CIMD, DCR, PKCE, device-code approval, per-path metadata)
├── client-metadata.ts    # Client ID Metadata Documents: URL rules, SSRF-guarded fetch, validation, cache
├── assets/               # Sevalla icon served at /icon.png and /icon.svg
├── index.html            # Landing page
├── sevalla/
│   ├── client.ts         # Sevalla API client (/v3 pinning, errors, timeouts, size limit)
│   ├── operations.json   # Generated snapshot of the v3 OpenAPI spec (pnpm sync:operations)
│   └── operations.ts     # Reviewed operation table: classes, dedicated tools, env var value fields
└── tools/
    ├── define.ts         # readTool / writeTool and annotation presets
    ├── format.ts         # Result formatting, truncation, redaction, logs, metrics
    ├── schemas.ts        # Shared zod schemas
    ├── services.ts       # list_services, get_application, get_static_site, get_database, get_platform_options
    ├── deployments.ts    # list/get deployments, logs, trigger and rollback
    ├── observability.ts  # runtime and access logs, metrics
    ├── configuration.ts  # environment variables, scaling, domains
    ├── create.ts         # create_application, create_static_site, create_database
    ├── docs.ts           # search_sevalla_docs
    ├── api.ts            # sevalla_api_search/read/create/update/delete
    └── index.ts          # Tool registry and server instructions
```

Each HTTP POST to `/mcp` creates a fresh `McpServer` + transport bound to the caller's API key.
Fully stateless — no sessions, no server-side storage.

Read tools are built with `readTool` and only receive a GET-only client. The generic tools take
the HTTP method and path from `operations.json`, never from the model. `test/policy.test.ts`
enforces Anthropic's directory rules on the live tool list (titles, explicit hints, read/write
separation, descriptions that describe rather than instruct, a size budget).

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
import { createSevallaClient } from './sevalla/client.ts'
import type { Operation } from './sevalla/operations.ts'
```

### Types and Interfaces

- TypeScript strict mode (`"strict": true`)
- Use `interface` for object shapes, `type` for unions/aliases
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
- Unit tests: `test/*.test.ts`; end-to-end tests: `test/e2e/*.test.ts`; live smoke: `test/live/*.live.ts`
- `test/support/fake-api.ts` serves every v3 operation over HTTP from the spec snapshot and records requests
- `test/support/harness.ts` runs the real server on a port and connects the official MCP SDK client;
  `MCP_TEST_ERA=legacy` makes it connect as a 2025-era client instead of a 2026-07-28 one
- Use Hono's `app.request()` for HTTP handler tests
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

- Read tools never get a client that can send anything but GET
- Generic tools: method and path from the operation table, path parameters validated and URL-encoded,
  unknown query parameters rejected, one tool per operation class
- Environment variable values are the only redacted field; commands run in a process (`execProcessCommandV3`)
  and logs can still show secrets
- API client: requests pinned to `SEVALLA_API_URL` + `/v3`, redirects refused, 5 MB response limit, 30 s timeout
- Client metadata documents: canonical https URLs on DNS names only (no IP literals or ports), c-ares
  lookups where every resolved address must be public (NAT64 judged by the embedded IPv4), no redirects,
  5 KB and 3 s limits, generic errors, failure caching, shared in-flight fetches, 8 concurrent fetches,
  and per client IP (IPv6 per /64) 2 in flight and 30 uncached fetches a minute
- Additive (`create`) operations never move data or credentials off the platform or open new exposure;
  `test/operations.test.ts` pins the list
- OAuth: 16 KB body limit on `/oauth/*`; codes, access tokens and registrations use separate derived keys
- Tool results capped at 30,000 characters

## Environment Variables

| Variable                           | Required  | Description                                                                       |
| ---------------------------------- | --------- | --------------------------------------------------------------------------------- |
| `PORT`                             | No        | Server port (default: 3000)                                                       |
| `OAUTH_SECRET`                     | Prod only | Base64url-encoded 32-byte key for signing/encryption                              |
| `PUBLIC_URL`                       | No        | Public-facing URL (default: https://mcp.sevalla.com)                              |
| `SEVALLA_FRONTEND_URL`             | No        | Sevalla frontend URL (default: https://app.sevalla.com)                           |
| `NODE_ENV`                         | No        | Set to `production` to require OAUTH_SECRET                                       |
| `SHUTDOWN_TIMEOUT_MS`              | No        | Graceful shutdown timeout (default: 30000)                                        |
| `OPENAI_APPS_CHALLENGE`            | No        | OpenAI domain verification token for `/.well-known/openai-apps-challenge`         |
| `SEVALLA_API_URL`                  | No        | Sevalla API base URL (default: https://api.sevalla.com)                           |
| `SEVALLA_DOCS_URL`                 | No        | Docs site for search (default: https://docs.sevalla.com)                          |
| `DEVICE_CODE_TRUSTED_CLIENT_TOKEN` | No        | Trusted-client token for device-code endpoints                                    |
| `CLIENT_IP_HEADER`                 | No        | Header with the end-user IP set by the edge (default: x-forwarded-for)            |
| `TRUSTED_PROXY_HOPS`               | No        | Trusted proxies appending to x-forwarded-for; IP read from the right (default: 1) |
