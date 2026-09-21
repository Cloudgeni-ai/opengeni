import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSync, type Node } from "oxc-parser";
import type { Settings } from "@opengeni/config";
import {
  buildOpenGeniAgent,
  prefixedMcpToolName,
  prepareAgentTools,
  restoreInterruptedRunState,
  runAgentStream,
} from "@opengeni/runtime";
import { ScriptedModel, functionCall, startTestMcpServer, testSettings } from "@opengeni/testing";

// Exercise the real worker's settings expression, not a second hand-written
// approximation of the boundary that lost account-qualified approval policy.
function modelSettingsAtBuild(
  modelRunSettings: Settings,
  mcpServers: Settings["mcpServers"],
): Settings {
  const source = readFileSync(
    new URL("../src/activities/agent-turn/agent-build.ts", import.meta.url),
    "utf8",
  );
  const parsed = parseSync("agent-build.ts", source);
  expect(parsed.errors).toEqual([]);
  const expressions: string[] = [];
  const visit = (node: Node): void => {
    if (
      node.type === "CallExpression" &&
      source.slice(node.callee.start, node.callee.end) === "runtime.buildAgent"
    ) {
      const argument = node.arguments[0]!;
      expressions.push(source.slice(argument.start, argument.end));
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child === "object" && "type" in child) visit(child as Node);
      } else if (value && typeof value === "object" && "type" in value) visit(value as Node);
    }
  };
  visit(parsed.program);
  expect(expressions).toHaveLength(1);
  return new Function("eventing", "mcpServers", `return (${expressions[0]});`)(
    { modelRunSettings },
    mcpServers,
  );
}

test.each(["approve", "reject"] as const)(
  "account-qualified worker calls interrupt and %s after reconstruction",
  async (decision) => {
    const mcp = startTestMcpServer();
    const otherMcp = startTestMcpServer();
    const serverId = `account-${"a".repeat(64)}`;
    const otherServerId = `account-${"b".repeat(64)}`;
    const canonical = testSettings({
      sandboxBackend: "none",
      webSearchEnabled: false,
      mcpServers: [
        {
          id: "documents",
          url: mcp.url,
          cacheToolsList: false,
          requireApproval: true,
          connectionRef: { connectionId: "connection-1", providerDomain: "example.test" },
        },
      ],
    });
    const routed = {
      ...canonical,
      mcpServers: [
        { ...canonical.mcpServers[0]!, id: serverId },
        {
          ...canonical.mcpServers[0]!,
          id: otherServerId,
          url: otherMcp.url,
          connectionRef: { connectionId: "connection-2", providerDomain: "example.test" },
        },
      ],
    };
    const acceptedCalls: string[] = [];
    const hooks = {
      prepare: async () => ({ managed: true as const, decision: "ask" as const }),
      begin: async (call: { serverId: string; connectionId: string; approvalId: string }) => {
        acceptedCalls.push(`${call.serverId}:${call.connectionId}:${call.approvalId}`);
        return {
          allowed: true as const,
          managed: true as const,
          requestId: "request-1",
        };
      },
      complete: async () => {},
    };
    const prepare = () =>
      prepareAgentTools(
        routed,
        [serverId, otherServerId].map((id) => ({ kind: "mcp", id })),
        {
          accountId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          sessionId: "33333333-3333-4333-8333-333333333333",
          turnId: "44444444-4444-4444-8444-444444444444",
          attemptId: "55555555-5555-4555-8555-555555555555",
          executionGeneration: 1,
          credentialSubjectId: "subject-a",
          resolveCredential: async (request) => ({
            status: "ok" as const,
            connectionId: request.serverId === serverId ? "connection-1" : "connection-2",
            headers: { authorization: "Bearer synthetic-token" },
          }),
          connectorActionPolicy: hooks,
        },
      );
    let prepared = await prepare();
    try {
      const settings = modelSettingsAtBuild(canonical, routed.mcpServers);
      const callId = "account-call";
      const agent = buildOpenGeniAgent(settings, [], {
        model: new ScriptedModel([
          {
            output: [
              functionCall(
                prefixedMcpToolName(serverId, "search_documents"),
                { query: "example" },
                callId,
              ),
            ],
          },
          { outputText: "done" },
        ]),
        hostedWebSearch: false,
        mcpServers: prepared.mcpServers,
        resolvedMcpConnectionIds: prepared.resolvedMcpConnectionIds,
        connectorActionPolicy: hooks,
      });
      const result = await runAgentStream(agent, "Search documents", settings);
      for await (const _event of result.toStream()) {
        /* consume through interruption */
      }
      await result.completed;
      expect(mcp.calls).toHaveLength(0);
      expect(result.interruptions).toHaveLength(1);
      expect(otherMcp.calls).toHaveLength(0);
      // Rebuild both the gateway and agent: no in-memory approval Set survives.
      const serialized = result.state.toString();
      await prepared.close();
      prepared = await prepare();
      await expect(
        prepared.attemptToolEnvironment!.callModel({
          modelName: prefixedMcpToolName(serverId, "search_documents"),
          arguments: { query: "example" },
          subjectId: "worker:mcp-model",
        }),
      ).rejects.toMatchObject({ code: "approval_required" });
      const resumedAgent = buildOpenGeniAgent(settings, [], {
        model: new ScriptedModel("done"),
        hostedWebSearch: false,
        mcpServers: prepared.mcpServers,
        resolvedMcpConnectionIds: prepared.resolvedMcpConnectionIds,
        connectorActionPolicy: hooks,
        ...(decision === "approve" ? { approvedToolCallId: callId } : {}),
      });
      const restored = await restoreInterruptedRunState(resumedAgent, serialized);
      const [interruption] = restored.getInterruptions();
      if (!interruption) throw new Error("missing approval");
      if (decision === "approve") restored.approve(interruption);
      else restored.reject(interruption);
      const resumed = await runAgentStream(resumedAgent, restored, settings);
      for await (const _event of resumed.toStream()) {
        /* consume terminal result */
      }
      await resumed.completed;
      expect(resumed.interruptions).toHaveLength(0);
      expect(mcp.calls).toEqual(
        decision === "approve" ? [{ tool: "search_documents", args: { query: "example" } }] : [],
      );
      expect(otherMcp.calls).toHaveLength(0);
      expect(acceptedCalls).toEqual(
        decision === "approve" ? [`${serverId}:connection-1:${callId}`] : [],
      );
      expect(settings.mcpServers).toEqual(routed.mcpServers);
      expect({ ...settings, mcpServers: canonical.mcpServers }).toEqual(canonical);
    } finally {
      await prepared.close();
      mcp.close();
      otherMcp.close();
    }
  },
);
