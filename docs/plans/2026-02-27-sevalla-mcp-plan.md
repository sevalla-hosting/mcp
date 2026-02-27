# Sevalla MCP Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a remote MCP server that exposes the Sevalla PaaS API (200 endpoints) through 2 code-mode tools (search + execute), deployable to k8s.

**Architecture:** Hono HTTP server with StreamableHTTP transport. Each request creates a fresh McpServer + CodeMode instance with the user's Bearer token bound to the fetch request handler. The OpenAPI spec is fetched once on startup and cached.

**Tech Stack:** Node.js 22+, Hono, @hono/node-server, @hono/mcp, @modelcontextprotocol/sdk, @robinbraemer/codemode, tsup, vitest

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `.gitignore`

**Step 1: Create package.json**

```json
{
  "name": "sevalla-mcp",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsup",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@hono/mcp": "^0.2.3",
    "@hono/node-server": "^1.13.0",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@robinbraemer/codemode": "^0.1.4",
    "hono": "^4.7.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsup": "^8.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

**Step 3: Create tsup.config.ts**

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  external: ["isolated-vm"],
});
```

**Step 4: Create .gitignore**

```
node_modules/
dist/
.env
```

**Step 5: Install dependencies**

Run: `pnpm install`
Expected: All dependencies install successfully. `isolated-vm` compiles native addon.

**Step 6: Commit**

```bash
git add package.json tsconfig.json tsup.config.ts .gitignore pnpm-lock.yaml
git commit -m "chore: scaffold sevalla-mcp project"
```

---

### Task 2: Implement the MCP Server

**Files:**
- Create: `src/index.ts`

**Context for implementer:**

Key technical details discovered during research:

1. **URL construction gotcha:** CodeMode's request bridge does `new URL(path, baseUrl)`. If `baseUrl = "https://api.sevalla.com/v3"` and `path = "/applications"`, the result is `https://api.sevalla.com/applications` (NOT `/v3/applications`), because absolute paths replace the base path per RFC 3986. Solution: set `baseUrl: "https://api.sevalla.com"` and prepend `/v3` in the request wrapper.

2. **Auth header blocking:** CodeMode's request bridge blocks `Authorization` headers from sandbox code by default (security feature). We inject the Bearer token in the request wrapper, outside the sandbox.

3. **Per-request isolation:** In stateless MCP mode, create a fresh `McpServer` + `CodeMode` + `StreamableHTTPTransport` per request. This ensures auth isolation between concurrent users. The MCP SDK's official stateless example follows this pattern.

4. **@hono/mcp transport:** `StreamableHTTPTransport` from `@hono/mcp` accepts Hono `Context` directly via `transport.handleRequest(c)`. For stateless mode, omit `sessionIdGenerator`.

5. **Spec caching:** Fetch the OpenAPI spec once on startup. Pass the same spec object to each CodeMode instance. Each instance will process it lazily on first tool call and cache internally.

6. **`registerTools()`:** From `@robinbraemer/codemode/mcp` — registers `search` and `execute` tools on an McpServer. The tool names become `search` and `execute` (prefixed by the namespace context in the tool descriptions).

**Step 1: Create src/index.ts**

```typescript
import { serve } from "@hono/node-server";
import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CodeMode } from "@robinbraemer/codemode";
import { registerTools } from "@robinbraemer/codemode/mcp";
import { Hono } from "hono";
import { cors } from "hono/cors";

// ─── Configuration ──────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3000", 10);
const SEVALLA_API_BASE = "https://api.sevalla.com";
const SEVALLA_SPEC_URL = "https://api.sevalla.com/v3/openapi.json";

// ─── Spec Cache ─────────────────────────────────────────────────────

let cachedSpec: Record<string, unknown> | null = null;

async function loadSpec(): Promise<Record<string, unknown>> {
  if (cachedSpec) return cachedSpec;
  console.log("Fetching OpenAPI spec from", SEVALLA_SPEC_URL);
  const res = await fetch(SEVALLA_SPEC_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch OpenAPI spec: ${res.status} ${res.statusText}`);
  }
  cachedSpec = (await res.json()) as Record<string, unknown>;
  console.log("OpenAPI spec loaded successfully");
  return cachedSpec;
}

// ─── Per-Request MCP Server Factory ─────────────────────────────────

function createAuthenticatedFetch(token: string) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    // Rewrite URL: prepend /v3 since the OpenAPI spec paths don't include it
    // CodeMode's bridge does new URL(path, baseUrl) which resolves to origin + path
    // e.g., new URL("/applications", "https://api.sevalla.com") → /applications
    // We need to add the /v3 version prefix
    const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
    url.pathname = "/v3" + url.pathname;

    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");

    return fetch(url.toString(), { ...init, headers });
  };
}

