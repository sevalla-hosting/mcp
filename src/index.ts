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
  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? new URL(input) : new URL(input.toString());
    url.pathname = "/v3" + url.pathname;

    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");

    return fetch(url.toString(), { ...init, headers });
  };
}

function createMcpServer(
  spec: Record<string, unknown>,
  token: string,
): McpServer {
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
    sessionIdGenerator: undefined,
  });

  await mcpServer.connect(transport);

  const response = await transport.handleRequest(c);
  return response ?? c.json({ error: "No response from transport" }, 500);
});

// ─── Start Server ───────────────────────────────────────────────────

await loadSpec();
console.log(`Sevalla MCP server starting on port ${PORT}`);

serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`Sevalla MCP server listening on http://localhost:${PORT}/mcp`);
