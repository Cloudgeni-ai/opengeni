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

type ListPage = { tools: ReturnType<typeof listed>[] };

/** A real streamable-HTTP MCP server whose tools/list is served in the given pages. */
function serveMcp(pages: ListPage[]) {
  const called: string[] = [];
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const server = new Server(
        { name: "listed-tools", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, (listRequest) => {
        const cursor = listRequest.params?.cursor;
        const page = cursor ? Number(cursor.slice("page-".length)) - 1 : 0;
        return {
          ...pages[page]!,
          ...(page + 1 < pages.length ? { nextCursor: `page-${page + 2}` } : {}),
        };
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
  return {
    called,
    url: `http://127.0.0.1:${provider.port}/mcp`,
    async stop() {
      for (const transport of transports) await transport.close();
      provider.stop(true);
    },
  };
}

function turnScope() {
  return {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
  };
}

// Staging, November 4, 2026: the ElevenLabs hosted MCP listed some tools twice
// while its tool list changed. The SDK concatenates tools/list pages as
// returned, so an offset cursor over a shifting list repeats the tools at the
// page boundary. The attempt catalog then failed every turn with
// `Tool path account_….agents_bulk_delete_knowledge_base_e8b6a12b01 collides`.
test("an MCP server whose paginated tools/list repeats a tool still prepares one catalog", async () => {
  const mcp = serveMcp([
    { tools: [listed("agents_add_comment"), listed("agents_bulk_delete_knowledge_base")] },
    {
      tools: [
        listed("agents_bulk_delete_knowledge_base"),
        listed("agents_bulk_move_knowledge_base"),
      ],
    },
  ]);
  const remote = { id: "elevenlabs", url: mcp.url };
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [remote] });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: remote.id }], turnScope());
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
    expect(mcp.called).toEqual(["agents_bulk_delete_knowledge_base"]);
  } finally {
    warn.mockRestore();
    await prepared.close();
    await mcp.stop();
  }
});

describe("a model name claimed by an MCP tool and a built-in tool", () => {
  async function prepareShared(localIdentity: { serverId: string; toolName: string }) {
    const mcp = serveMcp([{ tools: [listed("observe")] }]);
    const remote = { id: "remote", url: mcp.url };
    const local: string[] = [];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const prepared = await prepareAgentTools(
      testSettings({ sandboxBackend: "none", mcpServers: [remote] }),
      [{ kind: "mcp", id: remote.id }],
      {
        ...turnScope(),
        attemptToolDefinitions: [
          {
            identity: localIdentity,
            modelName: "remote__observe",
            codemodePath: [localIdentity.serverId, localIdentity.toolName],
            inputSchema: { type: "object", additionalProperties: false },
            source: "interaction",
            approval: "none",
            execute: async () => {
              local.push(localIdentity.toolName);
              return { content: [{ type: "text", text: "observed locally" }] };
            },
          },
        ],
      },
    );
    const localServer = prepared.mcpServers.find(
      (server) => server.name === "opengeni-attempt-local-tools",
    )!;
    const remoteServer = prepared.mcpServers.find(
      (server) => server.name !== "opengeni-attempt-local-tools",
    )!;
    return {
      prepared,
      local,
      mcp,
      localServer,
      remoteServer,
      async close() {
        warn.mockRestore();
        await prepared.close();
        await mcp.stop();
      },
    };
  }

  test("with distinct identities, each server's call runs only its own tool", async () => {
    const shared = await prepareShared({ serverId: "interaction", toolName: "observe" });
    try {
      expect(shared.prepared.attemptToolCatalog!.entries.map((entry) => entry.identity)).toEqual([
        { serverId: "remote", toolName: "observe" },
      ]);
      // The built-in server still advertises the name; its call is refused
      // instead of running the connector tool that won the name.
      await expect(shared.localServer.callToolResult!("remote__observe", {})).rejects.toMatchObject(
        { name: "ToolGatewayToolNotFoundError" },
      );
      expect(shared.mcp.called).toEqual([]);
      expect(shared.local).toEqual([]);
      expect(await shared.remoteServer.callTool("remote__observe", {})).toMatchObject({
        content: [{ type: "text", text: "ran observe" }],
      });
      expect(shared.mcp.called).toEqual(["observe"]);
      expect(shared.local).toEqual([]);
    } finally {
      await shared.close();
    }
  });

  test("with one identity, neither server's call runs", async () => {
    const shared = await prepareShared({ serverId: "remote", toolName: "observe" });
    try {
      expect(shared.prepared.attemptToolCatalog!.entries).toEqual([]);
      await expect(shared.localServer.callToolResult!("remote__observe", {})).rejects.toMatchObject(
        { name: "ToolGatewayToolNotFoundError" },
      );
      await expect(shared.remoteServer.callTool("remote__observe", {})).rejects.toMatchObject({
        name: "ToolGatewayToolNotFoundError",
      });
      expect(shared.mcp.called).toEqual([]);
      expect(shared.local).toEqual([]);
    } finally {
      await shared.close();
    }
  });
});
