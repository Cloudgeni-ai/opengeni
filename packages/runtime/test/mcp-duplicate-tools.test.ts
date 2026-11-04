import { describe, expect, spyOn, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { testSettings } from "@opengeni/testing/settings";
import { prepareAgentTools } from "../src/index";
import { uniqueListedMcpTools } from "../src/mcp-listed-tools";

function listed(name: string, description = `${name} tool`) {
  return { name, description, inputSchema: { type: "object" as const, properties: {} } };
}

describe("uniqueListedMcpTools", () => {
  test("keeps the first of each name in listing order and logs the repeats", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = [listed("a"), listed("b"), listed("b"), listed("c"), listed("b", "changed")];
      expect(uniqueListedMcpTools("server", tools)).toEqual([tools[0], tools[1], tools[3]]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![1]).toEqual({
        event: "mcp_tools_list_duplicates",
        serverId: "server",
        repeated: 2,
        names: ["b"],
        conflicting: ["b"],
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("returns a list without repeats unchanged and silently", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tools = [listed("a"), listed("b")];
      expect(uniqueListedMcpTools("server", tools)).toEqual(tools);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// Staging, November 4, 2026: the ElevenLabs hosted MCP listed some tools twice
// while its tool list changed. The SDK concatenates tools/list pages as
// returned, so an offset cursor over a shifting list repeats the tools at the
// page boundary. The attempt catalog then failed every turn with
// `Tool path account_….agents_bulk_delete_knowledge_base_e8b6a12b01 collides`.
test("an MCP server whose paginated tools/list repeats a tool still prepares one catalog", async () => {
  const pages = [
    { tools: [listed("agents_add_comment"), listed("agents_bulk_delete_knowledge_base")] },
    {
      tools: [
        listed("agents_bulk_delete_knowledge_base"),
        listed("agents_bulk_move_knowledge_base"),
      ],
    },
  ];
  const called: string[] = [];
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const server = new Server(
        { name: "shifting-list", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, (listRequest) => {
        const page = listRequest.params?.cursor === "page-2" ? 1 : 0;
        return { ...pages[page]!, ...(page === 0 ? { nextCursor: "page-2" } : {}) };
      });
      server.setRequestHandler(CallToolRequestSchema, (callRequest) => {
        called.push(callRequest.params.name);
        return { content: [{ type: "text", text: `ran ${callRequest.params.name}` }] };
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
  const remote = { id: "elevenlabs", url: `http://127.0.0.1:${provider.port}/mcp` };
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [remote] });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: remote.id }], {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
  });
  try {
    const entries = prepared.attemptToolCatalog?.entries ?? [];
    expect(entries.map((entry) => entry.identity.toolName)).toEqual([
      "agents_add_comment",
      "agents_bulk_delete_knowledge_base",
      "agents_bulk_move_knowledge_base",
    ]);
    expect(
      warn.mock.calls.some(
        ([, fields]) =>
          (fields as { event?: string })?.event === "mcp_tools_list_duplicates" &&
          (fields as { names?: string[] }).names?.[0] === "agents_bulk_delete_knowledge_base",
      ),
    ).toBe(true);
    const entry = entries[1]!;
    const result = await prepared.attemptToolEnvironment!.callModel({
      modelName: entry.modelName,
      arguments: {},
      subjectId: "agent:test",
    });
    expect(result.content).toEqual([
      { type: "text", text: "ran agents_bulk_delete_knowledge_base" },
    ]);
    expect(called).toEqual(["agents_bulk_delete_knowledge_base"]);
  } finally {
    warn.mockRestore();
    await prepared.close();
    for (const transport of transports) await transport.close();
    provider.stop(true);
  }
});
