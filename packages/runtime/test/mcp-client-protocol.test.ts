import { afterEach, expect, test } from "bun:test";
import { MCPServerStreamableHttp } from "@openai/agents";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server as LegacyServer } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport as LegacyServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { McpServer as ModernMcpServer, createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { mcpStreamableHttpClientOptions } from "../src/mcp-client";

// Tool definitions with deliberately unusual key order, nested schemas,
// annotations and metadata. The model sees these through agents-core's
// conversion, so the v2 client must return them exactly as the v1 client did.
const LEGACY_TOOLS = [
  {
    name: "search",
    title: "Search",
    description: "Search the index.",
    inputSchema: {
      required: ["query"],
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Query text", minLength: 1 },
        filters: {
          type: "object",
          properties: { kind: { enum: ["a", "b"] }, since: { type: "string", format: "date" } },
        },
        limit: { default: 10, type: "integer", maximum: 50 },
      },
      $defs: { unused: { type: "null" } },
    },
    outputSchema: {
      type: "object",
      properties: { hits: { type: "array", items: { type: "string" } } },
      required: ["hits"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { "example.com/owner": "search-team" },
  },
  {
    name: "fail",
    description: "Always fails with a JSON-RPC error.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "slow",
    description: "Never answers in time.",
    inputSchema: { type: "object" },
  },
];

type Started = { url: string; methods: string[]; stop: () => void };
const started: Started[] = [];

afterEach(() => {
  for (const server of started.splice(0)) server.stop();
});

function startLegacyServer(options: { probeStatus?: number } = {}): Started {
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      let method: string | null = null;
      if (request.method === "POST") {
        const body = (await request
          .clone()
          .json()
          .catch(() => null)) as { method?: unknown } | null;
        method = typeof body?.method === "string" ? body.method : null;
      }
      if (method) methods.push(method);
      if (method === "server/discover" && options.probeStatus) {
        return new Response("upstream failure", { status: options.probeStatus });
      }
      const mcp = new LegacyServer(
        { name: "legacy-fixture", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LEGACY_TOOLS }));
      mcp.setRequestHandler(CallToolRequestSchema, async (call) => {
        if (call.params.name === "fail") {
          throw new McpError(ErrorCode.InvalidParams, "the filters are not valid", {
            field: "filters",
          });
        }
        if (call.params.name === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        return {
          content: [{ type: "text", text: `hits for ${String(call.params.arguments?.query)}` }],
          structuredContent: { hits: ["one", "two"] },
        };
      });
      const transport = new LegacyServerTransport({ enableJsonResponse: true });
      await mcp.connect(transport);
      return await transport.handleRequest(request);
    },
  });
  const entry = {
    url: `http://127.0.0.1:${server.port}/mcp`,
    methods,
    stop: () => server.stop(true),
  };
  started.push(entry);
  return entry;
}

function startModernServer(): Started {
  const methods: string[] = [];
  const handler = createMcpHandler(() => {
    const mcp = new ModernMcpServer({ name: "modern-fixture", version: "1.0.0" });
    mcp.registerTool(
      "echo",
      { description: "Echo text.", inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: "text", text: `echo ${text}` }] }),
    );
    return mcp;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "POST") {
        const body = (await request
          .clone()
          .json()
          .catch(() => null)) as { method?: unknown } | null;
        if (typeof body?.method === "string") methods.push(body.method);
      }
      return await handler.fetch(request);
    },
  });
  const entry = {
    url: `http://127.0.0.1:${server.port}/mcp`,
    methods,
    stop: () => server.stop(true),
  };
  started.push(entry);
  return entry;
}

function connectV2(url: string, firstParty = false, timeout?: number): MCPServerStreamableHttp {
  return new MCPServerStreamableHttp({
    url,
    name: "fixture",
    ...mcpStreamableHttpClientOptions({ firstParty }),
    ...(timeout ? { timeout } : {}),
  });
}

