# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Remote MCP server for the Sevalla PaaS API (mcp.sevalla.com). Exposes 200 API endpoints through 2 tools (`search` + `execute`) instead of one tool per endpoint. AI agents write JavaScript code that runs in sandboxed V8 isolates to discover and call the Sevalla API. The sandbox tooling (originally based on the [codemode](https://github.com/cnap-tech/codemode) approach) is vendored in `src/sandbox/`.

## Commands

```bash
pnpm dev              # Development with --watch (native Node.js)
pnpm start            # Run server (node src/index.ts)
pnpm test             # Run tests (node:test)
pnpm test:coverage    # Tests with coverage (src/** only)
pnpm lint             # oxlint
pnpm fmt              # oxfmt (auto-fix)
pnpm fmt:check        # oxfmt (check only)
pnpm check:code       # Full check: tsc + oxlint + oxfmt
```

## Node.js Version

**Node.js 24+ is required.** TypeScript runs natively via Node's built-in type stripping (no build step). The `isolated-vm` native addon segfaults on Node 25. Pinned via Volta in `package.json` (24.14.0) and `.nvmrc`.

## Source Layout

- `src/index.ts` — Hono HTTP server: routing, Bearer token extraction, per-request MCP server wiring, spec cache, graceful shutdown. Also supports `--stdio` mode (token from `SEVALLA_API_KEY` env var).
- `src/api.ts` — `createAuthenticatedFetch`: URL rewriting (`/v3` prefix) + Bearer token injection.
- `src/oauth.ts` — stateless OAuth flow and `.well-known` metadata endpoints.
- `src/sandbox/` — vendored sandbox tooling:
  - `spec.ts` — OpenAPI spec processing: `$ref` resolution (circular-safe, prototype-pollution-safe), field extraction, tag ranking.
  - `bridge.ts` — request bridge for the `execute` tool: validates the request shape (single options object, method/path strings), path safety, header filtering, request-count and response-size limits.
  - `isolate.ts` — runs code in `isolated-vm` with memory/CPU/wall-clock limits and marshals host functions into the isolate.
  - `tools.ts` — builds the `search` and `execute` tool definitions and handlers.

## Architecture

Request flow:

1. MCP client sends POST to `/mcp` with `Authorization: Bearer <sevalla-api-key>`
2. Hono extracts the Bearer token
3. **Per-request isolation**: A fresh `McpServer` + tools + `StreamableHTTPTransport` is created for each request, binding the user's API key to the fetch handler. This ensures auth isolation between concurrent users.
4. Two tools are registered: `search` (query the OpenAPI spec) and `execute` (call the API via `sevalla.request({ method, path, query?, body?, headers? })` — a single options object, never positional arguments)
5. The sandboxed JS code runs in a V8 isolate (isolated-vm). For `execute`, the request bridge calls `createAuthenticatedFetch(token)` which prepends `/v3` to paths and injects the Bearer token.

**Key design detail — URL rewriting:** The bridge does `new URL(path, baseUrl)`. With `baseUrl = "https://api.sevalla.com"` and `path = "/applications"`, this resolves to `https://api.sevalla.com/applications`. The `createAuthenticatedFetch` wrapper strips any existing `/vN` prefix and prepends `/v3` to make the correct URL: `https://api.sevalla.com/v3/applications`.

**Critical invariant — no rejected promises across the isolate boundary:** Host functions exposed to the sandbox must never hand isolated-vm an already-rejected promise. A synchronous throw inside an async host function rejects before ivm attaches its handler, which fires `unhandledRejection` and (under Node's default) kills the whole server process — the platform LB then serves 503s to every user. `isolate.ts` therefore wraps every host function in an `{ok, value} | {ok, error}` envelope on the host side and rethrows inside the isolate, so errors surface as catchable sandbox exceptions and ultimately as `isError: true` tool results. `startServer()` also registers a log-only `unhandledRejection` handler as a safety net. Keep new host-exposed functions behind this wrapping.

**Stateless MCP:** `enableJsonResponse: true` and `sessionIdGenerator: undefined`. Each HTTP POST is independent — no session tracking.

**Stateless OAuth:** The OAuth flow encodes all state cryptographically in URLs — no server-side storage. Pending authorization params are HMAC-signed into the callback URL; auth codes are AES-256-GCM encrypted blobs containing the Sevalla token + metadata. Requires `OAUTH_SECRET` env var (base64url-encoded 32 bytes). In production (`NODE_ENV=production`) it's mandatory; in development an ephemeral key is auto-generated.

The OpenAPI spec is fetched from `api.sevalla.com/v3/openapi.json`, cached via a promise (prevents duplicate fetches on concurrent first requests), and refetched after a 10-minute TTL.

## Environment Variables

- `PORT` — HTTP port (default 3000)
- `OAUTH_SECRET` — base64url 32 bytes; required when `NODE_ENV=production`
- `PUBLIC_URL` — public base URL for OAuth metadata (default `https://mcp.sevalla.com`)
- `SEVALLA_FRONTEND_URL` — Sevalla dashboard URL for the OAuth consent flow (default `https://app.sevalla.com`)
- `SEVALLA_API_KEY` — API token for `--stdio` mode
- `SHUTDOWN_TIMEOUT_MS` — graceful shutdown deadline (default 30000)

## Git Conventions

- Conventional commit style: `fix(scope): ...`, `feat: ...`
- Never add `Co-Authored-By` trailers, "Generated with Claude Code" footers, or any other AI attribution to commits or PRs

## Code Style

- oxfmt: 120 char width, single quotes, no semicolons
- oxlint: unicorn + typescript plugins, unused-imports JS plugin
- ESM only (`"type": "module"`)
- Always use arrow functions, never `function` declarations
- No comments in code
