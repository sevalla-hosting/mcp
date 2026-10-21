# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Remote MCP server for the Sevalla PaaS API (mcp.sevalla.com), designed to pass Anthropic's Claude connector directory review. It exposes 27 tools: 22 purpose-built workflow tools plus 5 generic tools (`sevalla_api_search`, `sevalla_api_read`, `sevalla_api_create`, `sevalla_api_update`, `sevalla_api_delete`) that run any other v3 operation by operation ID. There is no code execution and no sandbox: the model only ever sends structured arguments.

## Commands

```bash
pnpm dev                # Development with --watch (native Node.js)
pnpm start              # Run server (node src/index.ts)
pnpm test               # Unit + e2e tests (node:test), then the e2e suites again as a 2025-era client
pnpm test:unit          # test/*.test.ts
pnpm test:e2e           # test/e2e in both protocol eras: real HTTP server, MCP SDK client, fake Sevalla API
pnpm test:live          # Live checks: known clients' metadata documents; API smoke test and fake API fidelity with SEVALLA_E2E_API_KEY
pnpm eval               # Evals: evals/tasks.ts through headless Claude Code against the fake API; first run (and every harness change) needs --approve-harness
pnpm test:coverage      # Tests with coverage (src/** only)
pnpm sync:operations    # Regenerate src/sevalla/operations.json from the live OpenAPI spec
pnpm check:operations   # Fail if the live spec drifted from operations.json
pnpm lint               # oxlint
pnpm fmt                # oxfmt (auto-fix)
pnpm fmt:check          # oxfmt (check only)
pnpm check:code         # Full check: tsc + oxlint + oxfmt
```

## Node.js Version

**Node.js 26 is the runtime** (Volta, `.nvmrc`, the Docker image); the code also runs on Node.js 24, which CI tests. TypeScript runs natively via Node's built-in type stripping (no build step), so only erasable TypeScript syntax works (no enums, namespaces or parameter properties). `tsc` (TypeScript 7) only type-checks. pnpm 12 is pinned in `packageManager`; Node 25+ no longer bundles corepack, so the Dockerfile installs that pnpm version with npm. pnpm settings go in `pnpm-workspace.yaml` when needed (there is none today; the Dockerfile copies it when present, and pnpm 11+ ignores the `pnpm` field of `package.json`). pnpm refuses packages published less than a day ago unless they are listed in `minimumReleaseAgeExclude` there, so a bump to a newer release fails `pnpm install --frozen-lockfile` until the release is a day old.

## Source Layout

- `src/index.ts` — Hono HTTP server: `/mcp`, Bearer token extraction and validation, per-request MCP server wiring for both protocol eras, server info and icons, graceful shutdown, `--stdio` mode.
- `src/oauth.ts` — stateless OAuth (client ID metadata documents, DCR, PKCE, device-code approval), per-path protected resource metadata, redirect URI rules.
- `src/client-metadata.ts` — OAuth Client ID Metadata Documents. client_id URLs must be canonical https URLs on a fully qualified DNS name (no IP literals, no explicit port, no credentials or fragment). Fetching is SSRF-guarded: c-ares DNS lookups (absolute names, 1.5 s, off the libuv thread pool) where every resolved address must be public, no redirects, 5 KB and 3 s limits. NAT64 addresses (`64:ff9b::/96`, returned by DNS64 resolvers for IPv4-only hosts) are judged by the IPv4 address they embed; the rest of `64:ff9b::/32` is blocked. Errors from the network are reported as a generic "could not be fetched" and logged server-side. Documents are validated, cached per `Cache-Control` (failures for 60 s), concurrent requests for one client share a fetch, at most 8 fetches run at once (503 beyond), and each client IP (IPv6: each /64) gets 2 fetches in flight and 30 uncached fetches a minute (429 beyond).
- `src/index.html` — the landing page at `/`: the endpoint and setup per client, in the colors, type and grid imagery of the Sevalla brand kit (sevalla-design); plain CSS, no external scripts.
- `src/assets/` — the Sevalla mark (`/icon.png`, `/icon.svg`) referenced from `serverInfo.icons` and `server.json`, the favicons (`/favicon.ico`, `/favicon.svg`) and the link preview the landing page names (`/og.png`), all from the brand kit.
- `src/sevalla/client.ts` — Sevalla API client: `/v3` URL pinning, Bearer auth, timeouts, response size limit, `ApiError`, `readOnly()` view.
- `src/sevalla/operations.json` — generated, trimmed snapshot of the v3 OpenAPI spec. Never edit by hand; run `pnpm sync:operations`.
- `src/sevalla/operations.ts` — the reviewed operation table: class (read/create/update/delete), dedicated tool mapping, unavailable operations, env var value fields, path/query validation, keyword search (with synonyms for everyday words such as app, copy, stop and region).
- `src/tools/define.ts` — `readTool` / `writeTool` and the annotation presets.
- `src/tools/*.ts` — tool groups: `services`, `deployments`, `observability`, `configuration`, `create`, `docs`, `api` (generic tools); `index.ts` registers them and holds the server instructions.
- `scripts/sync-operations.ts` — builds `operations.json` from https://api.sevalla.com/v3/openapi.json.
- `evals/` — `run.ts` runs each task in `tasks.ts` through headless Claude Code (your login, or `ANTHROPIC_API_KEY`) against the real server backed by the fake API, with tools loaded up front and deferred behind tool search, and grades done (the expected change or answer), safe (nothing else changed or was attempted) and honest (a Sonnet judge). Results land in `.claude/hillclimb/sevalla-mcp/`. The Evals workflow runs it on demand and keeps each run's results and transcripts as an artifact.

