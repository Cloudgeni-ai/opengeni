import { expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { FIRST_PARTY_MCP_CALLER_META_KEY } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import { attemptToolCallMeta, buildOpenGeniAgent, prepareAgentTools } from "../src/index";

const operationId = "8d4c7c1e-0b7f-4a55-9d0f-3f2a1c9b6e10";

test("a first-party call names the attempt surface that issued it", () => {
  for (const kind of ["model", "codemode"] as const) {
    expect(
      attemptToolCallMeta("opengeni", {
        operationId,
        caller: { kind },
        transportMeta: { progressToken: 7 },
      }),
    ).toEqual({
      progressToken: 7,
      opengeniOperationId: operationId,
      [FIRST_PARTY_MCP_CALLER_META_KEY]: kind,
    });
  }
});

test("transport metadata cannot claim another caller", () => {
  expect(
    attemptToolCallMeta("opengeni", {
      operationId,
      caller: { kind: "codemode" },
      transportMeta: { [FIRST_PARTY_MCP_CALLER_META_KEY]: "model" },
    })[FIRST_PARTY_MCP_CALLER_META_KEY],
  ).toBe("codemode");
});

test("a third-party server never learns the caller surface", () => {
  expect(
    attemptToolCallMeta("github", {
      operationId,
      caller: { kind: "model" },
      transportMeta: { [FIRST_PARTY_MCP_CALLER_META_KEY]: "model" },
    }),
  ).toEqual({ opengeniOperationId: operationId });
});

test("the attempt gateway marks model and Codemode calls to the first-party server", async () => {
  const callers: unknown[] = [];
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const server = new McpServer({ name: "first-party", version: "1.0.0" });
      server.registerTool("session_get", { inputSchema: {} }, async (_input, extra) => {
        callers.push(extra._meta?.[FIRST_PARTY_MCP_CALLER_META_KEY]);
        return { content: [{ type: "text" as const, text: "{}" }] };
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      transports.push(transport);
      await server.connect(transport);
      return transport.handleRequest(request);
    },
  });
  const url = `http://127.0.0.1:${provider.port}/v1/workspaces/{workspaceId}/mcp`;
  const settings = testSettings({
    sandboxBackend: "none",
    webSearchEnabled: false,
    opengeniMcpUrl: url,
    opengeniMcpInternalUrl: url,
    mcpServers: [{ id: "opengeni", url, cacheToolsList: false }],
  });
  const scope = {
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
    attemptId: "55555555-5555-4555-8555-555555555555",
    executionGeneration: 1,
  };
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "opengeni" }], scope);
  try {
    const environment = prepared.attemptToolEnvironment;
    if (!environment) throw new Error("attempt tool environment missing");
    const entry = environment.catalog.entries.find(
      (candidate) =>
        candidate.identity.serverId === "opengeni" && candidate.identity.toolName === "session_get",
    );
    if (!entry) throw new Error("first-party tool missing from the attempt catalog");
    const agent = buildOpenGeniAgent(settings, [], { mcpServers: prepared.mcpServers });
    const tool = (await agent.getMcpTools(new RunContext())).find(
      (candidate) => candidate.type === "function" && candidate.name === entry.modelName,
    );
    if (!tool || tool.type !== "function") throw new Error("model tool missing");
    await tool.invoke(new RunContext(), "{}", { toolCall: { callId: "call-model" } } as never);
    await (
      await environment.prepareCall({
        operationId: crypto.randomUUID(),
        catalogDigest: environment.catalog.digest,
        identity: entry.identity,
        arguments: {},
        caller: { kind: "codemode", subjectId: "worker:codemode" },
      })
    ).execute();
    expect(callers).toEqual(["model", "codemode"]);
  } finally {
    await prepared.close();
    for (const transport of transports) await transport.close();
    provider.stop(true);
  }
});
