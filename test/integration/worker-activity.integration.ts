import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendSessionEvents,
  appendSessionEventsAndUpdateSession,
  completeFileUpload,
  createTurn,
  createDb,
  createFileUpload,
  createScheduledTask,
  createSession,
  finishTurn,
  getSession,
  getLatestRunState,
  listSessionEvents,
  listScheduledTaskRuns,
  requireScheduledTask,
  saveRunState,
  setSessionStatus,
} from "@infra-agents/db";
import { createNatsEventBus, type EventBus } from "@infra-agents/events";
import { createProductionAgentRuntime, type InfraAgentRuntime } from "@infra-agents/runtime";
import { createActivities } from "../../apps/worker/src/activities";
import { sandboxEnvironmentForRun } from "../../apps/worker/src/activities/environment";
import { ScriptedModel, functionCall, latestStatus, startTestMcpServer, startTestServices, testSettings, type TestServices } from "@infra-agents/testing";

describe("worker activities integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;
  let bus: EventBus;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
    bus = await createNatsEventBus(services.natsUrl);
  }, 180_000);

  afterAll(async () => {
    await bus?.close();
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("streams scripted SDK model deltas into persisted session events", async () => {
    const session = await createSession(dbClient.db, {
      initialMessage: "run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "hello from model", chunks: ["hello ", "from ", "model"] }]),
      }),
    });

    const result = await activities.runAgentSegment({
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-activity",
    });
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, session.id, 0, 50);
    expect(events.some((event) => event.type === "agent.message.delta")).toBe(true);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(latestStatus(events)).toBe("idle");
    expect((await getSession(dbClient.db, session.id))?.status).toBe("idle");
    expect(await getLatestRunState(dbClient.db, session.id)).not.toBeNull();
  });

  test("uses saved SDK history for follow-up turns", async () => {
    const model = new ScriptedModel([
      { outputText: "first answer", chunks: ["first ", "answer"] },
      { outputText: "second answer", chunks: ["second ", "answer"] },
    ]);
    const session = await createSession(dbClient.db, {
      initialMessage: "first question",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    const [firstTrigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "first question" } },
    ]);
    await activities.runAgentSegment({
      sessionId: session.id,
      triggerEventId: firstTrigger!.id,
      workflowId: "workflow-followup",
    });
    const [secondTrigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "second question" } },
    ]);
    await activities.runAgentSegment({
      sessionId: session.id,
      triggerEventId: secondTrigger!.id,
      workflowId: "workflow-followup",
    });

    expect(model.calls).toBe(2);
    const secondRequest = JSON.stringify(model.requests[1]?.input ?? {});
    expect(secondRequest).toContain("first question");
    expect(secondRequest).toContain("first answer");
    expect(secondRequest).toContain("second question");
  });

  test("adds per-turn file resource paths to model text", async () => {
    const fileId = crypto.randomUUID();
    const upload = await createFileUpload(dbClient.db, {
      fileId,
      filename: "diagram.png",
      safeFilename: "diagram.png",
      contentType: "image/png",
      sizeBytes: 4,
      bucket: "infra-agents-files",
      objectKey: `files/${fileId}/original/diagram.png`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await completeFileUpload(dbClient.db, upload.uploadId);
    const model = new ScriptedModel([{ outputText: "saw image", chunks: ["saw ", "image"] }]);
    const resource = { kind: "file" as const, fileId, mountPath: `files/${fileId}` };
    const session = await createSession(dbClient.db, {
      initialMessage: "look at this",
      resources: [resource],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "look at this", resources: [resource] } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });

    await activities.runAgentSegment({
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-image-context",
    });

    const request = JSON.stringify(model.requests[0]?.input ?? {});
    expect(request).not.toContain("input_image");
    expect(request).not.toContain("data:image/png");
    expect(request).toContain("look at this");
    expect(request).toContain("Attached files are available in the sandbox");
    expect(request).toContain(`diagram.png (image/png, 4 bytes): /workspace/files/${fileId}/diagram.png`);
  });

  test("does not require object storage reads for attached file path context", async () => {
    const fileId = crypto.randomUUID();
    const upload = await createFileUpload(dbClient.db, {
      fileId,
      filename: "large.png",
      safeFilename: "large.png",
      contentType: "image/png",
      sizeBytes: 10,
      bucket: "infra-agents-files",
      objectKey: `files/${fileId}/original/large.png`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await completeFileUpload(dbClient.db, upload.uploadId);
    const model = new ScriptedModel([{ outputText: "noted", chunks: ["noted"] }]);
    const resource = { kind: "file" as const, fileId, mountPath: `files/${fileId}` };
    const session = await createSession(dbClient.db, {
      initialMessage: "look at this",
      resources: [resource],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "look at this", resources: [resource] } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });

    await activities.runAgentSegment({
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-oversized-image-context",
    });

    const request = JSON.stringify(model.requests[0]?.input ?? {});
    expect(request).not.toContain("input_image");
    expect(request).not.toContain("direct model vision context");
    expect(request).toContain(`/workspace/files/${fileId}/large.png`);
  });

  test("marks session failed when scripted model throws", async () => {
    const session = await createSession(dbClient.db, {
      initialMessage: "fail",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "fail" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error: new Error("scripted failure") }]),
      }),
    });

    await expect(activities.runAgentSegment({
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-fail",
    })).resolves.toEqual({ status: "failed" });
    const events = await listSessionEvents(dbClient.db, session.id, 0, 50);
    expect(events.some((event) => event.type === "turn.failed")).toBe(true);
    expect((await getSession(dbClient.db, session.id))?.status).toBe("failed");
  });

  test("marks approval reruns running before resuming the agent", async () => {
    const workflowId = "workflow-approval-rerun";
    const session = await createSession(dbClient.db, {
      initialMessage: "needs approval",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [initialTrigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.message", payload: { text: "needs approval" } },
    ]);
    const turnId = await createTurn(dbClient.db, {
      sessionId: session.id,
      temporalWorkflowId: workflowId,
      triggerEventId: initialTrigger!.id,
      source: "user",
      prompt: "needs approval",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "high",
      sandboxBackend: "none",
      metadata: {},
    });
    await finishTurn(dbClient.db, turnId, "requires_action");
    await saveRunState(dbClient.db, {
      sessionId: session.id,
      turnId,
      serializedRunState: "saved-state",
      pendingApprovals: [{ id: "approval-1" }],
    });
    await setSessionStatus(dbClient.db, session.id, "requires_action", turnId);
    const [approvalTrigger] = await appendSessionEvents(dbClient.db, session.id, [
      { type: "user.approvalDecision", payload: { approvalId: "approval-1", decision: "approve" } },
    ]);
    let observedDuringRun: { status?: string; activeTurnId?: string | null } | null = null;
    const runtime: InfraAgentRuntime = {
      configure: () => {},
      buildAgent: () => ({} as never),
      prepareTools: async () => ({ mcpServers: [], close: async () => {} }),
      prepareInput: async (_agent, input) => {
        expect(input.kind).toBe("approval");
        return { input: "approved" };
      },
      runStream: async () => {
        const stored = await getSession(dbClient.db, session.id);
        observedDuringRun = {
          status: stored?.status,
          activeTurnId: stored?.activeTurnId,
        };
        return {
          toStream: () => (async function* () {})(),
          completed: Promise.resolve(),
          interruptions: [],
          state: { toString: () => "resumed-state" },
          finalOutput: "approved",
        } as never;
      },
      serializeApprovals: () => [],
    };
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime,
    });

    await expect(activities.runAgentSegment({
      sessionId: session.id,
      triggerEventId: approvalTrigger!.id,
      workflowId,
      turnId,
    })).resolves.toEqual({ status: "idle" });

    expect(observedDuringRun).toEqual({ status: "running", activeTurnId: turnId });
    expect((await getSession(dbClient.db, session.id))?.status).toBe("idle");
  });

  test("sets Docker and Modal sandbox home defaults", async () => {
    const docker = await sandboxEnvironmentForRun(testSettings({ sandboxBackend: "docker" }), []);
    const modal = await sandboxEnvironmentForRun(testSettings({ sandboxBackend: "modal" }), []);
    const disabled = await sandboxEnvironmentForRun(testSettings({ sandboxBackend: "none" }), []);

    expect(docker.HOME).toBe("/workspace");
    expect(docker.AZURE_CONFIG_DIR).toBe("/workspace/.azure");
    expect(modal.HOME).toBe("/workspace");
    expect(modal.AZURE_CONFIG_DIR).toBe("/workspace/.azure");
    expect(disabled.HOME).toBeUndefined();
    expect(disabled.AZURE_CONFIG_DIR).toBeUndefined();
  });

  test("attaches configured MCP tools and executes a prefixed tool call during a run", async () => {
    const mcp = startTestMcpServer();
    try {
      const model = new ScriptedModel([
        {
          output: [
            functionCall("docs__search_documents", { query: "network policy" }, "call-doc-search"),
          ],
        },
        {
          outputText: "used document search",
          chunks: ["used ", "document ", "search"],
        },
      ]);
      const session = await createSession(dbClient.db, {
        initialMessage: "search docs",
        resources: [],
        tools: [{ kind: "mcp", id: "docs" }],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      const [trigger] = await appendSessionEvents(dbClient.db, session.id, [
        { type: "user.message", payload: { text: "search docs" } },
      ]);
      const activities = createActivities({
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          natsUrl: services.natsUrl,
          mcpServers: [{
            id: "docs",
            name: "Document Search",
            url: mcp.url,
            allowedTools: ["search_documents"],
            cacheToolsList: false,
          }],
        }),
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });

      const result = await activities.runAgentSegment({
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-mcp",
      });

      expect(result.status).toBe("idle");
      expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "network policy" } }]);
      expect(JSON.stringify(model.requests[0])).toContain("docs__search_documents");
      expect(JSON.stringify(model.requests[0])).not.toContain("docs__fetch_document");
      const events = await listSessionEvents(dbClient.db, session.id, 0, 50);
      expect(events.some((event) => event.type === "agent.toolCall.created")).toBe(true);
      expect(events.some((event) => event.type === "agent.toolCall.output")).toBe(true);
      expect(latestStatus(events)).toBe("idle");
    } finally {
      mcp.close();
    }
  });

  test("uses MCP tools added by a follow-up turn", async () => {
    const mcp = startTestMcpServer();
    try {
      const model = new ScriptedModel([
        {
          output: [
            functionCall("docs__search_documents", { query: "network policy" }, "call-doc-search"),
          ],
        },
        {
          outputText: "used follow-up document search",
          chunks: ["used ", "follow-up ", "document ", "search"],
        },
      ]);
      const session = await createSession(dbClient.db, {
        initialMessage: "start",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      const [trigger] = await appendSessionEventsAndUpdateSession(dbClient.db, session.id, [
        {
          type: "user.message",
          payload: {
            text: "search docs now",
            tools: [{ kind: "mcp", id: "docs" }],
          },
        },
      ], {
        tools: [{ kind: "mcp", id: "docs" }],
      });
      const activities = createActivities({
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          natsUrl: services.natsUrl,
          mcpServers: [{
            id: "docs",
            name: "Document Search",
            url: mcp.url,
            allowedTools: ["search_documents"],
            cacheToolsList: false,
          }],
        }),
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });

      const result = await activities.runAgentSegment({
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-follow-up-mcp",
      });

      expect(result.status).toBe("idle");
      expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "network policy" } }]);
      expect(JSON.stringify(model.requests[0])).toContain("docs__search_documents");
    } finally {
      mcp.close();
    }
  });

  test("dispatches scheduled tasks into new sessions and run history", async () => {
    const task = await createScheduledTask(dbClient.db, {
      name: "scheduled-new-session",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "inspect nightly",
        resources: [],
        tools: [{ kind: "mcp", id: "docs" }],
        metadata: { source: "test" },
      },
      metadata: {},
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        mcpServers: [{ id: "docs", url: "http://127.0.0.1:1/mcp", name: "Docs" }],
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    const result = await activities.dispatchScheduledTaskRun({ taskId: task.id, triggerType: "scheduled" });

    expect(result.action).toBe("start");
    expect(result.workflowId).toBe(`session-${result.sessionId}`);
    const session = await getSession(dbClient.db, result.sessionId);
    expect(session?.metadata).toMatchObject({ scheduledTaskId: task.id, source: "test" });
    expect(session?.tools).toEqual([{ kind: "mcp", id: "docs" }]);
    const events = await listSessionEvents(dbClient.db, result.sessionId, 0, 10);
    expect(events.map((event) => event.type)).toEqual(["session.created", "user.message", "session.status.changed", "turn.queued"]);
    expect(events.find((event) => event.type === "user.message")?.payload).toMatchObject({ text: "inspect nightly", scheduledTaskId: task.id });
    const [run] = await listScheduledTaskRuns(dbClient.db, task.id);
    expect(run).toMatchObject({ status: "dispatched", sessionId: result.sessionId, triggerEventId: result.triggerEventId });
  });

  test("dispatches reusable scheduled tasks by signaling the stored session", async () => {
    const task = await createScheduledTask(dbClient.db, {
      name: "scheduled-reusable",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "follow up",
        resources: [],
        tools: [{ kind: "mcp", id: "docs" }],
        metadata: {},
      },
      metadata: {},
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        mcpServers: [{ id: "docs", url: "http://127.0.0.1:1/mcp", name: "Docs" }],
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    const first = await activities.dispatchScheduledTaskRun({ taskId: task.id, triggerType: "scheduled" });
    const stored = await requireScheduledTask(dbClient.db, task.id);
    const second = await activities.dispatchScheduledTaskRun({ taskId: task.id, triggerType: "manual" });

    expect(first.action).toBe("start");
    expect(second.action).toBe("signal");
    expect(second.sessionId).toBe(first.sessionId);
    expect(stored.reusableSessionId).toBe(first.sessionId);
    const events = await listSessionEvents(dbClient.db, first.sessionId, 0, 10);
    expect(events.filter((event) => event.type === "user.message")).toHaveLength(2);
    const runs = await listScheduledTaskRuns(dbClient.db, task.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "dispatched")).toBe(true);
  });
});
