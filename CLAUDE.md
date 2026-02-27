# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Remote MCP server for the Sevalla PaaS API (mcp.sevalla.com). Uses the [codemode](https://github.com/cnap-tech/codemode) library to expose 200 API endpoints through 2 tools (`search` + `execute`) instead of one tool per endpoint. AI agents write JavaScript code that runs in sandboxed V8 isolates to discover and call the Sevalla API.

## Commands

```bash
pnpm dev              # Development with --watch (native Node.js)
pnpm start            # Run server (node src/index.ts)
pnpm test             # Run tests (node:test)
pnpm lint             # oxlint
pnpm fmt              # oxfmt (auto-fix)
pnpm fmt:check        # oxfmt (check only)
pnpm check:code       # Full check: tsc + oxlint + oxfmt
```

## Node.js Version

**Node.js 24+ is required.** TypeScript runs natively via Node's built-in type stripping (no build step). The `isolated-vm` native addon segfaults on Node 25. Use `nvm use` or respect the `.nvmrc`.

## Architecture

Single-file server (`src/index.ts`) with this request flow:

1. MCP client sends POST to `/` with `Authorization: Bearer <sevalla-api-key>`
2. Hono extracts the Bearer token
3. **Per-request isolation**: A fresh `McpServer` + `CodeMode` + `StreamableHTTPTransport` is created for each request, binding the user's API key to the fetch handler. This ensures auth isolation between concurrent users.
4. CodeMode registers 2 tools: `search` (query the OpenAPI spec) and `execute` (call the API via `sevalla.request(...)`)
5. The sandboxed JS code runs in a V8 isolate (isolated-vm). For `execute`, the request bridge calls `createAuthenticatedFetch(token)` which prepends `/v3` to paths and injects the Bearer token.

**Key design detail — URL rewriting:** CodeMode's bridge does `new URL(path, baseUrl)`. With `baseUrl = "https://api.sevalla.com"` and `path = "/applications"`, this resolves to `https://api.sevalla.com/applications`. The `createAuthenticatedFetch` wrapper prepends `/v3` to make the correct URL: `https://api.sevalla.com/v3/applications`.

**Stateless MCP:** `enableJsonResponse: true` and `sessionIdGenerator: undefined`. Each HTTP POST is independent — no session tracking.

The OpenAPI spec is fetched once on startup from `api.sevalla.com/v3/openapi.json` and cached via a promise (prevents duplicate fetches on concurrent first requests).

## Code Style

- oxfmt: 120 char width, single quotes, no semicolons
- oxlint: unicorn + typescript plugins, unused-imports JS plugin
- ESM only (`"type": "module"`)
- Always use arrow functions, never `function` declarations
- No comments in code
