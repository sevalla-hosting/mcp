# Sevalla MCP Server Design

## Overview

A remote MCP server hosted at `mcp.sevalla.com` that exposes the Sevalla PaaS API (200 endpoints) through 2 code-mode tools (`search` + `execute`), using the [codemode](https://github.com/cnap-tech/codemode) library.

## Architecture

```
MCP Client (Claude, Cursor, etc.)
    |
    |  StreamableHTTP (POST /mcp)
    |  Authorization: Bearer <sevalla-api-key>
    v
+--------------------------------+
|  Hono HTTP Server              |
|  (mcp.sevalla.com)             |
|                                |
|  +---------------------------+ |
|  |  MCP Server               | |
|  |  StreamableHTTP Transport | |
|  |                           | |
|  |  +---------------------+  | |
|  |  |  CodeMode            | | |
|  |  |                      | | |
|  |  |  search tool         | | |
|  |  |  - spec from Sevalla | | |
|  |  |  - V8 isolate        | | |
|  |  |                      | | |
|  |  |  execute tool         | | |
|  |  |  - sevalla.request() | | |
|  |  |  - V8 isolate        | | |
|  |  +---------------------+  | |
|  +---------------------------+ |
+---------------+----------------+
                |
                |  fetch() with Bearer token
                v
        https://api.sevalla.com/v3
```

## Key Decisions

1. **Direct Fetch Proxy** - The MCP server forwards API calls to api.sevalla.com. No local API recreation.
2. **Auth passthrough** - User's Bearer token from MCP request is forwarded to Sevalla API.
3. **Per-request isolation** - Each MCP session binds the user's API key to a fresh CodeMode request handler.
4. **Spec caching** - OpenAPI spec fetched once on startup, cached in memory.
5. **Stateless MCP** - StreamableHTTP in stateless mode, no session management.
6. **Namespace: `sevalla`** - AI agents write `sevalla.request({ method: "GET", path: "/applications" })`.

## Tech Stack

- Runtime: Node.js 22+
- HTTP Framework: Hono
- MCP SDK: @modelcontextprotocol/sdk (StreamableHTTP transport)
- Code Mode: @robinbraemer/codemode
- Package Manager: pnpm
- Build: tsup (ESM)

## Project Structure

```
sevalla-mcp/
  src/
    index.ts          # Server entry point (Hono + MCP + CodeMode)
  package.json
  tsconfig.json
  Dockerfile
  .gitignore
```

## Deployment

- Node.js server deployable to k8s cluster
- Dockerfile included for containerized deployment
- Target: mcp.sevalla.com
