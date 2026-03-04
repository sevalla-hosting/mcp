<div align="center">

# Sevalla MCP Server

**Give AI agents full access to the Sevalla PaaS API. Just 2 tools.**

[![CI](https://github.com/sevalla-hosting/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sevalla-hosting/mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-StreamableHTTP-8B5CF6)](https://modelcontextprotocol.io/)
[![Hosted at](https://img.shields.io/badge/Hosted_at-mcp.sevalla.com/mcp-FF6723)](https://mcp.sevalla.com/mcp)

</div>

---

A remote [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes the entire Sevalla PaaS API through just 2 tools instead of ~200. AI agents write JavaScript that runs in sandboxed V8 isolates to discover and call any API endpoint on demand.

- **`search`** - query the OpenAPI spec to discover endpoints, parameters, and schemas
- **`execute`** - run JavaScript in a sandboxed V8 isolate that calls the API via `sevalla.request()`

This reduces context window usage by ~99% compared to traditional one-tool-per-endpoint approaches.

## Background

Cloudflare came up with the [Code Mode MCP](https://blog.cloudflare.com/code-mode-mcp/) pattern: instead of registering one tool per API endpoint, you give the agent two tools. One to search the API spec, one to execute code against it. Simple idea, massive difference in practice.

As a [Cloudflare partner](https://www.sevalla.com), we took this pattern and built it for the Sevalla PaaS API. The sandbox architecture and tool design are inspired by [codemode](https://github.com/cnap-tech/codemode), an open-source implementation of the same pattern.

Any MCP client can now manage Sevalla infrastructure through conversation. The AI writes and runs API calls in a secure V8 sandbox. No SDK needed, no boilerplate, no 200-tool context window.

## Quick Start

Connect your MCP client to the hosted server at `https://mcp.sevalla.com/mcp`. Authentication is handled via OAuth — your client will open a browser to log in with your Sevalla account. No API keys needed in the config.

### Claude Code

```bash
claude mcp add --transport http sevalla https://mcp.sevalla.com/mcp
```

Then type `/mcp` inside Claude Code and select **Authenticate** to complete the OAuth flow.

[Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp)

### Claude Desktop

Add via **Settings → Connectors → Add Connector** and enter `https://mcp.sevalla.com/mcp` as the URL. Claude Desktop handles OAuth automatically.

[Claude Desktop MCP docs](https://modelcontextprotocol.io/quickstart/user)

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "sevalla": {
      "url": "https://mcp.sevalla.com/mcp"
    }
  }
}
```

[Cursor MCP docs](https://docs.cursor.com/context/mcp)

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "sevalla": {
      "serverUrl": "https://mcp.sevalla.com/mcp"
    }
  }
}
```

[Windsurf MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp)

### OpenCode

Add to `opencode.json` in your project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sevalla": {
      "type": "remote",
      "url": "https://mcp.sevalla.com/mcp"
    }
  }
}
```

Then run `opencode mcp auth sevalla` to complete the OAuth flow.

[OpenCode MCP docs](https://opencode.ai/docs/mcp-servers)

---

Sevalla API keys support granular permissions — you can create a read-only key if you want your agent to query infrastructure without modifying it. Full API reference at [api-docs.sevalla.com](https://api-docs.sevalla.com) (base URL: `api.sevalla.com/v3`).

## Uninstall

To fully remove the Sevalla MCP server, delete the server configuration **and** clear stored OAuth credentials.

Removing the MCP server does **not** delete your API key on Sevalla. To revoke it, go to [app.sevalla.com/api-keys](https://app.sevalla.com/api-keys).

### Claude Code

```bash
claude mcp remove sevalla
```

Then clear the stored OAuth token: run `/mcp` inside Claude Code, select **sevalla**, and choose **Clear authentication**.

If the server was added at a non-default scope, specify it explicitly:

```bash
claude mcp remove --scope user sevalla
claude mcp remove --scope project sevalla
```

[Claude Code MCP reference](https://docs.anthropic.com/en/docs/claude-code/mcp)

### Claude Desktop

Open **Settings → Connectors**, find the Sevalla connector, and remove it. Then fully quit and restart Claude Desktop.

OAuth tokens are stored in the operating system keychain (macOS Keychain / Windows Credential Manager). To remove them, delete the Sevalla entry from your keychain manually.

[Claude Desktop MCP docs](https://modelcontextprotocol.io/quickstart/user)

### Cursor

Delete the `sevalla` entry from `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). Then clear cached OAuth tokens:

```bash
rm -rf ~/.mcp-auth
```

[Cursor MCP docs](https://docs.cursor.com/context/mcp)

### Windsurf

Delete the `sevalla` entry from `~/.codeium/windsurf/mcp_config.json`.

[Windsurf MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp)

### OpenCode

```bash
opencode mcp logout sevalla
```

Then delete the `sevalla` entry from `opencode.json` in your project root.

[OpenCode MCP docs](https://opencode.ai/docs/mcp-servers)

## How It Works

```
MCP Client (Claude, Cursor, etc.)
       │
       │  POST /mcp
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

**Requirements:** Node.js 24+ (TypeScript runs natively, no build step)

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

## Development

```bash
pnpm dev           # Hot reload (node --watch)
pnpm test          # Run tests (node:test)
pnpm check:code    # tsc + oxlint + oxfmt
```

## License

[MIT](LICENSE)
