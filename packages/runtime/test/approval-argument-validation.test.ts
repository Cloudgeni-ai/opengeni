import { expect, test } from "bun:test";
import { RunContext, type MCPServer } from "@openai/agents";
import { testSettings } from "@opengeni/testing/settings";
import {
  buildOpenGeniAgent,
  prefixedMcpToolName,
  prepareAgentTools,
  type AttemptConnectorActionBinding,
  type ConnectorActionPolicyHooks,
  type ConnectorActionToolCall,
} from "../src/index";

// A call whose arguments the tool's input schema rejects can never run, so no
// person may be asked to approve it: the model gets the usual "not called"
// argument error at once. Seen in production as an Ask card for an empty-args
// connector call that was rejected with "missing required property body" only
// after someone approved it.

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};

const createSchema = {
  type: "object",
  properties: {
    calendarId: { type: "string" },
    body: {
      type: "object",
      properties: { role: { type: "string" } },
      required: ["role"],
    },
  },
  required: ["calendarId", "body"],
  additionalProperties: false,
};

function policyRecorder() {
  const prepareCalls: ConnectorActionToolCall[] = [];
  const beginCalls: ConnectorActionToolCall[] = [];
  const hooks: ConnectorActionPolicyHooks = {
    prepare: async (call) => {
      prepareCalls.push(call);
      return { managed: true, decision: "ask" };
    },
    begin: async (call) => {
      beginCalls.push(call);
      return { allowed: true, managed: true, requestId: `request-${beginCalls.length}` };
    },
    complete: async () => {},
  };
  return { hooks, prepareCalls, beginCalls };
}

const text = (result: unknown) =>
  ((result as { content?: { text?: string }[] }).content ?? [])
    .map((block) => block.text ?? "")
    .join("");

type FunctionTool = Extract<
  Awaited<ReturnType<ReturnType<typeof buildOpenGeniAgent>["getMcpTools"]>>[number],
  { type: "function" }
>;

async function mcpHarness(options: { approvedToolCallId?: string; unattendedNow?: boolean } = {}) {
  const serverId = "calendar";
  const serverConfig = {
    id: serverId,
    name: "Calendar",
    url: "https://calendar.invalid/mcp",
    cacheToolsList: false,
    requireApproval: ["create_permission"],
  };
  const settings = testSettings({ sandboxBackend: "none", mcpServers: [serverConfig] });
  const executions: { name: string; args: unknown }[] = [];
  const server = {
    name: serverId,
    cacheToolsList: false,
    connect: async () => {},
    close: async () => {},
    listTools: async () => [
      { name: "create_permission", description: "Share a calendar", inputSchema: createSchema },
    ],
    callTool: async (name: string, args: unknown) => {
      executions.push({ name, args });
      return [{ type: "text", text: "ok" }];
    },
  } as unknown as MCPServer;
  const { hooks, prepareCalls, beginCalls } = policyRecorder();
  const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: serverId }], {
    ...scope,
    connectorActionPolicy: hooks,
    localMcpServers: [{ id: serverId, server, resolvedConnectionId: "host-connection" }],
  });
  const agent = buildOpenGeniAgent(settings, [], {
    mcpServers: prepared.mcpServers,
    resolvedMcpConnectionIds: prepared.resolvedMcpConnectionIds,
    connectorActionPolicy: hooks,
    ...(options.approvedToolCallId ? { approvedToolCallId: options.approvedToolCallId } : {}),
    ...(options.unattendedNow ? { unattendedNow: true } : {}),
  });
  const tools = await agent.getMcpTools(new RunContext());
  const tool = tools.find(
    (candidate) => candidate.name === prefixedMcpToolName(serverId, "create_permission"),
  ) as FunctionTool | undefined;
  if (!tool || tool.type !== "function") throw new Error("calendar tool missing");
  return { prepared, tool, executions, prepareCalls, beginCalls };
}

