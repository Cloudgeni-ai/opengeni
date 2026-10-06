import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import * as db from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { buildTurnAgent, type BuildTurnAgentDeps } from "../src/activities/agent-turn/agent-build";
import { createTurnContext } from "../src/activities/agent-turn/turn-context";
import {
  createSandboxV2TurnExecution,
  type SandboxV2TurnExecution,
} from "../src/sandbox-v2-execution";
import { shell, type SandboxSessionLike } from "@openai/agents/sandbox";
import type { SandboxV2TurnMachine } from "@opengeni/core";
import type { MachineBackend } from "@opengeni/runtime/sandbox";
import {
  buildOpenGeniAgent,
  buildSandboxV2PreparedFileManifest,
  type ConnectorActionPolicyHooks,
  prefixedMcpToolName,
  prepareAgentTools,
  restoreInterruptedRunState,
  runAgentStream,
} from "@opengeni/runtime";
import { ScriptedModel, functionCall, startTestMcpServer, testSettings } from "@opengeni/testing";

// Execute the production builder. Only unrelated persistence is stubbed; MCP
// preparation, agent construction, approval interruption and replay remain real.
async function buildWorkerAgent(
  modelRunSettings: Settings,
  mcpServers: Settings["mcpServers"],
  prepared: Awaited<ReturnType<typeof prepareAgentTools>>,
  hooks: ConnectorActionPolicyHooks,
  model: ScriptedModel,
  approvedToolCallId?: string,
  nativeTurn?: SandboxV2TurnExecution,
) {
  const context = createTurnContext({ settings: modelRunSettings, cancellationRequestedAt: null });
  if (nativeTurn) context.sandboxState.nativeTurn = nativeTurn;
  context.eventing.preparedTools = prepared;
  const persistence = [
    spyOn(db, "getSandboxRecoveryDiscontinuity").mockResolvedValue(null),
    spyOn(db, "getWorkspaceVideoGenerationPolicy").mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      fundingSource: "workspace_gateway",
      enabledModelIds: [],
      defaultModelId: null,
    }),
    spyOn(db, "ensureSessionSkillCatalog").mockImplementation(async (_db, input) => input.catalog),
    spyOn(db, "getExternalLinkTurnAuthorization").mockResolvedValue(null),
  ];
  const builtSettings: Settings[] = [];
  try {
    // No sandbox, media, rig or database behavior is exercised by this fixture.
    const deps: Partial<BuildTurnAgentDeps> = {
      ...context,
      input: {
        accountId: "account",
        workspaceId: "workspace",
        sessionId: "session",
        attemptId: "attempt",
        workflowId: "workflow",
        workflowRunId: "workflow-run",
        trigger: { kind: "next" },
      },
      db: {} as BuildTurnAgentDeps["db"],
      runtime: {
        buildAgent: (settings: Settings, resources, options) => {
          builtSettings.push(settings);
          return buildOpenGeniAgent(settings, resources, { ...options, model });
        },
      } as BuildTurnAgentDeps["runtime"],
      observability: createObservability(modelRunSettings, { component: "worker" }),
      objectStorage: null,
      media: {} as BuildTurnAgentDeps["media"],
      turn: {
        id: "turn",
        executionGeneration: 1,
        reasoningEffort: "low",
      } as BuildTurnAgentDeps["turn"],
      session: { id: "session" } as BuildTurnAgentDeps["session"],
      runSettings: modelRunSettings,
      mcpServers,
      skillCatalog: [],
      turnExecutionPolicy: {
        providerId: "openai",
        latencyMode: "standard",
      } as BuildTurnAgentDeps["turnExecutionPolicy"],
      runtimeResources: [],
      sandboxEnvironment: {},
      sandboxArtifactRuntime: { available: false, environment: {} },
      fileResourceDownloads: [],
      attemptConnectorActionBindings: [],
      connectorActionPolicy: hooks,
      modelInputPolicy: { inputFileMediaTypes: [], supportsImageInput: true },
      preparationIndependentToolNames: [],
      groupBoxBackend: "none",
      postToolPreparationStartedAt: performance.now(),
      trigger: (approvedToolCallId
        ? {
            type: "user.approvalDecision",
            payload: { decision: "approve", approvalId: approvedToolCallId },
          }
        : { type: "user.message", payload: {} }) as BuildTurnAgentDeps["trigger"],
    };
    const result = await buildTurnAgent(deps as BuildTurnAgentDeps);
    expect(builtSettings).toHaveLength(1);
    expect(builtSettings[0]!.mcpServers).toEqual(mcpServers);
    expect({ ...builtSettings[0], mcpServers: modelRunSettings.mcpServers }).toEqual(
      modelRunSettings,
    );
    return result.agent;
  } finally {
    for (const spy of persistence) spy.mockRestore();
  }
}

