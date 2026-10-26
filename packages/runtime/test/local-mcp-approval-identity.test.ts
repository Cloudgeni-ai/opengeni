import { expect, test } from "bun:test";
import { RunContext, type MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildOpenGeniAgent,
  prefixedMcpToolName,
  prepareAgentTools,
  sessionMcpApprovalConnectionId,
  type ConnectorActionPolicyHooks,
} from "../src/index";

// Reported in https://github.com/Cloudgeni-ai/opengeni/pull/2537 by Ali Ozaltin:
// an embedding host registers an in-process MCP server together with its own
// connection identity. That identity used to become the session-MCP approval
// identity, which the approval store refuses ("missing its synthetic connection
// identity"), so an approval-gated tool failed the turn instead of pausing.
const serverId = "host-pms";
const hostIdentity = "host-attempt:55555555-5555-4555-8555-555555555555";
const serverConfig = {
  id: serverId,
  name: "Host PMS",
  url: "https://host-local.invalid/mcp",
  cacheToolsList: false,
  requireApproval: ["task_create"],
};

function localServer(): MCPServer {
  return {
    name: serverId,
    cacheToolsList: false,
    connect: async () => {},
    close: async () => {},
    listTools: async () => [
      {
        name: "task_create",
        description: "Create a task",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: true },
      },
    ],
    callTool: async () => [{ type: "text", text: "created" }],
  } as unknown as MCPServer;
}

test("a local MCP server with a host connection identity is approved under its synthetic session-MCP identity", async () => {
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [serverConfig] });
  const policyCalls: Array<Record<string, unknown>> = [];
  const hooks: ConnectorActionPolicyHooks = {
    prepare: async (call) => {
      policyCalls.push(call as unknown as Record<string, unknown>);
      return { managed: true, decision: "ask" };
    },
    begin: async () => ({ allowed: true, managed: true, requestId: "host-request" }),
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
    localMcpServers: [{ id: serverId, server: localServer(), resolvedConnectionId: hostIdentity }],
  });
  try {
    // The adapter keeps its own frozen identity.
    expect(prepared.resolvedMcpConnectionIds.get(serverId)).toBe(hostIdentity);
    const agent = buildOpenGeniAgent(settings, [], {
      mcpServers: prepared.mcpServers,
      resolvedMcpConnectionIds: prepared.resolvedMcpConnectionIds,
      connectorActionPolicy: hooks,
    });
    const tool = (await agent.getMcpTools(new RunContext())).find(
      (candidate) => candidate.name === prefixedMcpToolName(serverId, "task_create"),
    );
    if (!tool || tool.type !== "function") throw new Error("local MCP tool missing");
    expect(await tool.needsApproval(new RunContext(), { title: "x" }, "host-call")).toBe(true);
    expect(policyCalls).toHaveLength(1);
    expect(policyCalls[0]).toMatchObject({
      approvalId: "host-call",
      approvalMode: "session_mcp",
      serverId,
      toolName: "task_create",
      // The same identity the attempt gateway and saved tool permission rules use.
      connectionId: sessionMcpApprovalConnectionId(serverId, serverConfig.url),
    });
    expect(String(policyCalls[0]!.connectionId)).toStartWith("session-mcp:");
    expect(String(policyCalls[0]!.connectionId)).not.toContain(hostIdentity);
  } finally {
    await prepared.close();
  }
});