async function withLegacyClient<T>(url: string, use: (client: LegacyClient) => Promise<T>) {
  const client = new LegacyClient({ name: "fixture", version: "1.0.0" });
  await client.connect(new LegacyClientTransport(new URL(url)));
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

function errorShape(error: unknown) {
  const record = error as { name?: unknown; code?: unknown; message?: unknown; data?: unknown };
  return { name: record.name, code: record.code, message: record.message, data: record.data };
}

test("a 2025-era server negotiates the legacy era and lists byte-identical tools", async () => {
  const fixture = startLegacyServer();
  const expected = JSON.stringify(
    await withLegacyClient(fixture.url, async (client) => (await client.listTools()).tools),
  );
  fixture.methods.length = 0;
  const server = connectV2(fixture.url);
  await server.connect();
  try {
    expect(JSON.stringify(await server.listTools())).toBe(expected);
    const result = await server.callToolResult("search", { query: "cats" });
    expect(result.content).toEqual([{ type: "text", text: "hits for cats" }]);
    expect(result.structuredContent).toEqual({ hits: ["one", "two"] });
  } finally {
    await server.close();
  }
  expect(fixture.methods.slice(0, 2)).toEqual(["server/discover", "initialize"]);
});

test("first-party servers skip the era probe", async () => {
  const fixture = startLegacyServer();
  const server = connectV2(fixture.url, true);
  await server.connect();
  await server.close();
  expect(fixture.methods[0]).toBe("initialize");
  expect(fixture.methods).not.toContain("server/discover");
});

test("a remembered legacy verdict skips the probe on the next connect", async () => {
  const fixture = startLegacyServer();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const server = connectV2(fixture.url);
    await server.connect();
    await server.close();
  }
  expect(fixture.methods.filter((method) => method === "server/discover")).toHaveLength(1);
  expect(fixture.methods.filter((method) => method === "initialize")).toHaveLength(2);
});

test("a server that answers the probe with a 5xx still connects over the 2025 handshake", async () => {
  const fixture = startLegacyServer({ probeStatus: 500 });
  const server = connectV2(fixture.url);
  await server.connect();
  try {
    expect((await server.listTools()).map((tool) => tool.name)).toEqual(["search", "fail", "slow"]);
  } finally {
    await server.close();
  }
});

test("server errors and timeouts keep their v1 shapes and model-visible text", async () => {
  const fixture = startLegacyServer();
  const [expectedFailure, expectedTimeout] = await withLegacyClient(fixture.url, async (client) => [
    await client.callTool({ name: "fail", arguments: {} }).catch((error: unknown) => error),
    await client
      .callTool({ name: "slow", arguments: {} }, undefined, { timeout: 200 })
      .catch((error: unknown) => error),
  ]);
  expect(errorShape(expectedFailure).name).toBe("McpError");
  expect(errorShape(expectedTimeout).code).toBe(ErrorCode.RequestTimeout);
  const server = connectV2(fixture.url, false, 200);
  await server.connect();
  try {
    await server.listTools();
    const failure = await server.callToolResult("fail", {}).catch((error: unknown) => error);
    expect(errorShape(failure)).toEqual(errorShape(expectedFailure));
    expect(errorShape(failure).code).toBe(ErrorCode.InvalidParams);
    const timeout = await server.callToolResult("slow", {}).catch((error: unknown) => error);
    expect(errorShape(timeout)).toEqual(errorShape(expectedTimeout));
    expect(errorShape(timeout).message).toBe("MCP error -32001: Request timed out");
  } finally {
    await server.close();
  }
});

test("a 2026-07-28 server negotiates the modern era", async () => {
  const fixture = startModernServer();
  const server = connectV2(fixture.url);
  await server.connect();
  try {
    expect((await server.listTools()).map((tool) => tool.name)).toEqual(["echo"]);
    const result = await server.callToolResult("echo", { text: "hi" });
    expect(result.content).toEqual([{ type: "text", text: "echo hi" }]);
  } finally {
    await server.close();
  }
  expect(fixture.methods[0]).toBe("server/discover");
  expect(fixture.methods).not.toContain("initialize");
});
