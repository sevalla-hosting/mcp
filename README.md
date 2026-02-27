<div align="center">

# Sevalla MCP Server

**Give AI agents full access to the Sevalla PaaS API — with just 2 tools.**

[![CI](https://github.com/sevalla-hosting/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sevalla-hosting/mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-StreamableHTTP-8B5CF6)](https://modelcontextprotocol.io/)
[![Hosted at](https://img.shields.io/badge/Hosted_at-mcp.sevalla.com-FF6723)](https://mcp.sevalla.com)

</div>

---

A remote [Model Context Protocol](https://modelcontextprotocol.io/) server powered by [codemode](https://github.com/cnap-tech/codemode). Instead of registering one MCP tool per API endpoint (~200 endpoints), codemode collapses them into just 2:

- **`search`** — Query the OpenAPI spec to discover endpoints, parameters, and schemas
- **`execute`** — Run JavaScript in a sandboxed V8 isolate that calls the API via `sevalla.request()`

This reduces context window usage by ~99% compared to traditional one-tool-per-endpoint approaches.

## Quick Start

Connect your MCP client (Claude Desktop, Cursor, Windsurf, etc.) to the hosted server:

```json
{
  "mcpServers": {
    "sevalla": {
      "url": "https://mcp.sevalla.com",
      "headers": {
        "Authorization": "Bearer <your-sevalla-api-key>"
      }
    }
  }
}
```

Get your API key from [app.sevalla.com/api-keys](https://app.sevalla.com/api-keys). Full API reference at [api-docs.sevalla.com](https://api-docs.sevalla.com) (base URL: `api.sevalla.com/v3`).

That's it. Your AI agent can now manage your Sevalla infrastructure.

## How It Works

```
MCP Client (Claude, Cursor, etc.)
       │
       │  POST /
       │  Authorization: Bearer <sevalla-api-key>
       ▼
┌─────────────────────────────┐
│  Sevalla MCP Server         │
│  (Hono + StreamableHTTP)    │
│                             │
│  ┌───────────────────────┐  │
│  │  CodeMode             │  │
│  │  • search tool        │  │
│  │  • execute tool       │  │
│  │  • V8 sandboxed JS    │  │
│  └───────────────────────┘  │
└──────────────┬──────────────┘
               │  fetch() with Bearer token
               ▼
     https://api.sevalla.com/v3
```

Each request creates an isolated MCP session bound to the caller's API key. The server is fully stateless.

## Example

Once connected, the AI agent discovers and calls APIs on your behalf:

```js
// Search for the right endpoint
const endpoints = await sevalla.search('list all applications')

// Execute an API call in the V8 sandbox
const apps = await sevalla.request({
  method: 'GET',
  path: '/applications',
})
```

## Self-Hosting

**Requirements:** Node.js 24+ (TypeScript runs natively — no build step)

```bash
git clone https://github.com/sevalla-hosting/mcp.git
cd mcp
pnpm install
pnpm start
```

Or with Docker:

```bash
docker build -t sevalla-mcp .
docker run -p 3000:3000 sevalla-mcp
```

### Environment Variables

| Variable              | Default | Description                    |
| --------------------- | ------- | ------------------------------ |
| `PORT`                | `3000`  | Server port                    |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Graceful shutdown timeout (ms) |

### Health Check & Graceful Shutdown

The `/health` endpoint returns `200` when the server is ready and `503` during shutdown. The server handles `SIGTERM`/`SIGINT` to gracefully drain in-flight requests before exiting.

## Development

```bash
pnpm dev           # Hot reload (node --watch)
pnpm test          # Run tests (node:test)
pnpm check:code    # tsc + oxlint + oxfmt
```

## License

[MIT](LICENSE)
