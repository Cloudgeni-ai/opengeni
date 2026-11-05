import { expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { getSettings } from "@opengeni/config";
import {
  buildOpenGeniAgent,
  prepareAgentTools,
  type ConnectorActionPolicyHooks,
  type ConnectorActionToolCall,
} from "@opengeni/runtime";
import { startTestMcpServer } from "@opengeni/testing/mcp";
import { testSettings } from "@opengeni/testing/settings";

import { withSlackBotSendApproval } from "../src/activities/agent-turn/slack-bot-send-approval";

// Through the runtime's own approval hook, as a model's tool call reaches it:
// with Ask first on the person's Slack sends, the bot send waits for approval
// in a chat a person attends and runs at once in a scheduled one.

async function botSendTool(interactive: boolean) {
  const mcp = startTestMcpServer({
    toolsForAuthorization: () => ["slack_bot_send_prepared_message"],
  });
  // The built-in server's own configuration, pointed at the fixture.
  const builtIn = getSettings({}).mcpServers.find((server) => server.id === "opengeni")!;
  const settings = testSettings({
    sandboxBackend: "none",
    mcpServers: [{ ...builtIn, url: mcp.url, cacheToolsList: false }],
  });
  const prepared: ConnectorActionToolCall[] = [];
  const ledger: ConnectorActionPolicyHooks = {
    prepare: async (call) => {
      prepared.push(call);
      return { managed: true, decision: call.defaultDecision ?? "allow" };
    },
    begin: async () => ({ allowed: true, managed: true, requestId: "request-1" }),
    complete: async () => undefined,
  };
  const hooks = withSlackBotSendApproval(ledger, {
    interactive,
    personalSlackSendDecision: async () => "ask",
  });
  const tools = await prepareAgentTools(settings, [{ kind: "mcp", id: "opengeni" }], {
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sessionId: "33333333-3333-4333-8333-333333333333",
    turnId: "44444444-4444-4444-8444-444444444444",
    attemptId: "55555555-5555-4555-8555-555555555555",
    executionGeneration: 1,
    credentialSubjectId: "subject-a",
    connectorActionPolicy: hooks,
  });
  const agent = buildOpenGeniAgent(settings, [], {
    toolPreparationReady: tools.ready,
    mcpServers: tools.mcpServers,
    resolvedMcpConnectionIds: tools.resolvedMcpConnectionIds,
    connectorActionPolicy: hooks,
  });
  const tool = (await agent.getMcpTools(new RunContext())).find(
    (candidate) =>
      candidate.type === "function" && candidate.name.endsWith("slack_bot_send_prepared_message"),
  );
  if (!tool || tool.type !== "function") throw new Error("bot send tool missing");
  return {
    tool,
    prepared,
    close: async () => {
      await tools.close();
      mcp.close();
    },
  };
}

test("in a chat a person attends, a bot send under Ask first waits for approval", async () => {
  const fixture = await botSendTool(true);
  try {
    expect(
      await fixture.tool.needsApproval(new RunContext(), { messageId: crypto.randomUUID() }, "c1"),
    ).toBe(true);
    expect(fixture.prepared[0]).toMatchObject({
      serverId: "opengeni",
      toolName: "slack_bot_send_prepared_message",
      approvalMode: "session_mcp",
      defaultDecision: "ask",
    });
  } finally {
    await fixture.close();
  }
});

test("in a scheduled run, the same bot send runs at once", async () => {
  const fixture = await botSendTool(false);
  try {
    expect(
      await fixture.tool.needsApproval(new RunContext(), { messageId: crypto.randomUUID() }, "c1"),
    ).toBe(false);
    expect(fixture.prepared[0]).toMatchObject({ defaultDecision: "allow" });
    expect(fixture.prepared[0]?.approvalMode).toBeUndefined();
  } finally {
    await fixture.close();
  }
});