## Architecture

Request flow:

1. An MCP client POSTs to `/mcp` with `Authorization: Bearer <token>` (an OAuth-issued `smcp_` token or a raw Sevalla API key).
2. The token is validated against `GET /v3/api-keys/me` (cached 60 s). A definitive 401 returns HTTP 401 with `error="invalid_token"` so clients re-authenticate; other validation failures do not block the request.
3. `isLegacyRequest` (MCP SDK v2, `@modelcontextprotocol/server`) routes the request by protocol era. Requests carrying the 2026-07-28 `_meta` envelope go to `createMcpHandler` (`legacy: 'reject'`), which answers `server/discover`, validates the `Mcp-Method`/`Mcp-Name`/`MCP-Protocol-Version` headers against the body and adds `resultType`, cache hints and `serverInfo` to results. Everything else (2025-11-25 back to 2024-11-05, with or without `initialize`) goes to a per-request `WebStandardStreamableHTTPServerTransport` with JSON responses and no sessions, exactly as before the SDK upgrade.
4. Both eras build the server with the same factory, `createMcpServer(token)`, so they always see the same tools, instructions and icons. `tools.listChanged` is advertised as `false` (the list never changes at runtime), and `tools/list` and `server/discover` are publicly cacheable for an hour. `--stdio` uses the SDK's `serveStdio`, which serves both eras the same way.

Invariants that keep the server directory-compliant and safe:

- **Reads and writes never share a tool.** `readTool` handlers only receive `readOnly(client)` (GET only). Write tools are created with `writeTool(kind, ...)`, which sets the annotation preset. The generic tools only run operations of their own class.
- **The operation table is the security boundary for the generic tools.** The method and path always come from `operations.json`; path parameters are validated against the spec pattern and URL-encoded; unknown query parameters are rejected. Operations covered by a dedicated tool are refused by the generic tools so there is one path per operation.
- **When the snapshot is resynced, every new non-GET operation is classified**: GET is read, DELETE is delete, POST is create only if listed in `ADDITIVE_OPERATIONS`, everything else is update (destructive). Review new operations for secret-returning responses and add them to `UNAVAILABLE` or the secret field lists when needed.
- **Dedicated tools reach every field of their operations.** Each query and body field of an operation with a dedicated tool is sent by some test in `test/e2e/tools.e2e.test.ts` or pinned in its `UNSENT` table with the reason. The generic tools refuse these operations, so a field missing from both cannot be set at all. New fields from a resync fail the test until they are handled.
- **An operation is additive only if it creates something new without changing how existing resources behave, and it cannot send data or credentials off the platform, issue credentials, or make an existing resource reachable in a new way** (public ports, CDN or CORS exposure, load balancer domains and destinations). Webhooks, external backup targets and backups, usage alert emails and API key creation are therefore updates, so clients ask for confirmation. App and static site domains (`add_domain`) stay additive: they alias a service that is already public. `test/operations.test.ts` pins the list.
- **Only environment variable values are withheld.** `list_environment_variables` returns keys and scoping, the set/delete tools never echo values, and the generic tools redact `value` on the env var operations. Every other operation is available, including whole-service deletes, API key management and secret-issuing operations, whose responses are returned unredacted. Only the device-code endpoints (sign-in plumbing) and the terminal WebSocket are unavailable. Commands run in a process (`execProcessCommandV3`) and logs can still show secrets, so never describe the server as not returning secrets.
- **Descriptions describe, never instruct.** No "you must", "always", "first call" and similar; Anthropic treats instructions to the model as prompt injection. `test/policy.test.ts` enforces this for both protocol eras, plus titles, explicit hints (read tools: `openWorldHint: false`), typed inputs, no method/url/path inputs, and a `tools/list` size budget (38,000 characters).
- **Bounded results.** Logs default to 100 entries, metrics are summarized, every result is capped at 30,000 characters with a note on how to narrow the request.

