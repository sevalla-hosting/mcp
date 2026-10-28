<div align="center">

# Sevalla MCP Server

**Deploy, debug and manage Sevalla applications, static sites and databases from any AI agent.**

[![CI](https://github.com/sevalla/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sevalla/mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-26-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-8B5CF6)](https://modelcontextprotocol.io/specification/2026-07-28)
[![Hosted at](https://img.shields.io/badge/Hosted_at-mcp.sevalla.com/mcp-FF6723)](https://mcp.sevalla.com/mcp)

</div>

---

A remote [Model Context Protocol](https://modelcontextprotocol.io/) server for the [Sevalla](https://sevalla.com) PaaS API. It gives AI agents 27 tools: 22 purpose-built tools for the everyday workflows (deploying, reading logs and metrics, environment variables, scaling, domains, creating services) and 5 generic tools that reach the rest of the Sevalla API by operation ID, split into read, create, update and delete.

[![Sevalla server MCP server](https://glama.ai/mcp/servers/sevalla/mcp/badges/card.svg?v=2)](https://glama.ai/mcp/servers/sevalla/mcp)

## Tools

Every tool carries a title and explicit `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` annotations, so clients like Claude run read-only tools without asking and always confirm destructive ones.

| Area            | Tools                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Discovery       | `list_services`, `get_application`, `get_static_site`, `get_database`, `get_platform_options`, `search_sevalla_docs`     |
| Deployments     | `list_deployments`, `get_deployment`, `get_deployment_logs`, `trigger_deployment`, `rollback_deployment`                 |
| Observability   | `search_runtime_logs`, `search_access_logs`, `get_metrics`                                                               |
| Configuration   | `list_environment_variables`, `set_environment_variables`, `delete_environment_variables`, `scale_process`, `add_domain` |
| Create          | `create_application`, `create_static_site`, `create_database`                                                            |
| Rest of the API | `sevalla_api_search`, `sevalla_api_read`, `sevalla_api_create`, `sevalla_api_update`, `sevalla_api_delete`               |

The generic tools only accept operation IDs from a reviewed table generated from the [Sevalla API v3 spec](https://api-docs.sevalla.com): the server, not the model, picks the HTTP method and path, and each tool only runs operations of its own class.

### Secrets and destructive actions

Environment variable values are withheld: the tools list variable keys and their scoping, and set or delete them without ever returning a value. Everything else the Sevalla API offers is available, including deleting entire services, managing API keys and operations that issue a new secret (rolling a webhook secret, regenerating a deployment hook, rotating storage credentials), which return that secret. Destructive tools are annotated so Claude asks for confirmation before each call. Commands run inside a process (`execProcessCommandV3`) and application logs can still show secrets.

Every tool is limited by the permissions of the Sevalla API key behind the connection. Sevalla API keys support granular permissions, so a read-only key keeps an agent read-only. Full API reference at [api-docs.sevalla.com](https://api-docs.sevalla.com).

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
MCP client (Claude, Cursor, Codex, ...)
       │
       │  POST /mcp
       │  Authorization: Bearer <OAuth token or Sevalla API key>
       ▼
┌──────────────────────────────────────┐
│  Sevalla MCP server (Hono, stateless)│
│  • validates the key (cached 60 s)   │
│  • 27 tools, read tools get a        │
│    GET-only client                   │
│  • reviewed operation table for the  │
│    generic tools                     │
└──────────────────┬───────────────────┘
                   │  Bearer <key>
                   ▼
         https://api.sevalla.com/v3
```

Each request creates a fresh MCP server bound to the caller's API key; nothing is stored between requests. The server speaks MCP 2026-07-28 (`server/discover`, per-request metadata, cacheable tool lists) and still serves clients on the 2025 revisions (2025-11-25 back to 2024-11-05) over the same URL, with the same tools.

Sign-in is OAuth 2.1 with PKCE. Clients identify themselves with an [OAuth Client ID Metadata Document](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration#client-id-metadata-documents) (as Claude, ChatGPT and VS Code do) or, for older clients, Dynamic Client Registration. The flow is stateless too: pending authorizations are HMAC-signed into the callback URL, authorization codes are AES-256-GCM encrypted, and access tokens are encrypted and bound to `https://mcp.sevalla.com/mcp`.

## Examples

- "Why did the latest deployment of my-api fail?"
- "Deploy the main branch of my-api and tell me when it's live."
- "Summarize the errors in my-api's runtime logs from the last hour."
- "Create a PostgreSQL database in Frankfurt and connect it to my-api."
- "Add app.example.com to my-api and tell me which DNS records to create."

## Self-Hosting

**Requirements:** Node.js 26 (24 also works) and pnpm 12. TypeScript runs natively, no build step.

```bash
git clone https://github.com/sevalla/mcp.git
cd mcp
pnpm install
pnpm start
```

Or with Docker:

```bash
docker build -t sevalla-mcp .
docker run -p 3000:3000 -e OAUTH_SECRET=<base64url 32 bytes> sevalla-mcp
```

| Variable                           | Purpose                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                             | HTTP port (default 3000)                                                                                                                |
| `OAUTH_SECRET`                     | base64url-encoded 32 bytes; required when `NODE_ENV=production`                                                                         |
| `PUBLIC_URL`                       | Public base URL used in OAuth metadata (default `https://mcp.sevalla.com`)                                                              |
| `SEVALLA_FRONTEND_URL`             | Sevalla dashboard URL for the OAuth consent page (default `https://app.sevalla.com`)                                                    |
| `SEVALLA_API_URL`                  | Sevalla API base URL (default `https://api.sevalla.com`)                                                                                |
| `SEVALLA_DOCS_URL`                 | Documentation site searched by `search_sevalla_docs` (default `https://docs.sevalla.com`)                                               |
| `DEVICE_CODE_TRUSTED_CLIENT_TOKEN` | Service token that lets the API rate-limit OAuth sign-ins per end-user IP instead of per server IP                                      |
| `CLIENT_IP_HEADER`                 | Header carrying the end-user IP, set by your edge (default `x-forwarded-for`; use `cf-connecting-ip` behind Cloudflare)                 |
| `TRUSTED_PROXY_HOPS`               | With `x-forwarded-for`: number of trusted proxies that append to it; the client IP is read that many entries from the right (default 1) |
| `SEVALLA_API_KEY`                  | `--stdio` mode: the Sevalla API key                                                                                                     |
| `SHUTDOWN_TIMEOUT_MS`              | Graceful shutdown deadline (default 30000)                                                                                              |
| `OPENAI_APPS_CHALLENGE`            | Domain verification token served at `/.well-known/openai-apps-challenge` for the OpenAI plugin submission                               |

**Client IP in production.** The device-code rate limit is applied per end-user IP, so the server must read that IP from something your edge controls. Behind Cloudflare, set `CLIENT_IP_HEADER=cf-connecting-ip`, and make sure the origin cannot be reached without going through Cloudflare, otherwise the header can be forged. Without Cloudflare, set `TRUSTED_PROXY_HOPS` to the number of proxies that append to `X-Forwarded-For`. The defaults read the right-most entry, which behind a CDN or load balancer is usually a proxy address, so every user would share one limit.

## Development

```bash
pnpm dev                # Hot reload (node --watch)
pnpm test               # Unit and end-to-end tests (node:test), e2e as both 2026-07-28 and 2025 clients
pnpm test:e2e           # End-to-end tests: real HTTP server, MCP SDK client, fake Sevalla API
pnpm test:live          # Live checks: client metadata documents; API smoke test and fake API fidelity with SEVALLA_E2E_API_KEY
pnpm eval               # Evals through headless Claude Code against the fake API (see evals/)
pnpm check:code         # tsc + oxlint + oxfmt
pnpm sync:operations    # Regenerate src/sevalla/operations.json from the live API spec
pnpm check:operations   # Fail if the live API spec drifted from the snapshot
```

The policy tests in `test/policy.test.ts` enforce Anthropic's connector directory requirements on the live tool list: titles and explicit hints on every tool, read/write separation, descriptions that describe rather than instruct, and a size budget for the tool definitions.

## License

[MIT](LICENSE)