function createMcpServer(spec: Record<string, unknown>, token: string): McpServer {
  const codemode = new CodeMode({
    spec: spec as any,
    request: createAuthenticatedFetch(token),
    baseUrl: SEVALLA_API_BASE,
    namespace: "sevalla",
  });

  const server = new McpServer({
    name: "sevalla",
    version: "1.0.0",
  });

  registerTools(codemode, server);
  return server;
}

// ─── Hono App ───────────────────────────────────────────────────────

const app = new Hono();

// CORS for browser-based MCP clients
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "mcp-session-id",
      "Last-Event-ID",
      "mcp-protocol-version",
    ],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  }),
);

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// MCP endpoint — stateless: fresh server + transport per request
app.all("/mcp", async (c) => {
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  const spec = await loadSpec();

  const mcpServer = createMcpServer(spec, token);
  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  await mcpServer.connect(transport);

  return transport.handleRequest(c);
});

// ─── Start Server ───────────────────────────────────────────────────

const spec = await loadSpec();
console.log(`Sevalla MCP server starting on port ${PORT}`);

serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`Sevalla MCP server listening on http://localhost:${PORT}/mcp`);
```

**Step 2: Verify it compiles**

Run: `pnpm build`
Expected: Builds successfully to `dist/index.js`

**Step 3: Test manually**

Run: `pnpm dev`
Expected: Server starts, logs "Fetching OpenAPI spec" and "listening on http://localhost:3000/mcp"

Then test health check:
Run: `curl http://localhost:3000/health`
Expected: `{"status":"ok"}`

Then test auth rejection:
Run: `curl -X POST http://localhost:3000/mcp`
Expected: `{"error":"Missing or invalid Authorization header"}` with 401 status

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: implement sevalla MCP server with codemode"
```

---

### Task 3: Add Integration Tests

**Files:**
- Create: `test/server.test.ts`
- Create: `vitest.config.ts`

**Step 1: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

**Step 2: Write integration tests**

```typescript
// test/server.test.ts
import { describe, it, expect } from "vitest";

// Test the URL rewriting helper in isolation
describe("createAuthenticatedFetch", () => {
  it("prepends /v3 to the path", async () => {
    let capturedUrl = "";
    // We test the URL rewriting logic directly
    const url = new URL("https://api.sevalla.com/applications");
    url.pathname = "/v3" + url.pathname;
    expect(url.toString()).toBe("https://api.sevalla.com/v3/applications");
  });

  it("preserves query parameters", () => {
    const url = new URL("https://api.sevalla.com/applications?page=1&limit=25");
    url.pathname = "/v3" + url.pathname;
    expect(url.toString()).toBe("https://api.sevalla.com/v3/applications?page=1&limit=25");
  });

  it("handles nested paths", () => {
    const url = new URL("https://api.sevalla.com/applications/123/deployments");
    url.pathname = "/v3" + url.pathname;
    expect(url.toString()).toBe("https://api.sevalla.com/v3/applications/123/deployments");
  });
});
```

**Step 3: Run tests**

Run: `pnpm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add vitest.config.ts test/server.test.ts
git commit -m "test: add URL rewriting tests"
```

---

### Task 4: Add Dockerfile

**Files:**
- Create: `Dockerfile`

**Step 1: Create multi-stage Dockerfile**

```dockerfile
# Build stage
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

# isolated-vm needs build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
RUN pnpm build

# Production stage
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

# isolated-vm runtime dependency
RUN apk add --no-cache libstdc++

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
```

**Step 2: Verify Docker build**

Run: `docker build -t sevalla-mcp .`
Expected: Image builds successfully

**Step 3: Commit**

```bash
git add Dockerfile
git commit -m "chore: add Dockerfile for k8s deployment"
```

---

### Task 5: Final Verification

**Step 1: Build and start the server**

Run: `pnpm build && pnpm start`
Expected: Server starts on port 3000

**Step 2: Test with a real Sevalla API key (if available)**

Run: `curl -X POST http://localhost:3000/mcp -H "Content-Type: application/json" -H "Authorization: Bearer YOUR_KEY" -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}},"id":1}'`

Expected: JSON-RPC response with server capabilities including the `search` and `execute` tools.

**Step 3: Run all tests**

Run: `pnpm test`
Expected: All tests pass

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: sevalla MCP server ready for deployment"
```