**Stateless OAuth:** clients identify themselves with a Client ID Metadata Document URL (preferred; advertised via `client_id_metadata_document_supported`, used by Claude, ChatGPT and VS Code) or a DCR client ID (an encrypted blob of the registered redirect URIs; DCR is deprecated by the 2026-07-28 spec but kept for older clients). Pending authorization params are HMAC-signed into the callback URL; auth codes are AES-256-GCM encrypted blobs (`type: 'authorization_code'`, 60 s) containing the Sevalla token. Client registrations, codes and access tokens are encrypted with separate keys derived from `OAUTH_SECRET` (registrations keep the original key so existing DCR client IDs stay valid). `/oauth/*` bodies are limited to 16 KB. Requires `OAUTH_SECRET` (base64url 32 bytes) when `NODE_ENV=production`; development generates an ephemeral key. Redirect URIs must be https, loopback http (any port) or a native app scheme. Authorization responses carry `iss` (RFC 9207, advertised via `authorization_response_iss_parameter_supported`) so ChatGPT can use its stable redirect URI. A `resource` parameter must name this server (`/mcp` URL or origin) or the request fails with `invalid_target`. OAuth-issued access tokens are `smcp_`-prefixed AES-GCM envelopes bound to the `/mcp` resource; `/mcp` unwraps them and still accepts raw Sevalla API keys (Stella, manual configs). Access tokens do not expire and there are no refresh tokens: revoking the API key that the sign-in created (in the Sevalla dashboard) revokes the token, and rotating `OAUTH_SECRET` invalidates every OAuth-issued token, which makes clients re-authenticate. 401 challenges carry `resource_metadata` and `scope="mcp:tools"`. The consent page receives the redirect URI host first and then the document's `client_name` (metadata documents only, sanitized and capped at 40 characters), as `Sevalla MCP (<host> - <name>)`, in the `name` parameter, which also names the API key the approval creates. Only public clients are supported (`token_endpoint_auth_methods_supported: ['none']`, PKCE S256 required); documents that declare `private_key_jwt`, like ChatGPT's, are accepted as public clients because ChatGPT also supports `none`. When `DEVICE_CODE_TRUSTED_CLIENT_TOKEN` is set, device-code calls send it with the end-user IP so the API rate-limits per user instead of per server. The IP comes only from what the edge controls (`CLIENT_IP_HEADER`, `TRUSTED_PROXY_HOPS`, then the socket address); if no valid IP is found, neither header is sent.

## Environment Variables

- `PORT` — HTTP port (default 3000)
- `OAUTH_SECRET` — base64url 32 bytes; required when `NODE_ENV=production`
- `PUBLIC_URL` — public base URL for OAuth metadata (default `https://mcp.sevalla.com`)
- `SEVALLA_FRONTEND_URL` — Sevalla dashboard URL for the OAuth consent flow (default `https://app.sevalla.com`)
- `SEVALLA_API_URL` — Sevalla API base URL (default `https://api.sevalla.com`)
- `SEVALLA_DOCS_URL` — docs site for `search_sevalla_docs` (default `https://docs.sevalla.com`)
- `DEVICE_CODE_TRUSTED_CLIENT_TOKEN` — trusted-client token for the device-code endpoints
- `CLIENT_IP_HEADER` — header with the end-user IP set by the edge (default `x-forwarded-for`; `cf-connecting-ip` behind Cloudflare)
- `TRUSTED_PROXY_HOPS` — with `x-forwarded-for`, how many trusted proxies append to it; the client IP is read that many entries from the right (default 1). Never read the left-most entry: clients control it. Production must set `CLIENT_IP_HEADER=cf-connecting-ip` behind Cloudflare (with the origin reachable only through Cloudflare) or the correct hop count; the right-most entry is otherwise a proxy address shared by every user.
- `SEVALLA_API_KEY` — `--stdio` mode
- `SHUTDOWN_TIMEOUT_MS` — graceful shutdown deadline (default 30000)
- `OPENAI_APPS_CHALLENGE` — OpenAI plugin domain verification token, served as plain text at `/.well-known/openai-apps-challenge`

## Git Conventions

- Conventional commit style: `fix(scope): ...`, `feat: ...`
- Never add `Co-Authored-By` trailers, "Generated with Claude Code" footers, or any other AI attribution to commits or PRs

## Code Style

- oxfmt: 120 char width, single quotes, no semicolons
- oxlint: unicorn + typescript plugins, unused-imports JS plugin
- ESM only (`"type": "module"`)
- Always use arrow functions, never `function` declarations
- No comments in code