test("ordinary worker builder consumes the exact prepared native owner and keeps normal model/approval configuration", async () => {
  const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });
  const instance = {
    id: "synthetic-native",
    bootId: "a".repeat(64),
    diskLineage: crypto.randomUUID(),
  };
  let execs = 0;
  let machineStops = 0;
  const session: SandboxSessionLike = {
    state: {
      kind: "machine-v2",
      machineId: "synthetic-machine",
      instance,
      manifest: buildSandboxV2PreparedFileManifest([]),
    },
    execCommand: async () => {
      execs++;
      return "synthetic worker reply";
    },
    supportsPty: () => false,
    stop: async () => {
      machineStops++;
    },
  };
  const machine: SandboxV2TurnMachine = {
    engine: "machine-v2",
    authority: {
      accountId: "account",
      workspaceId: "workspace",
      sessionId: "session",
      turnId: "turn",
      attemptId: "attempt",
      executionGeneration: 1,
      machineId: "synthetic-machine",
      instance,
    },
    provider: "synthetic",
    capabilities: { stdin: false, pty: false },
    transport: {
      exec: async () => {
        throw Error("SDK-bound session owns this synthetic invocation");
      },
    },
    releaseRevoked: async () => false,
  };
  const owner = createSandboxV2TurnExecution(
    {} as db.Database,
    machine,
    { session, capabilities: [shell()] },
    new Map([
      [
        "synthetic",
        {
          backend: { provider: "synthetic" } as MachineBackend,
          transport: machine.transport,
        },
      ],
    ]),
  );
  const prepared = await prepareAgentTools(settings, []);
  const model = new ScriptedModel([
    { output: [functionCall("exec_command", { cmd: "printf synthetic" }, "worker-native-call")] },
    { outputText: "completed" },
  ]);
  try {
    const hooks: ConnectorActionPolicyHooks = {
      prepare: async () => ({ managed: false }),
      begin: async () => ({ allowed: true, managed: false }),
      complete: async () => {},
    };
    const agent = await buildWorkerAgent(settings, [], prepared, hooks, model, undefined, owner);
    const stream = await runAgentStream(agent, "ordinary native turn", settings);
    for await (const event of stream) void event;
    await stream.completed;
    expect(stream.finalOutput).toBe("completed");
    expect(execs).toBe(1);
    expect(machineStops).toBe(0);
    expect(model.calls).toBe(2);
  } finally {
    owner.invocations.cancel();
    await owner.invocations.waitForDrain();
    await prepared.close();
  }
});

test.each(["approve", "reject", "legacy approve", "legacy reject"] as const)(
  "account-qualified worker calls interrupt and %s after reconstruction",
  async (decision) => {
    const approve = decision.endsWith("approve");
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
    const hooks: ConnectorActionPolicyHooks = {
      prepare: async () => ({ managed: true as const, decision: "ask" as const }),
      begin: async (call) => {
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
      const settings = canonical;
      const callId = "account-call";
      const agent = await buildWorkerAgent(
        settings,
        routed.mcpServers,
        prepared,
        hooks,
        new ScriptedModel([
          {
            output: [
              functionCall(
                decision.startsWith("legacy")
                  ? createHash("sha256")
                      .update(JSON.stringify([serverId, "search_documents"]))
                      .digest("hex")
                  : prefixedMcpToolName(serverId, "search_documents"),
                { query: "example" },
                callId,
              ),
            ],
          },
          { outputText: "done" },
        ]),
      );
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
      const resumedAgent = await buildWorkerAgent(
        settings,
        routed.mcpServers,
        prepared,
        hooks,
        new ScriptedModel("done"),
        approve ? callId : undefined,
      );
      const restored = await restoreInterruptedRunState(resumedAgent, serialized);
      const [interruption] = restored.getInterruptions();
      if (!interruption) throw new Error("missing approval");
      if (approve) restored.approve(interruption);
      else restored.reject(interruption);
      const resumed = await runAgentStream(resumedAgent, restored, settings);
      for await (const _event of resumed.toStream()) {
        /* consume terminal result */
      }
      await resumed.completed;
      expect(resumed.interruptions).toHaveLength(0);
      expect(mcp.calls).toEqual(
        approve ? [{ tool: "search_documents", args: { query: "example" } }] : [],
      );
      expect(otherMcp.calls).toHaveLength(0);
      expect(acceptedCalls).toEqual(approve ? [`${serverId}:connection-1:${callId}`] : []);
    } finally {
      await prepared.close();
      mcp.close();
      otherMcp.close();
    }
  },
);
