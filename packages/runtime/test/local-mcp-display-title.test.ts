import { expect, test } from "bun:test";
import { RunContext, type MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildOpenGeniAgent,
  prefixedMcpToolName,
  prepareAgentTools,
  withMcpToolDisplayMetadata,
  type ConnectorActionPolicyHooks,
  type ConnectorActionToolCall,
} from "../src/index";

// API integration tools are named by a lowercased operation id
// ("me_mailfolders_createmessages"). Their plain title travels in tool `_meta`
// so approval cards and activity rows read "Save a draft email" while the
// model's tool name, title and description stay exactly as before.
const serverId = "outlook-mail";
const serverConfig = {
  id: serverId,
  name: "Outlook Mail",
  url: "https://outlook-local.invalid/mcp",
  cacheToolsList: false,
  requireApproval: ["me_mailfolders_createmessages"],
};
const schema = {
  type: "object",
  properties: { path: { type: "object" }, body: { type: "object" } },
  additionalProperties: false,
};

function localServer(): MCPServer {
  return {
    name: serverId,
    cacheToolsList: false,
    connect: async () => {},
    close: async () => {},
    listTools: async () => [
      {
        name: "me_mailfolders_createmessages",
        description: "Use this API to create a new Message in a mailfolder.",
        inputSchema: schema,
        _meta: {
          "opengeni/operationKey": "me.mailFolders.CreateMessages",
          "opengeni/displayTitle": "Save a draft email",
        },
      },
      {
        name: "titled_tool",
        title: "Provider title",
        description: "A tool with its own title.",
        inputSchema: schema,
        _meta: { "opengeni/displayTitle": "Ignored display title" },
      },
    ],
    callTool: async () => [{ type: "text", text: "ok" }],
  } as unknown as MCPServer;
}

async function harness() {
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [serverConfig] });
  const prepareCalls: ConnectorActionToolCall[] = [];
  const hooks: ConnectorActionPolicyHooks = {
    preview: async () => ({ managed: true, decision: "ask" }),
    prepare: async (call) => {
      prepareCalls.push(call);
      return { managed: true, decision: "ask" };
    },
    begin: async () => ({ allowed: true, managed: true, requestId: "request-1" }),
    complete: async () => {},
  };
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: serverId }], {
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
    attemptId: "55555555-5555-4555-8555-555555555555",
    executionGeneration: 1,
    connectorActionPolicy: hooks,
    localMcpServers: [{ id: serverId, server: localServer() }],
  });
  const agent = buildOpenGeniAgent(settings, [], {
    mcpServers: prepared.mcpServers,
    resolvedMcpConnectionIds: prepared.resolvedMcpConnectionIds,
    connectorActionPolicy: hooks,
  });
  const tools = await agent.getMcpTools(new RunContext());
  return { prepared, prepareCalls, tools };
}

test("an API operation's display title reaches the approval review and activity rows only", async () => {
  const { prepared, prepareCalls, tools } = await harness();
  try {
    const name = prefixedMcpToolName(serverId, "me_mailfolders_createmessages");
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool || tool.type !== "function") throw new Error("tool missing");
    expect(
      await tool.needsApproval(new RunContext(), { body: { subject: "Hi" } }, "draft-call"),
    ).toBe(true);
    // The card reads the request: an API operation is marked so.
    expect(prepareCalls[0]?.reviewContext).toMatchObject({
      title: "Save a draft email",
      kind: "api",
    });

    expect(
      withMcpToolDisplayMetadata(prepared.mcpServers, { id: "draft-call", name }),
    ).toMatchObject({
      display: { toolName: "me_mailfolders_createmessages", title: "Save a draft email" },
    });

    // Nothing the model reads changes: no title in its catalog entry or tool.
    const entry = prepared.attemptToolCatalog?.entries.find((item) => item.modelName === name);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("title");
    expect(JSON.stringify(entry)).not.toContain("Save a draft email");
    expect(JSON.stringify(tool)).not.toContain("Save a draft email");
  } finally {
    await prepared.close();
  }
});

test("a tool's own MCP title wins over a display title", async () => {
  const { prepared } = await harness();
  try {
    const name = prefixedMcpToolName(serverId, "titled_tool");
    expect(withMcpToolDisplayMetadata(prepared.mcpServers, { id: "c", name })).toMatchObject({
      display: { title: "Provider title" },
    });
  } finally {
    await prepared.close();
  }
});
