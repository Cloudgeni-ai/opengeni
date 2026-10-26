import { expect, test } from "bun:test";
import { RunContext, type MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildOpenGeniAgent,
  prefixedMcpToolName,
  prepareAgentTools,
  sessionMcpApprovalConnectionId,
  type ConnectorActionPolicyHooks,
  type ConnectorActionToolCall,
} from "../src/index";

// Reported in https://github.com/Cloudgeni-ai/opengeni/pull/2537 by Ali Ozaltin:
// an embedding host registers an in-process MCP server together with its own
// connection identity. That identity used to become the model-path approval
// identity, which the approval store refuses for session-MCP approvals ("missing
// its synthetic connection identity"), so an approval-gated tool failed the turn
// instead of pausing. It also disagreed with the identity the execution gateway
// admits the call under.
const serverId = "host-pms";
const hostIdentity = "host-attempt:55555555-5555-4555-8555-555555555555";
const serverConfig = {
  id: serverId,
  name: "Host PMS",
  url: "https://host-local.invalid/mcp",
  cacheToolsList: false,
  requireApproval: ["task_create"],
};
const synthetic = sessionMcpApprovalConnectionId(serverId, serverConfig.url);

function localServer(executions: string[]): MCPServer {
  const schema = { type: "object", properties: {}, required: [], additionalProperties: true };
  return {
    name: serverId,
    cacheToolsList: false,
    connect: async () => {},
    close: async () => {},
    listTools: async () => [
      { name: "task_create", description: "Create a task", inputSchema: schema },
      { name: "task_list", description: "List tasks", inputSchema: schema },
    ],
    callTool: async (name: string) => {
      executions.push(name);
      return [{ type: "text", text: "ok" }];
    },
  } as unknown as MCPServer;
}

async function harness(approvedToolCallId?: string) {
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [serverConfig] });
  const prepareCalls: ConnectorActionToolCall[] = [];
  const beginCalls: ConnectorActionToolCall[] = [];
  const executions: string[] = [];
  const hooks: ConnectorActionPolicyHooks = {
    prepare: async (call) => {
      prepareCalls.push(call);
      return { managed: true, decision: call.toolName === "task_create" ? "ask" : "allow" };
    },
    begin: async (call) => {
      beginCalls.push(call);
      return { allowed: true, managed: true, requestId: `request-${beginCalls.length}` };
    },
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
    localMcpServers: [
      { id: serverId, server: localServer(executions), resolvedConnectionId: hostIdentity },
    ],
  });
  const agent = buildOpenGeniAgent(settings, [], {
    mcpServers: prepared.mcpServers,
    resolvedMcpConnectionIds: prepared.resolvedMcpConnectionIds,
    connectorActionPolicy: hooks,
    ...(approvedToolCallId ? { approvedToolCallId } : {}),
  });
  const tools = await agent.getMcpTools(new RunContext());
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === prefixedMcpToolName(serverId, name));
    if (!found || found.type !== "function") throw new Error(`local MCP tool ${name} missing`);
    return found;
  };
  return { prepared, prepareCalls, beginCalls, executions, tool };
}

test("a local MCP server with a host connection identity pauses under its synthetic session-MCP identity", async () => {
  const { prepared, prepareCalls, tool } = await harness();
  try {
    // The adapter keeps its own frozen identity.
    expect(prepared.resolvedMcpConnectionIds.get(serverId)).toBe(hostIdentity);
    expect(
      await tool("task_create").needsApproval(new RunContext(), { title: "x" }, "host-call"),
    ).toBe(true);
    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]).toMatchObject({
      approvalId: "host-call",
      approvalMode: "session_mcp",
      serverId,
      toolName: "task_create",
      // The same identity the attempt gateway and saved tool permission rules use.
      connectionId: synthetic,
    });
  } finally {
    await prepared.close();
  }
});

test("a local MCP tool without an approval recommendation is evaluated under the same synthetic identity", async () => {
  const { prepared, prepareCalls, tool } = await harness();
  try {
    expect(await tool("task_list").needsApproval(new RunContext(), {}, "list-call")).toBe(false);
    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]!.approvalMode).toBeUndefined();
    expect(prepareCalls[0]).toMatchObject({ toolName: "task_list", connectionId: synthetic });
  } finally {
    await prepared.close();
  }
});

test("the approved local MCP call is admitted under the identity it paused with", async () => {
  const callId = "host-approved-call";
  const { prepared, prepareCalls, beginCalls, executions, tool } = await harness(callId);
  try {
    const create = tool("task_create");
    expect(await create.needsApproval(new RunContext(), { title: "x" }, callId)).toBe(true);
    const result = await create.invoke(new RunContext(), JSON.stringify({ title: "x" }), {
      toolCall: { callId },
    } as never);
    expect(result).not.toMatchObject({ isError: true });
    expect(executions).toEqual(["task_create"]);
    expect(beginCalls).toHaveLength(1);
    expect(beginCalls[0]).toMatchObject({ approvalId: callId, toolName: "task_create" });
    expect(beginCalls[0]!.connectionId).toBe(prepareCalls[0]!.connectionId);
    expect(beginCalls[0]!.connectionId).toBe(synthetic);
  } finally {
    await prepared.close();
  }
});