async function attemptBindingHarness() {
  const executions: Record<string, unknown>[] = [];
  const { hooks, prepareCalls, beginCalls } = policyRecorder();
  const bindings: AttemptConnectorActionBinding[] = [
    {
      modelName: "calendar_create_permission",
      call: (approvalId, arguments_) => ({
        approvalId,
        connectionId: "connection-calendar",
        serverId: "calendar",
        toolName: "create_permission",
        arguments: arguments_,
      }),
    },
  ];
  const prepared = await prepareAgentTools(testSettings(), [], {
    ...scope,
    connectorActionPolicy: hooks,
    attemptConnectorActionBindings: bindings,
    attemptToolDefinitions: [
      {
        identity: { serverId: "calendar", toolName: "create_permission" },
        modelName: "calendar_create_permission",
        inputSchema: createSchema,
        source: "mcp",
        approval: "policy",
        execute: async (args) => {
          executions.push(args);
          return { content: [{ type: "text", text: "shared" }] };
        },
      },
    ],
  });
  const agent = buildOpenGeniAgent(testSettings(), [], {
    mcpServers: prepared.mcpServers,
    connectorActionPolicy: hooks,
    attemptConnectorActionBindings: bindings,
  });
  const tool = (await agent.getMcpTools(new RunContext())).find(
    (candidate) => candidate.name === "calendar_create_permission",
  ) as FunctionTool | undefined;
  if (!tool || tool.type !== "function") throw new Error("attempt connector tool missing");
  return { prepared, tool, executions, prepareCalls, beginCalls };
}

for (const [path, harness] of [
  ["an MCP connector tool", () => mcpHarness()],
  ["an attempt-local connector action", attemptBindingHarness],
] as const) {
  test(`${path} with arguments its schema rejects is refused before any approval is asked`, async () => {
    const { prepared, tool, executions, prepareCalls, beginCalls } = await harness();
    try {
      const callId = "call-empty";
      expect(await tool.needsApproval(new RunContext(), {}, callId)).toBe(false);
      // No policy preparation, so no Ask card and no review row.
      expect(prepareCalls).toEqual([]);
      const result = await tool.invoke(new RunContext(), "{}", { toolCall: { callId } } as never);
      expect(result).toMatchObject({ isError: true });
      expect(text(result)).toBe(
        "The tool was not called because its arguments do not match the tool's input schema: " +
          'missing required property "calendarId"; missing required property "body". ' +
          "Correct the named properties and call the tool again.",
      );
      expect(beginCalls).toEqual([]);
      expect(executions).toEqual([]);
    } finally {
      await prepared.close();
    }
  });

  test(`${path} with valid arguments still asks for approval`, async () => {
    const { prepared, tool, prepareCalls, executions } = await harness();
    try {
      const args = { calendarId: "primary", body: { role: "read" } };
      expect(await tool.needsApproval(new RunContext(), args, "call-valid")).toBe(true);
      expect(prepareCalls).toHaveLength(1);
      expect(prepareCalls[0]!.arguments).toEqual(args);
      expect(executions).toEqual([]);
    } finally {
      await prepared.close();
    }
  });
}

test("an approved call with string-encoded arguments runs exactly the call the person reviewed", async () => {
  const callId = "call-encoded";
  const encoded = { calendarId: "primary", body: JSON.stringify({ role: "write" }) };
  const repaired = { calendarId: "primary", body: { role: "write" } };
  const { prepared, tool, executions, prepareCalls, beginCalls } = await mcpHarness({
    approvedToolCallId: callId,
  });
  try {
    expect(await tool.needsApproval(new RunContext(), encoded, callId)).toBe(true);
    // The review (and its action fingerprint) shows the arguments that will run.
    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]!.arguments).toEqual(repaired);
    const result = await tool.invoke(new RunContext(), JSON.stringify(encoded), {
      toolCall: { callId },
    } as never);
    expect(result).not.toMatchObject({ isError: true });
    expect(beginCalls).toHaveLength(1);
    expect(beginCalls[0]!.arguments).toEqual(prepareCalls[0]!.arguments);
    expect(executions).toEqual([{ name: "create_permission", args: repaired }]);
  } finally {
    await prepared.close();
  }
});

test("an unattended session reports the argument error, not a refused approval", async () => {
  const { prepared, tool, prepareCalls, executions } = await mcpHarness({ unattendedNow: true });
  try {
    const callId = "call-unattended";
    expect(await tool.needsApproval(new RunContext(), { calendarId: "primary" }, callId)).toBe(
      false,
    );
    expect(prepareCalls).toEqual([]);
    const result = await tool.invoke(new RunContext(), JSON.stringify({ calendarId: "primary" }), {
      toolCall: { callId },
    } as never);
    expect(text(result)).toContain(
      "The tool was not called because its arguments do not match the tool's input schema",
    );
    expect(text(result)).toContain('missing required property "body"');
    expect(executions).toEqual([]);
  } finally {
    await prepared.close();
  }
});
