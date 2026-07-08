import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  addDocumentToBase,
  createDocumentBase,
  DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS,
  deterministicEmbedding,
  type DocumentServices,
} from "../../packages/documents/src/index";
import type { ObjectStorage } from "../../packages/storage/src/index";
import {
  appendSessionEvents,
  appendSessionEventsAndUpdateSession,
  appendSessionHistoryItems,
  bootstrapWorkspace,
  completeFileUpload,
  applyCreditLedgerEntry,
  countTurnSessionHistoryItems,
  createTurn,
  createDb,
  createFileUpload,
  createScheduledTask,
  createSession,
  createSessionGoal,
  createWorkspaceEnvironment,
  encryptEnvironmentValue,
  enablePackInstallation,
  enqueueSessionTurn,
  registerWorkspacePack,
  setWorkspaceEnvironmentVariable,
  finishTurn,
  getSession,
  getSessionGoal,
  getBillingBalance,
  getActiveSessionHistoryItems,
  getLatestRunState,
  getSessionHistoryItems,
  setSessionLastInputTokens,
  listSessions,
  listSessionTurns,
  listUsageEvents,
  listSessionEvents,
  listScheduledTaskRuns,
  recordUsageEvent,
  requireScheduledTask,
  saveRunState,
  setSessionStatus,
  sumUsageQuantity,
  updateScheduledTask,
} from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import { createNatsEventBus, type EventBus } from "@opengeni/events";
import { createObservability } from "@opengeni/observability";
import {
  createProductionAgentRuntime,
  MaxTurnsExceededError,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { createActivities } from "../../apps/worker/src/activities";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import {
  CONTEXT_WINDOW_OVERFLOW_RECOVERY_MESSAGE,
  PROVIDER_BACKPRESSURE_DELAY_MS,
  WORKER_DEATH_RESUME_TEXT,
} from "../../apps/worker/src/activities/agent-turn";
import { WORKER_DEATH_MAX_REDISPATCHES } from "../../apps/worker/src/activities/session-state";
import {
  loadWorkspaceEnvironmentForRun,
  sandboxEnvironmentForRun,
} from "../../apps/worker/src/activities/environment";
import { settingsWithSessionMcpServersForRun } from "../../apps/worker/src/activities/capabilities";
import { maybeCompactContext } from "../../apps/worker/src/activities/context-compaction";
import {
  ScriptedModel,
  functionCall,
  latestStatus,
  startTestMcpServer,
  startTestServices,
  testSettings,
  type TestServices,
} from "@opengeni/testing";

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
  }, 120_000);

  test("streams scripted SDK model deltas into persisted session events", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([
          { outputText: "hello from model", chunks: ["hello ", "from ", "model"] },
        ]),
      }),
    });

    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-activity",
    });
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "agent.message.delta")).toBe(true);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(latestStatus(events)).toBe("idle");
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
    expect(await getLatestRunState(dbClient.db, grant.workspaceId, session.id)).not.toBeNull();
  });

  test("overlays per-session MCP servers with decrypted headers before prepareTools", async () => {
    const grant = await testGrant(dbClient.db);
    const encryptionKey = Buffer.alloc(32, 9);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "use session mcp",
      resources: [],
      tools: [{ kind: "mcp", id: "crm" }],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      mcpServers: [
        {
          id: "crm",
          name: "CRM MCP",
          url: "https://crm.example/mcp",
          allowedTools: ["workouts.list"],
          timeoutMs: 3000,
          cacheToolsList: false,
          headersEncrypted: {
            Authorization: encryptEnvironmentValue(encryptionKey, "Bearer run-secret"),
          },
        },
      ],
    });
    let preparedSettings: Parameters<OpenGeniRuntime["prepareTools"]>[0] | null = null;
    const runtime = {
      prepareTools: async (settings: Parameters<OpenGeniRuntime["prepareTools"]>[0]) => {
        preparedSettings = settings;
        return { mcpServers: [], close: async () => {} };
      },
    };
    const runSettings = await settingsWithSessionMcpServersForRun(
      dbClient.db,
      grant.workspaceId,
      session.id,
      testSettings({
        databaseUrl: services.databaseUrl,
        environmentsEncryptionKey: encryptionKey.toString("base64"),
      }),
    );

    await runtime.prepareTools(runSettings);

    expect(preparedSettings?.mcpServers.find((server) => server.id === "crm")).toEqual({
      id: "crm",
      name: "CRM MCP",
      url: "https://crm.example/mcp",
      allowedTools: ["workouts.list"],
      timeoutMs: 3000,
      cacheToolsList: false,
      headers: { Authorization: "Bearer run-secret" },
    });
  });

  test("a requireApproval session MCP tool pauses for approval and resumes on approve", async () => {
    // End-to-end through the GENERIC interruption loop: a session MCP server with
    // requireApproval:true makes its tool raise a run interruption, which the
    // worker turns into session.requiresAction (tool NOT yet executed); a
    // user.approvalDecision:approve then resumes the saved run state and the tool
    // finally runs.
    const encryptionKey = Buffer.alloc(32, 5);
    const mcp = startTestMcpServer();
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      environmentsEncryptionKey: encryptionKey.toString("base64"),
    });
    try {
      const grant = await testGrant(dbClient.db);
      const session = await createOwnedSession(dbClient.db, grant, {
        initialMessage: "search please",
        resources: [],
        tools: [{ kind: "mcp", id: "crm" }],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
        mcpServers: [
          {
            id: "crm",
            name: "CRM",
            url: mcp.url,
            cacheToolsList: false,
            requireApproval: true,
            headersEncrypted: {},
          },
        ],
      });
      const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
        { type: "user.message", payload: { text: "search please" } },
      ]);
      const model = new ScriptedModel([
        {
          id: "approval-call-1",
          output: [
            functionCall("crm__search_documents", { query: "network policy" }, "call-appr-1"),
          ],
        },
        { id: "approval-call-2", outputText: "found it", chunks: ["found ", "it"] },
      ]);
      const activities = createActivities({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });

      // Turn 1: the tool call is gated — the turn pauses instead of running it.
      const first = await activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-mcp-approval",
      });
      expect(first.status).toBe("requires_action");
      const afterFirst = await listSessionEvents(
        dbClient.db,
        grant.workspaceId,
        session.id,
        0,
        100,
      );
      expect(afterFirst.some((event) => event.type === "session.requiresAction")).toBe(true);
      expect(latestStatus(afterFirst)).toBe("requires_action");
      // The MCP tool did NOT execute while approval is pending.
      expect(mcp.calls).toEqual([]);

      const activeTurnId = (await getSession(dbClient.db, grant.workspaceId, session.id))
        ?.activeTurnId;
      expect(activeTurnId).toBeTruthy();

      // Turn 2: approve → the saved run resumes and the tool finally runs.
      const [approvalTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
        {
          type: "user.approvalDecision",
          payload: { approvalId: "call-appr-1", decision: "approve" },
        },
      ]);
      const second = await activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: approvalTrigger!.id,
        // Distinct workflowId so the resume's event producerId
        // (`${workflowId}:${turnId}`) does not collide with turn 1's — the real
        // system disambiguates via the Temporal activityId, which is absent here.
        workflowId: "workflow-mcp-approval-resume",
        turnId: activeTurnId!,
      });
      expect(second.status).toBe("idle");
      expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "network policy" } }]);
      const afterSecond = await listSessionEvents(
        dbClient.db,
        grant.workspaceId,
        session.id,
        0,
        100,
      );
      expect(afterSecond.some((event) => event.type === "turn.completed")).toBe(true);
      expect(latestStatus(afterSecond)).toBe("idle");
    } finally {
      mcp.close();
    }
  });

  test("manager session's first-party MCP token carries its granted permissions end to end", async () => {
    // A manager-style session (created with firstPartyMcpPermissions) calls
    // the workspace-orchestration tools through its own first-party MCP
    // connection - the exact wiring the live manager probe uses.
    const noopWorkflowClient: SessionWorkflowClient = {
      signalUserMessage: async () => undefined,
      wakeSessionWorkflow: async () => undefined,
      signalApprovalDecision: async () => undefined,
      signalInterrupt: async () => undefined,
      syncScheduledTask: async () => undefined,
      deleteScheduledTaskSchedule: async () => undefined,
      triggerScheduledTask: async () => undefined,
    };
    const grant = await testGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const apiSettings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      productAccessMode: "configured",
      delegationSecret,
    });
    const app = createApp({
      settings: apiSettings,
      db: dbClient.db,
      bus,
      workflowClient: noopWorkflowClient,
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const settings = {
        ...apiSettings,
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
            timeoutMs: undefined,
            cacheToolsList: false,
          },
        ],
      };
      const model = new ScriptedModel([
        {
          id: "manager-call-1",
          output: [functionCall("opengeni__sessions_list", { limit: 10 }, "call-manager-1")],
        },
        { id: "manager-call-2", outputText: "fleet listed", chunks: ["fleet ", "listed"] },
      ]);
      const session = await createOwnedSession(dbClient.db, grant, {
        initialMessage: "list the fleet",
        resources: [],
        tools: [{ kind: "mcp", id: "opengeni" }],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
        firstPartyMcpPermissions: ["workspace:read", "sessions:read", "sessions:create"],
      });
      const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
        { type: "user.message", payload: { text: "list the fleet" } },
      ]);
      const activities = createActivities({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });
      const result = await activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-manager-mcp",
      });
      expect(result.status).toBe("idle");
      // The sessions_list result (containing this very session) was fed back
      // to the model: the tool call resolved against the live MCP endpoint
      // with a token carrying the session's permission set.
      expect(model.calls).toBe(2);
      const followupInput = JSON.stringify(
        (model.requests.at(-1) as { input?: unknown })?.input ?? "",
      );
      expect(followupInput).toContain(session.id);
      const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
      expect(events.some((event) => event.type === "turn.completed")).toBe(true);
      expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("session_create links the spawned worker to the manager via the caller's session claim", async () => {
    // A manager session calls session_create through its OWN first-party MCP
    // token. That token carries the manager's session id as a worker-signed
    // claim, so the spawned worker records parent_session_id = manager — no
    // explicit parameter, no way for the agent to forge a different parent.
    const noopWorkflowClient: SessionWorkflowClient = {
      signalUserMessage: async () => undefined,
      wakeSessionWorkflow: async () => undefined,
      signalApprovalDecision: async () => undefined,
      signalInterrupt: async () => undefined,
      syncScheduledTask: async () => undefined,
      deleteScheduledTaskSchedule: async () => undefined,
      triggerScheduledTask: async () => undefined,
    };
    const grant = await testGrant(dbClient.db);
    const delegationSecret = "test-delegation-secret";
    const apiSettings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      productAccessMode: "configured",
      delegationSecret,
    });
    const app = createApp({
      settings: apiSettings,
      db: dbClient.db,
      bus,
      workflowClient: noopWorkflowClient,
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const settings = {
        ...apiSettings,
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
            timeoutMs: undefined,
            cacheToolsList: false,
          },
        ],
      };
      const model = new ScriptedModel([
        {
          id: "spawn-1",
          output: [
            functionCall(
              "opengeni__session_create",
              { initialMessage: "worker: reply ready then goal_complete", sandboxBackend: "none" },
              "call-spawn-1",
            ),
          ],
        },
        { id: "spawn-2", outputText: "worker spawned", chunks: ["worker ", "spawned"] },
      ]);
      const manager = await createOwnedSession(dbClient.db, grant, {
        initialMessage: "spawn a worker",
        resources: [],
        tools: [{ kind: "mcp", id: "opengeni" }],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
        firstPartyMcpPermissions: ["workspace:read", "sessions:read", "sessions:create"],
      });
      const [trigger] = await appendOwnedEvents(dbClient.db, grant, manager.id, [
        { type: "user.message", payload: { text: "spawn a worker" } },
      ]);
      const activities = createActivities({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });
      await activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: manager.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-spawn-link",
      });
      // The manager created exactly one other session: the spawned worker.
      const allSessions = await listSessions(dbClient.db, grant.workspaceId, 50);
      const worker = allSessions.find((candidate) => candidate.id !== manager.id);
      expect(worker).toBeDefined();
      expect(worker?.parentSessionId).toBe(manager.id);
    } finally {
      server.stop(true);
    }
  });

  test("uses saved SDK history for follow-up turns", async () => {
    const model = new ScriptedModel([
      { outputText: "first answer", chunks: ["first ", "answer"] },
      { outputText: "second answer", chunks: ["second ", "answer"] },
    ]);
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
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
    const [firstTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "first question" } },
    ]);
    await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: firstTrigger!.id,
      workflowId: "workflow-followup",
    });
    const [secondTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "second question" } },
    ]);
    await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
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
    const grant = await testGrant(dbClient.db);
    const fileId = crypto.randomUUID();
    const upload = await createOwnedFileUpload(dbClient.db, grant, {
      fileId,
      filename: "diagram.png",
      safeFilename: "diagram.png",
      contentType: "image/png",
      sizeBytes: 4,
      bucket: "opengeni-files",
      objectKey: `workspaces/${grant.workspaceId}/files/${fileId}/original/diagram.png`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await completeFileUpload(dbClient.db, grant.workspaceId, upload.uploadId);
    const model = new ScriptedModel([{ outputText: "saw image", chunks: ["saw ", "image"] }]);
    const resource = { kind: "file" as const, fileId, mountPath: `files/${fileId}` };
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "look at this",
      resources: [resource],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "look at this", resources: [resource] } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });

    await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-image-context",
    });

    const request = JSON.stringify(model.requests[0]?.input ?? {});
    expect(request).not.toContain("input_image");
    expect(request).not.toContain("data:image/png");
    expect(request).toContain("look at this");
    expect(request).toContain("Attached files are available in the sandbox");
    expect(request).toContain(
      `diagram.png (image/png, 4 bytes): /workspace/files/${fileId}/diagram.png`,
    );
  });

  test("does not require object storage reads for attached file path context", async () => {
    const grant = await testGrant(dbClient.db);
    const fileId = crypto.randomUUID();
    const upload = await createOwnedFileUpload(dbClient.db, grant, {
      fileId,
      filename: "large.png",
      safeFilename: "large.png",
      contentType: "image/png",
      sizeBytes: 10,
      bucket: "opengeni-files",
      objectKey: `workspaces/${grant.workspaceId}/files/${fileId}/original/large.png`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await completeFileUpload(dbClient.db, grant.workspaceId, upload.uploadId);
    const model = new ScriptedModel([{ outputText: "noted", chunks: ["noted"] }]);
    const resource = { kind: "file" as const, fileId, mountPath: `files/${fileId}` };
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "look at this",
      resources: [resource],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "look at this", resources: [resource] } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });

    await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-oversized-image-context",
    });

    const request = JSON.stringify(model.requests[0]?.input ?? {});
    expect(request).not.toContain("input_image");
    expect(request).not.toContain("direct model vision context");
    expect(request).toContain(`/workspace/files/${fileId}/large.png`);
  });

  test("fails the turn plainly when two enabled packs declare sandbox images", async () => {
    const grant = await testGrant(dbClient.db);
    const imagePack = (id: string, image: string) => ({
      id,
      name: `Pack ${id}`,
      description: "Image-declaring pack for runtime composition tests.",
      role: "infrastructure",
      category: "infrastructure",
      version: "0.1.0",
      sandboxImage: image,
      skills: [],
      tools: [],
      connectors: [],
      knowledge: [],
      scheduledTaskTemplates: [],
      metadata: {},
    });
    for (const [packId, image] of [
      ["img-a", "example.com/a@sha256:aaaa"],
      ["img-b", "example.com/b@sha256:bbbb"],
    ] as const) {
      await registerWorkspacePack(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        pack: imagePack(packId, image),
      });
      await enablePackInstallation(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        packId,
        metadata: {},
      });
    }
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "should not run", chunks: ["never"] }]),
      }),
    });

    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-pack-image-conflict",
    });
    expect(result.status).toBe("failed");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const failure = events.find((event) => event.type === "turn.failed");
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure!.payload)).toContain(
      "Multiple enabled packs declare a sandbox image (img-a, img-b)",
    );
    expect(latestStatus(events)).toBe("failed");
  });

  test("marks session failed when scripted model throws", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "fail",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
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

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-fail",
      }),
    ).resolves.toEqual({ status: "failed" });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "turn.failed")).toBe(true);
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("failed");
  });

  test("context overflow before model/tool progress compacts and retries once in-activity", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "overflow then retry",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "old context" } },
        {
          position: 1,
          item: { type: "message", role: "assistant", content: "x".repeat(100_000 * 4) },
        },
      ],
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "overflow then retry" } },
    ]);
    const model = new ScriptedModel([
      { error: contextOverflowError("Your input exceeds the context window of this model.") },
      { outputText: "recovered", chunks: ["recovered"] },
    ]);
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
        contextCompactionMode: "client",
      }),
      db: dbClient.db,
      bus,
      runtime: runtimeWithFakeCompactionSummarizer(model, "overflow recovery summary"),
    });

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-overflow-retry",
      }),
    ).resolves.toEqual({ status: "idle" });

    expect(model.calls).toBe(2);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 80);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(events.some((event) => event.type === "session.context.compacted")).toBe(true);
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
  });

  test("goal continuation over threshold compacts through rendered Responses input and continues", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "goal context",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "deploy the app" } },
        {
          position: 1,
          item: {
            type: "function_call",
            callId: "call_vern",
            name: "opengeni__sessions_list",
            arguments: "{}",
          },
        },
        {
          position: 2,
          item: {
            type: "function_call_result",
            callId: "call_vern",
            status: "completed",
            output: "ok",
          },
        },
        {
          position: 3,
          item: { type: "message", role: "assistant", content: "x".repeat(80_000 * 4) },
        },
      ],
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "goal.continuation", payload: { text: "continue the goal" } },
    ]);
    const model = new ScriptedModel([{ outputText: "continued", chunks: ["continued"] }]);
    let summarizerInput: unknown;
    const runtime = runtimeWithCompactionClient(model, async (request) => {
      summarizerInput = request.input;
      if (typeof request.input !== "string") {
        throw Object.assign(
          new Error("Missing required parameter: input[1].call_id. You provided callId."),
          { status: 400 },
        );
      }
      return { output_text: "rendered goal continuation summary" };
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
        contextCompactionMode: "client",
        contextWindowTokens: 100_000,
        contextReservedOutputTokens: 0,
      }),
      db: dbClient.db,
      bus,
      runtime,
    });

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-goal-rendered-compaction",
      }),
    ).resolves.toEqual({ status: "idle" });

    expect(model.calls).toBe(1);
    expect(typeof summarizerInput).toBe("string");
    expect(String(summarizerInput)).toContain("[tool_call function_call]");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(events.some((event) => event.type === "session.context.compacted")).toBe(true);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
  });

  test("compacted false never retries the unchanged turn", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "tiny overflow",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [{ position: 0, item: { type: "message", role: "user", content: "tiny" } }],
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "overflow but do not retry unchanged" } },
    ]);
    const model = new ScriptedModel([
      { error: contextOverflowError("Your input exceeds the context window of this model.") },
      { outputText: "must not run" },
    ]);
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
        contextCompactionMode: "client",
        contextWindowTokens: 100_000,
        contextReservedOutputTokens: 0,
      }),
      db: dbClient.db,
      bus,
      runtime: runtimeWithFakeCompactionSummarizer(model, "summary larger than source"),
    });

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-compacted-false-no-retry",
      }),
    ).resolves.toEqual({ status: "failed" });

    expect(model.calls).toBe(1);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 80);
    const failed = events.find((event) => event.type === "turn.failed");
    expect(String((failed?.payload as Record<string, unknown> | undefined)?.error)).toContain(
      "compaction summarization failed:",
    );
    expect(String((failed?.payload as Record<string, unknown> | undefined)?.error)).not.toContain(
      "Context compaction needed",
    );
  });

  test("summarizer hard failure uses deterministic fallback and the turn continues", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "fallback turn",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "old fallback context" } },
        {
          position: 1,
          item: { type: "message", role: "assistant", content: "x".repeat(80_000 * 4) },
        },
      ],
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "continue after fallback" } },
    ]);
    const model = new ScriptedModel([
      { outputText: "continued after fallback", chunks: ["continued"] },
    ]);
    let summarizerCalls = 0;
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
        contextCompactionMode: "client",
        contextWindowTokens: 100_000,
        contextReservedOutputTokens: 0,
      }),
      db: dbClient.db,
      bus,
      runtime: runtimeWithCompactionClient(model, async () => {
        summarizerCalls += 1;
        throw Object.assign(new Error("provider summarizer unavailable"), { status: 500 });
      }),
    });

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-fallback-compaction-continues",
      }),
    ).resolves.toEqual({ status: "idle" });

    expect(summarizerCalls).toBe(2);
    expect(model.calls).toBe(1);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    const active = await getActiveSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(
      active.some((row) =>
        String((row.item as Record<string, unknown>).content).includes(
          "Non-LLM context compaction fallback",
        ),
      ),
    ).toBe(true);
  });

  test("mid-turn proactive compaction before model progress retries once in-activity", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "proactive retry",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "x".repeat(75_000 * 4) } },
        {
          position: 1,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "old answer" }],
          },
        },
      ],
    });
    await setSessionLastInputTokens(dbClient.db, grant.workspaceId, session.id, 1);
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "continue after proactive compaction" } },
    ]);
    const model = new ScriptedModel([{ outputText: "recovered", chunks: ["recovered"] }]);
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
        contextCompactionMode: "client",
        contextWindowTokens: 100_000,
        contextReservedOutputTokens: 0,
      }),
      db: dbClient.db,
      bus,
      runtime: runtimeWithFakeCompactionSummarizer(model, "proactive retry summary"),
    });

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-proactive-retry",
      }),
    ).resolves.toEqual({ status: "idle" });

    expect(model.calls).toBe(1);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    expect(events.some((event) => event.type === "session.context.compacted")).toBe(true);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
    const active = await getActiveSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(
      active.some((row) => (row.item as Record<string, unknown>).opengeni_context_summary === true),
    ).toBe(true);
  });

  test("mid-turn proactive compaction after persisted progress AUTO-CONTINUES via a resume-notice requeue", async () => {
    const noopWorkflowClient: SessionWorkflowClient = {
      signalUserMessage: async () => undefined,
      wakeSessionWorkflow: async () => undefined,
      signalApprovalDecision: async () => undefined,
      signalInterrupt: async () => undefined,
      syncScheduledTask: async () => undefined,
      deleteScheduledTaskSchedule: async () => undefined,
      triggerScheduledTask: async () => undefined,
    };
    const grant = await testGrant(dbClient.db);
    const apiSettings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      productAccessMode: "configured",
      delegationSecret: "test-delegation-secret",
    });
    const app = createApp({
      settings: apiSettings,
      db: dbClient.db,
      bus,
      workflowClient: noopWorkflowClient,
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const settings = testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
        contextCompactionMode: "client",
        contextWindowTokens: 100_000,
        contextReservedOutputTokens: 0,
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
            timeoutMs: undefined,
            cacheToolsList: false,
          },
        ],
      });
      const session = await createOwnedSession(dbClient.db, grant, {
        initialMessage: "overflow after progress",
        resources: [],
        tools: [{ kind: "mcp", id: "opengeni" }],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
        firstPartyMcpPermissions: ["workspace:read", "sessions:read"],
      });
      await appendSessionHistoryItems(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        items: [
          { position: 0, item: { type: "message", role: "user", content: "old context" } },
          {
            position: 1,
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "old answer" }],
            },
          },
          { position: 2, item: { type: "message", role: "user", content: "recent context" } },
          {
            position: 3,
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "recent answer" }],
            },
          },
        ],
      });
      const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
        { type: "user.message", payload: { text: "overflow after progress" } },
      ]);
      const model = new ScriptedModel([
        {
          id: "proactive-progress-1",
          inputTokens: 80_000,
          output: [functionCall("opengeni__sessions_list", { limit: 1 }, "call-overflow-progress")],
        },
        { outputText: "should be requeued before this call" },
      ]);
      const activities = createActivities({
        settings,
        db: dbClient.db,
        bus,
        runtime: runtimeWithFakeCompactionSummarizer(model, "forced recovery summary"),
      });

      await expect(
        activities.runAgentTurn({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          triggerEventId: trigger!.id,
          workflowId: "workflow-overflow-progress",
        }),
      ).resolves.toEqual({ status: "preempted" });

      expect(model.calls).toBe(1);
      const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 120);
      // The turn auto-continues: no turn.failed — a preempted-with-notice requeue,
      // exactly like the worker-shutdown checkpoint path.
      expect(events.some((event) => event.type === "turn.failed")).toBe(false);
      const preempted = events.find((event) => event.type === "turn.preempted");
      expect(preempted?.payload).toMatchObject({
        reason: "context_compacted",
        resumeWithNotice: true,
      });
      expect(typeof (preempted?.payload as Record<string, unknown>).text).toBe("string");
      expect(events.some((event) => event.type === "session.context.compacted")).toBe(true);
      expect(latestStatus(events)).toBe("queued");
      expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("queued");
      const active = await getActiveSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
      expect(
        active.some(
          (row) => (row.item as Record<string, unknown>).opengeni_context_summary === true,
        ),
      ).toBe(true);
      expect(
        active.every((row) => {
          const item = row.item as Record<string, unknown>;
          return item.type === "message" && item.role === "user";
        }),
      ).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("a compaction-needed error on a compaction-resumed turn idles instead of requeueing again (loop guard)", async () => {
    const noopWorkflowClient: SessionWorkflowClient = {
      signalUserMessage: async () => undefined,
      wakeSessionWorkflow: async () => undefined,
      signalApprovalDecision: async () => undefined,
      signalInterrupt: async () => undefined,
      syncScheduledTask: async () => undefined,
      deleteScheduledTaskSchedule: async () => undefined,
      triggerScheduledTask: async () => undefined,
    };
    const grant = await testGrant(dbClient.db);
    const apiSettings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      productAccessMode: "configured",
      delegationSecret: "test-delegation-secret",
    });
    const app = createApp({
      settings: apiSettings,
      db: dbClient.db,
      bus,
      workflowClient: noopWorkflowClient,
    });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const settings = testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
        contextCompactionMode: "client",
        contextWindowTokens: 100_000,
        contextReservedOutputTokens: 0,
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: `http://127.0.0.1:${server.port}/v1/workspaces/{workspaceId}/mcp`,
            timeoutMs: undefined,
            cacheToolsList: false,
          },
        ],
      });
      const session = await createOwnedSession(dbClient.db, grant, {
        initialMessage: "overflow after resume",
        resources: [],
        tools: [{ kind: "mcp", id: "opengeni" }],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
        firstPartyMcpPermissions: ["workspace:read", "sessions:read"],
      });
      await appendSessionHistoryItems(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        items: [
          { position: 0, item: { type: "message", role: "user", content: "old context" } },
          {
            position: 1,
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "old answer" }],
            },
          },
          { position: 2, item: { type: "message", role: "user", content: "recent context" } },
          {
            position: 3,
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "recent answer" }],
            },
          },
        ],
      });
      // The trigger IS a compaction resume: a second compaction in this lineage
      // must idle, not requeue forever.
      const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
        {
          type: "turn.preempted",
          payload: {
            reason: "context_compacted",
            resumeWithNotice: true,
            text: "[resumed after compaction]",
          },
        },
      ]);
      const model = new ScriptedModel([
        {
          id: "compaction-loop-1",
          inputTokens: 80_000,
          output: [functionCall("opengeni__sessions_list", { limit: 1 }, "call-overflow-loop")],
        },
        { outputText: "should not run" },
      ]);
      const activities = createActivities({
        settings,
        db: dbClient.db,
        bus,
        runtime: runtimeWithFakeCompactionSummarizer(model, "loop guard summary"),
      });

      await expect(
        activities.runAgentTurn({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          triggerEventId: trigger!.id,
          workflowId: "workflow-overflow-loop-guard",
        }),
      ).resolves.toEqual({ status: "idle" });

      const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 120);
      const failed = events.find((event) => event.type === "turn.failed");
      expect(failed?.payload).toMatchObject({
        error: CONTEXT_WINDOW_OVERFLOW_RECOVERY_MESSAGE,
        code: "context_compacted",
        recovery: "user_message",
      });
      // No SECOND requeue: the only turn.preempted event is the trigger itself.
      expect(events.filter((event) => event.type === "turn.preempted").length).toBe(1);
      expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
    } finally {
      server.stop(true);
    }
  });

  test("a second context overflow in the same turn follows the normal failure path", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "overflow twice",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "old overflow context" } },
        {
          position: 1,
          item: { type: "message", role: "assistant", content: "x".repeat(100_000 * 4) },
        },
      ],
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "overflow twice" } },
    ]);
    const model = new ScriptedModel([
      { error: contextOverflowError("Your input exceeds the context window of this model.") },
      { error: contextOverflowError("Your input exceeds the context window of this model again.") },
    ]);
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
        contextCompactionMode: "client",
      }),
      db: dbClient.db,
      bus,
      runtime: runtimeWithFakeCompactionSummarizer(model, "first overflow recovery summary"),
    });

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-overflow-twice",
      }),
    ).resolves.toEqual({ status: "failed" });

    expect(model.calls).toBe(2);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 80);
    expect(events.some((event) => event.type === "turn.failed")).toBe(true);
    expect(latestStatus(events)).toBe("failed");
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("failed");
  });

  test("max turns exceeded idles the session instead of failing it", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "long task",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "long task" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error: new MaxTurnsExceededError("Max turns (40) exceeded") }]),
      }),
    });

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-max-turns",
      }),
    ).resolves.toEqual({ status: "idle" });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.payload).toEqual({
      output: "",
      segmentLimit: "max_turns",
      runStateSaved: false,
    });
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id, 10);
    expect(turns.every((turn) => turn.status !== "failed")).toBe(true);
  });

  test("idles the session on a retryable provider failure without a goal", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "rate limit",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "rate limit" } },
    ]);
    const error = new Error("Too Many Requests");
    Object.assign(error, { status: 429 });
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error }]),
      }),
    });

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-rate-limit",
      }),
    ).resolves.toEqual({ status: "idle" });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const failed = events.find((event) => event.type === "turn.failed");
    expect(failed?.payload).toEqual({
      error: "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
      code: "provider_rate_limited",
      retryable: true,
      recovery: "user_message",
      runStateSaved: false,
    });
    // The turn is truthfully failed, but a transient provider failure must
    // not kill a long-lived session: it idles and the next user message
    // resumes it (no continuation pacing -- there is no goal to continue).
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id, 10);
    expect(turns.some((turn) => turn.status === "failed")).toBe(true);
  });

  test("idles the session on a retryable provider failure when a goal is active", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "rate limit with goal",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "finish the long-running provisioning",
      createdBy: "api",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "rate limit with goal" } },
    ]);
    const error = new Error("Too Many Requests");
    Object.assign(error, { status: 429 });
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error }]),
      }),
    });

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-rate-limit-goal",
      }),
    ).resolves.toEqual({ status: "idle", continueDelayMs: PROVIDER_BACKPRESSURE_DELAY_MS });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const failed = events.find((event) => event.type === "turn.failed");
    expect(failed?.payload).toEqual({
      error: "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
      code: "provider_rate_limited",
      retryable: true,
      recovery: "goal_continuation",
      runStateSaved: false,
    });
    // The turn is truthfully failed, but the session stays resumable and the
    // goal remains active for the continuation loop to pick up.
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id, 10);
    expect(turns.some((turn) => turn.status === "failed")).toBe(true);
    expect((await getSessionGoal(dbClient.db, grant.workspaceId, session.id))?.status).toBe(
      "active",
    );
  });

  test("records worker observability when setup fails before a turn starts", async () => {
    const grant = await testGrant(dbClient.db);
    const exported: Array<{ body: any }> = [];
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      observabilityOtlpEndpoint: "http://collector:4318",
    });
    const observability = createObservability(settings, {
      component: "worker",
      exporter: async (_url, body) => {
        exported.push({ body });
      },
    });
    const activities = createActivities({
      settings,
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "unused" }]),
      }),
      observability,
    });

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: crypto.randomUUID(),
        triggerEventId: crypto.randomUUID(),
        workflowId: "workflow-missing-session",
      }),
    ).rejects.toThrow("Session not found");
    await Bun.sleep(0);

    expect(exported).toHaveLength(1);
    const span = exported[0]!.body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe("worker.run_agent_segment");
    expect(span.status.code).toBe(2);
    expect(await observability.prometheusMetrics()).toContain('status="failed"');
  });

  test("does not publish turn failure before turn start when status update fails", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const turnId = await createTurn(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      temporalWorkflowId: "workflow-status-update-fails",
      triggerEventId: trigger!.id,
    });
    const failingDb = new Proxy(dbClient.db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          return async (fn: (tx: typeof dbClient.db) => Promise<unknown>, ...args: unknown[]) =>
            await (target.transaction as any)(
              async (tx: typeof dbClient.db) => {
                const failingTx = new Proxy(tx, {
                  get(txTarget, txProp, txReceiver) {
                    if (txProp === "update") {
                      return () => {
                        throw new Error("status update failed");
                      };
                    }
                    const value = Reflect.get(txTarget, txProp, txReceiver);
                    return typeof value === "function" ? value.bind(txTarget) : value;
                  },
                }) as typeof dbClient.db;
                return await fn(failingTx);
              },
              ...args,
            );
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof dbClient.db;
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: failingDb,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "unused" }]),
      }),
    });

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-status-update-fails",
        turnId,
      }),
    ).rejects.toThrow("status update failed");

    const eventTypes = (
      await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50)
    ).map((event) => event.type);
    expect(eventTypes).not.toContain("turn.started");
    expect(eventTypes).not.toContain("turn.failed");
  });

  test("marks approval reruns running before resuming the agent", async () => {
    const workflowId = "workflow-approval-rerun";
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "needs approval",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [initialTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "needs approval" } },
    ]);
    const turnId = await createTurn(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      temporalWorkflowId: workflowId,
      triggerEventId: initialTrigger!.id,
    });
    await finishTurn(dbClient.db, grant.workspaceId, turnId, "requires_action");
    await saveRunState(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId,
      serializedRunState: "saved-state",
      pendingApprovals: [{ id: "approval-1" }],
    });
    await setSessionStatus(dbClient.db, grant.workspaceId, session.id, "requires_action", turnId);
    const [approvalTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.approvalDecision", payload: { approvalId: "approval-1", decision: "approve" } },
    ]);
    let observedDuringRun: { status?: string; activeTurnId?: string | null } | null = null;
    const runtime: OpenGeniRuntime = {
      configure: () => {},
      resolveTurnModel: () => null,
      buildAgent: () => ({}) as never,
      prepareTools: async () => ({ mcpServers: [], close: async () => {} }),
      prepareInput: async (_agent, input) => {
        expect(input.kind).toBe("approval");
        return { input: "approved" };
      },
      runStream: async () => {
        const stored = await getSession(dbClient.db, grant.workspaceId, session.id);
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

    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: approvalTrigger!.id,
        workflowId,
        turnId,
      }),
    ).resolves.toEqual({ status: "idle" });

    expect(observedDuringRun).toEqual({ status: "running", activeTurnId: turnId });
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
  });

  test("sets Docker and Modal sandbox home defaults", async () => {
    const { environment: docker } = await sandboxEnvironmentForRun(
      testSettings({ sandboxBackend: "docker" }),
      [],
    );
    const { environment: modal } = await sandboxEnvironmentForRun(
      testSettings({ sandboxBackend: "modal" }),
      [],
    );
    const { environment: disabled } = await sandboxEnvironmentForRun(
      testSettings({ sandboxBackend: "none" }),
      [],
    );

    expect(docker.HOME).toBe("/workspace");
    expect(docker.AZURE_CONFIG_DIR).toBeUndefined();
    expect(modal.HOME).toBe("/workspace");
    expect(modal.AZURE_CONFIG_DIR).toBeUndefined();
    expect(disabled.HOME).toBeUndefined();
    expect(disabled.AZURE_CONFIG_DIR).toBeUndefined();
  });

  test("injects run-scoped GitHub App token and bot identity for repository resources", async () => {
    const originalFetch = globalThis.fetch;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let tokenRequestBody: unknown;
    globalThis.fetch = (async (_input, init) => {
      tokenRequestBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ token: "installation-token" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const { environment, gitToken } = await sandboxEnvironmentForRun(
        testSettings({
          githubAppId: "99",
          githubClientId: "client-id",
          githubClientSecret: "client-secret",
          githubAppSlug: "opengeni",
          githubAppPrivateKey: privateKeyPem,
        }),
        [
          {
            kind: "repository",
            uri: "https://github.com/cloudgeni-ai/opengeni.git",
            ref: "main",
            githubInstallationId: 123,
            githubRepositoryId: 456,
          },
        ],
      );

      expect(tokenRequestBody).toEqual({ repository_ids: [456] });
      expect(gitToken).toBe("installation-token");
      expect(environment.GH_TOKEN).toBeUndefined();
      expect(environment.GITHUB_TOKEN).toBeUndefined();
      expect(environment.GIT_ASKPASS).toBe("/workspace/.opengeni/askpass");
      expect(environment.OPENGENI_GIT_TOKEN_FILE).toBe("/workspace/.opengeni/git-token");
      expect(environment.GIT_AUTHOR_NAME).toBe("opengeni[bot]");
      expect(environment.GIT_AUTHOR_EMAIL).toBe("99+opengeni[bot]@users.noreply.github.com");
      expect(environment.GIT_COMMITTER_NAME).toBe("opengeni[bot]");
      expect(environment.GIT_COMMITTER_EMAIL).toBe("99+opengeni[bot]@users.noreply.github.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("runs repository clone hook for Modal repository-backed sessions before SDK sandbox use", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "read repo",
      resources: [
        {
          kind: "repository",
          uri: "https://github.com/Futhark-AS/aifilesearch.git",
          ref: "main",
        },
      ],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "modal",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "read repo" } },
    ]);
    const sandboxExecCalls: Array<Record<string, unknown>> = [];
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "ok", chunks: ["ok"] }]),
        sandboxClient: {
          backendId: "test-modal",
          create: async () => ({
            state: { manifest: { root: "/workspace", entries: {}, environment: {} } },
            execCommand: async (args: Record<string, unknown>) => {
              sandboxExecCalls.push(args);
              return { status: 0, output: "" };
            },
          }),
        },
      }),
    });

    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-modal-repo-clone",
    });

    expect(result.status).toBe("failed");
    expect(sandboxExecCalls).toHaveLength(1);
    expect(String(sandboxExecCalls[0]?.cmd)).toContain(
      "clone_repository '/workspace/repos/Futhark-AS/aifilesearch'",
    );
    expect(String(sandboxExecCalls[0]?.cmd)).toContain(
      'git -C "$tmp" fetch --depth 1 --no-tags --filter=blob:none origin "$ref"',
    );
    expect(String(sandboxExecCalls[0]?.cmd)).toContain("x-access-token");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "sandbox.operation.started")).toBe(true);
    expect(events.some((event) => event.type === "sandbox.operation.completed")).toBe(true);
    expect(JSON.stringify(events)).toContain(
      "Filesystem sandbox sessions must provide createEditor",
    );
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
      const grant = await testGrant(dbClient.db);
      const session = await createOwnedSession(dbClient.db, grant, {
        initialMessage: "search docs",
        resources: [],
        tools: [{ kind: "mcp", id: "docs" }],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
        { type: "user.message", payload: { text: "search docs" } },
      ]);
      const activities = createActivities({
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          natsUrl: services.natsUrl,
          mcpServers: [
            {
              id: "docs",
              name: "Document Search",
              url: mcp.url,
              allowedTools: ["search_documents"],
              cacheToolsList: false,
            },
          ],
        }),
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });

      const result = await activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-mcp",
      });

      expect(result.status).toBe("idle");
      expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "network policy" } }]);
      expect(JSON.stringify(model.requests[0])).toContain("docs__search_documents");
      expect(JSON.stringify(model.requests[0])).not.toContain("docs__fetch_document");
      const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
      expect(events.some((event) => event.type === "agent.toolCall.created")).toBe(true);
      expect(events.some((event) => event.type === "agent.toolCall.output")).toBe(true);
      expect(latestStatus(events)).toBe("idle");
    } finally {
      mcp.close();
    }
  });

  test("records and debits model usage once per streamed provider response", async () => {
    const mcp = startTestMcpServer();
    try {
      const model = new ScriptedModel([
        {
          id: "scripted-response-tool",
          output: [
            functionCall("docs__search_documents", { query: "network policy" }, "call-doc-search"),
          ],
        },
        {
          id: "scripted-response-final",
          outputText: "used document search",
          chunks: ["used ", "document ", "search"],
        },
      ]);
      const grant = await testGrant(dbClient.db);
      await applyCreditLedgerEntry(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        type: "manual_adjustment",
        amountMicros: 1_000_000,
        sourceType: "test",
        sourceId: "per-response-usage",
        idempotencyKey: `test-credit:${grant.workspaceId}:per-response-usage`,
      });
      const session = await createOwnedSession(dbClient.db, grant, {
        initialMessage: "search docs",
        resources: [],
        tools: [{ kind: "mcp", id: "docs" }],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
        { type: "user.message", payload: { text: "search docs" } },
      ]);
      const activities = createActivities({
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          natsUrl: services.natsUrl,
          billingMode: "stripe",
          modelPricingJson: JSON.stringify({
            "scripted-model": {
              inputMicrosPerMillionTokens: 1_000_000,
              outputMicrosPerMillionTokens: 1_000_000,
            },
          }),
          mcpServers: [
            {
              id: "docs",
              name: "Document Search",
              url: mcp.url,
              allowedTools: ["search_documents"],
              cacheToolsList: false,
            },
          ],
        }),
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });

      const result = await activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-per-response-usage",
      });

      expect(result.status).toBe("idle");
      expect(model.calls).toBe(2);
      const usage = await listUsageEvents(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        limit: 20,
      });
      const tokenEvents = usage.filter((event) => event.eventType === "model.tokens");
      expect(tokenEvents).toHaveLength(2);
      expect(tokenEvents.map((event) => event.sourceResourceId?.split(":").at(-1)).sort()).toEqual([
        "scripted-response-final",
        "scripted-response-tool",
      ]);
      expect(usage.filter((event) => event.eventType === "model.cost")).toHaveLength(2);
      const balance = await getBillingBalance(dbClient.db, grant.accountId);
      expect(balance.balanceMicros).toBeLessThan(1_000_000);
      expect(balance.balanceMicros).toBeGreaterThan(0);
    } finally {
      mcp.close();
    }
  });

  test("caps model usage debits at the prepaid balance", async () => {
    const grant = await testGrant(dbClient.db);
    await applyCreditLedgerEntry(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      type: "manual_adjustment",
      amountMicros: 1,
      sourceType: "test",
      sourceId: "capped-model-debit",
      idempotencyKey: `test-credit:${grant.workspaceId}:capped-model-debit`,
    });
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "expensive run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "expensive run" } },
    ]);
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        billingMode: "stripe",
        modelPricingJson: JSON.stringify({
          "scripted-model": {
            inputMicrosPerMillionTokens: 1_000_000_000,
            outputMicrosPerMillionTokens: 1_000_000_000,
          },
        }),
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([
          {
            id: "expensive-response",
            outputText: "expensive response",
            chunks: ["expensive response"],
          },
        ]),
      }),
    });

    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-capped-model-debit",
    });

    // Budget exhaustion is account state, not an agent failure: the segment
    // ends gracefully so the session accepts new messages after a top-up.
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.payload).toMatchObject({
      segmentLimit: "budget_exhausted",
      detail: "insufficient OpenGeni credits",
    });
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
    const balance = await getBillingBalance(dbClient.db, grant.accountId);
    expect(balance.balanceMicros).toBe(0);
    const usage = await listUsageEvents(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      limit: 20,
    });
    const cost = usage.find(
      (event) =>
        event.eventType === "model.cost" && event.sourceResourceId?.endsWith("expensive-response"),
    );
    expect(cost?.quantity).toBeGreaterThan(1);
  });

  test("dual-writes conversation items and resumes turns from them in items mode", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "remember the codeword zebra",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const model = new ScriptedModel([
      { id: "items-t1", outputText: "noted: zebra", chunks: ["noted: zebra"] },
      { id: "items-t2", outputText: "the codeword is zebra", chunks: ["the codeword is zebra"] },
    ]);
    // Turn 1 runs in legacy run_state mode: items must be dual-written anyway.
    const runStateActivities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    const [trigger1] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "remember the codeword zebra" } },
    ]);
    await expect(
      runStateActivities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger1!.id,
        workflowId: "workflow-items-turn-1",
      }),
    ).resolves.toEqual({ status: "idle" });
    const itemsAfterTurn1 = await getSessionHistoryItems(
      dbClient.db,
      grant.workspaceId,
      session.id,
    );
    expect(itemsAfterTurn1.length).toBeGreaterThanOrEqual(2);
    expect(itemsAfterTurn1.map((row) => row.position)).toEqual(
      itemsAfterTurn1.map((_, index) => index),
    );
    expect(JSON.stringify(itemsAfterTurn1[0]?.item)).toContain("remember the codeword zebra");
    const blobAfterTurn1 = await getLatestRunState(dbClient.db, grant.workspaceId, session.id);
    expect(blobAfterTurn1).not.toBeNull();

    // Turn 2 reads conversation truth from the items table (items mode) and
    // writes no new blob: the model must still see the full prior turn.
    const itemsActivities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    const [trigger2] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "what is the codeword?" } },
    ]);
    await expect(
      itemsActivities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger2!.id,
        workflowId: "workflow-items-turn-2",
      }),
    ).resolves.toEqual({ status: "idle" });
    const lastRequestInput = JSON.stringify(
      (model.requests.at(-1) as { input?: unknown })?.input ?? "",
    );
    expect(lastRequestInput).toContain("remember the codeword zebra");
    expect(lastRequestInput).toContain("noted: zebra");
    expect(lastRequestInput).toContain("what is the codeword?");
    const itemsAfterTurn2 = await getSessionHistoryItems(
      dbClient.db,
      grant.workspaceId,
      session.id,
    );
    expect(itemsAfterTurn2.length).toBeGreaterThan(itemsAfterTurn1.length);
    const blobAfterTurn2 = await getLatestRunState(dbClient.db, grant.workspaceId, session.id);
    expect(blobAfterTurn2?.id).toBe(blobAfterTurn1?.id);
  });

  test("runs a turn whose stored history carries an orphaned tool output instead of 400ing", async () => {
    // A session whose session_history_items contains an orphaned
    // function_call_result (a tool output whose function_call is absent — the
    // corruption that 400s the Responses API and bricks the session on every
    // replay) must still run a turn: the read path sanitizes the in-memory copy
    // before it reaches the model, and the stored audit trail is left intact.
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "earlier work",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const turn = await createTurn(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      temporalWorkflowId: "workflow-orphan-seed",
      triggerEventId: crypto.randomUUID(),
    });
    // Seed a stored history that is corrupt exactly the way the live incidents
    // were: a valid user turn, then a function_call_result with NO matching
    // function_call anywhere in the items.
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: turn,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "earlier work" } },
        {
          position: 1,
          item: {
            type: "function_call_result",
            callId: "call_orphaned",
            status: "completed",
            output: { type: "text", text: "stale result" },
          },
        },
        {
          position: 2,
          item: {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ack" }],
          },
        },
      ],
    });

    const model = new ScriptedModel([
      { id: "orphan-recover", outputText: "recovered", chunks: ["recovered"] },
    ]);
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "continue please" } },
    ]);

    // The turn SUCCEEDS instead of failing the session with a 400.
    await expect(
      activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        triggerEventId: trigger!.id,
        workflowId: "workflow-orphan-recover",
      }),
    ).resolves.toEqual({ status: "idle" });

    // The orphan never reached the model: the sanitized request omits it while
    // keeping the surrounding valid items and the new user turn.
    const lastRequestInput = JSON.stringify(
      (model.requests.at(-1) as { input?: unknown })?.input ?? "",
    );
    expect(lastRequestInput).not.toContain("call_orphaned");
    expect(lastRequestInput).not.toContain("stale result");
    expect(lastRequestInput).toContain("earlier work");
    expect(lastRequestInput).toContain("continue please");

    // The stored audit trail is untouched — the orphan row still exists.
    const storedItems = await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(storedItems.some((row) => JSON.stringify(row.item).includes("call_orphaned"))).toBe(
      true,
    );
  });

  test("blocks async document embeddings when managed credits are empty", async () => {
    const grant = await testGrant(dbClient.db);
    const upload = await createOwnedFileUpload(dbClient.db, grant, {
      fileId: crypto.randomUUID(),
      filename: "no-credit-doc.txt",
      safeFilename: "no-credit-doc.txt",
      contentType: "text/plain",
      sizeBytes: 24,
      bucket: "test",
      objectKey: `workspaces/${grant.workspaceId}/files/no-credit-doc.txt`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const file = await completeFileUpload(dbClient.db, grant.workspaceId, upload.uploadId);
    const base = await createDocumentBase(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "No credit worker docs",
    });
    const document = await addDocumentToBase(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: base.id,
      fileId: file.id,
    });
    let embedderCalled = false;
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        billingMode: "stripe",
        modelPricingJson: JSON.stringify({
          "scripted-model": {
            inputMicrosPerMillionTokens: 1_000_000,
            outputMicrosPerMillionTokens: 1_000_000,
          },
        }),
      }),
      db: dbClient.db,
      bus,
      objectStorage: fakeObjectStorage("OpenGeni managed document credit test."),
      documentServices: {
        parser: {
          name: "test-text",
          parse: async (bytes, inputFile) => ({
            text: new TextDecoder().decode(bytes),
            metadata: { filename: inputFile.filename, contentType: inputFile.contentType },
          }),
        },
        chunker: {
          chunk: (parsed, inputFile) => [
            {
              text: parsed.text,
              metadata: { filename: inputFile.filename, chunkIndex: 0 },
            },
          ],
        },
        embedder: {
          model: "test-embedder",
          dimensions: 3,
          embedMany: async () => {
            embedderCalled = true;
            throw new Error("embedder should not run without credits");
          },
          embedQuery: async () => [0, 0, 0],
        },
      } satisfies DocumentServices,
    });

    const indexed = await activities.indexDocument({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      documentId: document.id,
    });

    expect(indexed.status).toBe("failed");
    expect(indexed.error).toContain("insufficient OpenGeni credits");
    expect(embedderCalled).toBe(false);
    const usage = await listUsageEvents(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      limit: 20,
    });
    expect(usage.some((event) => event.eventType === "document.indexed")).toBe(false);
  });

  test("serializes concurrent document indexing against monthly chunk caps", async () => {
    const grant = await testGrant(dbClient.db);
    const uploadOne = await createOwnedFileUpload(dbClient.db, grant, {
      fileId: crypto.randomUUID(),
      filename: "limited-doc-1.txt",
      safeFilename: "limited-doc-1.txt",
      contentType: "text/plain",
      sizeBytes: 16,
      bucket: "test",
      objectKey: `workspaces/${grant.workspaceId}/files/limited-doc-1.txt`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const uploadTwo = await createOwnedFileUpload(dbClient.db, grant, {
      fileId: crypto.randomUUID(),
      filename: "limited-doc-2.txt",
      safeFilename: "limited-doc-2.txt",
      contentType: "text/plain",
      sizeBytes: 16,
      bucket: "test",
      objectKey: `workspaces/${grant.workspaceId}/files/limited-doc-2.txt`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const fileOne = await completeFileUpload(dbClient.db, grant.workspaceId, uploadOne.uploadId);
    const fileTwo = await completeFileUpload(dbClient.db, grant.workspaceId, uploadTwo.uploadId);
    const base = await createDocumentBase(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "Serialized limit docs",
    });
    const documentOne = await addDocumentToBase(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: base.id,
      fileId: fileOne.id,
    });
    const documentTwo = await addDocumentToBase(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      baseId: base.id,
      fileId: fileTwo.id,
    });
    let embedCalls = 0;
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({ maxDocumentIndexedChunksPerWorkspace: 2 }),
      }),
      db: dbClient.db,
      bus,
      objectStorage: fakeObjectStorage("0123456789abcdef"),
      documentServices: {
        parser: {
          name: "test-text",
          parse: async (bytes, inputFile) => ({
            text: new TextDecoder().decode(bytes),
            metadata: { filename: inputFile.filename, contentType: inputFile.contentType },
          }),
        },
        chunker: {
          chunk: (parsed, inputFile) =>
            [0, 1].map((index) => ({
              text: parsed.text.slice(index * 8, index * 8 + 8),
              metadata: { filename: inputFile.filename, chunkIndex: index },
            })),
        },
        embedder: {
          model: "test-embedder",
          dimensions: DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS,
          embedMany: async (chunks) => {
            embedCalls += 1;
            return chunks.map((chunk) =>
              deterministicEmbedding(chunk, DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS),
            );
          },
          embedQuery: async (query) =>
            deterministicEmbedding(query, DEFAULT_DOCUMENT_EMBEDDING_DIMENSIONS),
        },
      } satisfies DocumentServices,
    });

    const results = await Promise.all([
      activities.indexDocument({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        documentId: documentOne.id,
      }),
      activities.indexDocument({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        documentId: documentTwo.id,
      }),
    ]);

    expect(results.map((document) => document.status).sort()).toEqual(["failed", "ready"]);
    expect(results.find((document) => document.status === "failed")?.error).toContain(
      "monthly document indexing limit reached (2 chunks)",
    );
    expect(embedCalls).toBe(1);
    const indexedChunks = await sumUsageQuantity(dbClient.db, {
      workspaceId: grant.workspaceId,
      eventType: "document.indexed",
      since: startOfUtcMonth(),
    });
    expect(indexedChunks).toBe(2);
  });

  test("allows the worker to run an already accepted turn at the exact monthly run cap", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "allowed first run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "allowed first run" } },
    ]);
    await recordUsageEvent(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "session",
      sourceResourceId: session.id,
      idempotencyKey: `test-agent-run-created:${session.id}`,
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({ maxMonthlyAgentRunsPerWorkspace: 1 }),
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "within cap", chunks: ["within ", "cap"] }]),
      }),
    });

    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-exact-run-cap",
    });

    expect(result.status).toBe("idle");
    expect(
      latestStatus(await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50)),
    ).toBe("idle");
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
      const grant = await testGrant(dbClient.db);
      const session = await createOwnedSession(dbClient.db, grant, {
        initialMessage: "start",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        sandboxBackend: "none",
      });
      const [trigger] = await appendSessionEventsAndUpdateSession(
        dbClient.db,
        grant.workspaceId,
        session.id,
        [
          {
            type: "user.message",
            payload: {
              text: "search docs now",
              tools: [{ kind: "mcp", id: "docs" }],
            },
          },
        ],
        {
          tools: [{ kind: "mcp", id: "docs" }],
        },
      );
      const activities = createActivities({
        settings: testSettings({
          databaseUrl: services.databaseUrl,
          natsUrl: services.natsUrl,
          mcpServers: [
            {
              id: "docs",
              name: "Document Search",
              url: mcp.url,
              allowedTools: ["search_documents"],
              cacheToolsList: false,
            },
          ],
        }),
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });

      const result = await activities.runAgentTurn({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
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
    const grant = await testGrant(dbClient.db);
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
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

    const result = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });

    expect(result.action).toBe("start");
    expect(result.workflowId).toBe(`session-${result.sessionId}`);
    const session = await getSession(dbClient.db, grant.workspaceId, result.sessionId);
    expect(session?.metadata).toMatchObject({ scheduledTaskId: task.id, source: "test" });
    expect(session?.tools).toEqual([{ kind: "mcp", id: "docs" }]);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, result.sessionId, 0, 10);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);
    expect(events.find((event) => event.type === "user.message")?.payload).toMatchObject({
      text: "inspect nightly",
      scheduledTaskId: task.id,
    });
    const [run] = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(run).toMatchObject({
      status: "dispatched",
      sessionId: result.sessionId,
      triggerEventId: result.triggerEventId,
    });
  });

  test("blocks scheduled task dispatch when the account monthly model cost cap is reached", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "scheduled-cost-cap",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "inspect after cost cap",
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    await recordUsageEvent(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      eventType: "model.cost",
      quantity: 100,
      unit: "micro_usd",
      sourceResourceType: "test",
      sourceResourceId: task.id,
      idempotencyKey: `test:scheduled-cost-cap:${task.id}`,
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({ maxMonthlyCostMicrosPerAccount: 100 }),
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "should not run" }]),
      }),
    });

    await expect(
      activities.dispatchScheduledTaskRun({
        workspaceId: grant.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
      }),
    ).rejects.toThrow("monthly model cost limit reached (100 micros)");
    expect(await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id)).toHaveLength(0);
  });

  test("does not double count a manually reserved scheduled task run", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "scheduled-manual-reserved",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "manual reserved",
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    const reservationKey = `test:manual-reserved:${task.id}`;
    await recordUsageEvent(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "scheduled_task",
      sourceResourceId: task.id,
      idempotencyKey: reservationKey,
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        usageLimitsMode: "static",
        staticUsageLimitsJson: JSON.stringify({ maxMonthlyAgentRunsPerWorkspace: 1 }),
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "manual",
      agentRunUsageIdempotencyKey: reservationKey,
    });
    const used = await sumUsageQuantity(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    expect(used).toBe(1);
  });

  test("records scheduled dispatch usage when live event publish fails", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "scheduled-failing-dispatch",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "this cannot dispatch",
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    const failingBus: EventBus = {
      publish: async () => {
        throw new Error("bus publish unavailable");
      },
      subscribe: async () => async () => undefined,
      close: async () => undefined,
    };
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
      }),
      db: dbClient.db,
      bus: failingBus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "should not run" }]),
      }),
    });

    await expect(
      activities.dispatchScheduledTaskRun({
        workspaceId: grant.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
      }),
    ).resolves.toMatchObject({ action: "start", workspaceId: grant.workspaceId });
    const runs = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "dispatched" });
    const agentRuns = await sumUsageQuantity(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      eventType: "agent_run.created",
      since: startOfUtcMonth(),
    });
    const fired = await sumUsageQuantity(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      eventType: "scheduled_task.fired",
      since: startOfUtcMonth(),
    });
    expect(agentRuns).toBe(1);
    expect(fired).toBe(1);
  });

  test("dispatches reusable scheduled tasks by signaling the stored session", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
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

    const first = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });
    const stored = await requireScheduledTask(dbClient.db, grant.workspaceId, task.id);
    const second = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "manual",
    });

    expect(first.action).toBe("start");
    expect(second.action).toBe("signal");
    expect(second.sessionId).toBe(first.sessionId);
    expect(stored.reusableSessionId).toBe(first.sessionId);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, first.sessionId, 0, 10);
    expect(events.filter((event) => event.type === "user.message")).toHaveLength(2);
    const runs = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "dispatched")).toBe(true);
  });

  test("loads and decrypts attached workspace environments for runs and fails closed otherwise", async () => {
    const grant = await testGrant(dbClient.db);
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      environmentsEncryptionKey: workerEnvironmentsKey,
    });
    const environment = await seedWorkspaceEnvironment(
      dbClient.db,
      grant,
      {
        API_TOKEN: "worker-secret-token-1234",
        DB_PASSWORD: "worker-secret-pass-5678",
      },
      "Operator notes: API_TOKEN authenticates the worker against the test API.",
    );

    expect(
      await loadWorkspaceEnvironmentForRun(dbClient.db, settings, grant.workspaceId, null),
    ).toBeNull();
    const loaded = await loadWorkspaceEnvironmentForRun(
      dbClient.db,
      settings,
      grant.workspaceId,
      environment.id,
    );
    expect(loaded).toMatchObject({
      id: environment.id,
      name: environment.name,
      description: "Operator notes: API_TOKEN authenticates the worker against the test API.",
    });
    expect(loaded?.values).toEqual({
      API_TOKEN: "worker-secret-token-1234",
      DB_PASSWORD: "worker-secret-pass-5678",
    });

    await expect(
      loadWorkspaceEnvironmentForRun(
        dbClient.db,
        testSettings({ databaseUrl: services.databaseUrl }),
        grant.workspaceId,
        environment.id,
      ),
    ).rejects.toThrow("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured");
    await expect(
      loadWorkspaceEnvironmentForRun(dbClient.db, settings, grant.workspaceId, crypto.randomUUID()),
    ).rejects.toThrow("workspace environment not found");
  });

  test("layers workspace environment values between deployment env and GitHub run auth", async () => {
    const settings = testSettings({
      sandboxBackend: "docker",
      sandboxEnvAllowlist: "WORKER_TEST_ALLOWLISTED",
      gitAuthorName: "Deployment Author",
      gitAuthorEmail: "author@example.test",
    });
    const previous = process.env.WORKER_TEST_ALLOWLISTED;
    process.env.WORKER_TEST_ALLOWLISTED = "deployment-value";
    try {
      const { environment: unattached } = await sandboxEnvironmentForRun(settings, []);
      expect(unattached.WORKER_TEST_ALLOWLISTED).toBe("deployment-value");
      const { environment } = await sandboxEnvironmentForRun(settings, [], {
        WORKER_TEST_ALLOWLISTED: "workspace-override",
        WORKSPACE_ONLY_TOKEN: "workspace-only-value",
      });
      expect(environment.WORKER_TEST_ALLOWLISTED).toBe("workspace-override");
      expect(environment.WORKSPACE_ONLY_TOKEN).toBe("workspace-only-value");
      expect(environment.GIT_AUTHOR_NAME).toBe("Deployment Author");
      expect(environment.HOME).toBe("/workspace");
    } finally {
      if (previous === undefined) {
        delete process.env.WORKER_TEST_ALLOWLISTED;
      } else {
        process.env.WORKER_TEST_ALLOWLISTED = previous;
      }
    }
  });

  test("redacts attached environment values echoed by the agent into session events", async () => {
    const secret = "echoed-workspace-secret-987654";
    const grant = await testGrant(dbClient.db);
    const environment = await seedWorkspaceEnvironment(dbClient.db, grant, {
      LEAKED_TOKEN: secret,
    });
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      environmentId: environment.id,
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        environmentsEncryptionKey: workerEnvironmentsKey,
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([
          {
            outputText: `the token is ${secret} end`,
            chunks: ["the token is ", secret, " end"],
          },
        ]),
      }),
    });
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-environment-redaction",
    });
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[redacted:LEAKED_TOKEN]");
    const completed = events.find((event) => event.type === "agent.message.completed");
    expect((completed?.payload as { text: string }).text).toBe(
      "the token is [redacted:LEAKED_TOKEN] end",
    );
  });

  test("fails attached runs closed when the worker has no encryption key", async () => {
    const grant = await testGrant(dbClient.db);
    const environment = await seedWorkspaceEnvironment(dbClient.db, grant, {
      REQUIRED_TOKEN: "required-secret-123456",
    });
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "run",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      environmentId: environment.id,
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "never reached" }]),
      }),
    });
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      workflowId: "workflow-environment-missing-key",
    });
    expect(result.status).toBe("failed");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const failed = events.find((event) => event.type === "turn.failed");
    expect(JSON.stringify(failed?.payload)).toContain("OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY");
    expect(JSON.stringify(failed?.payload)).not.toContain("required-secret-123456");
  });

  test("propagates scheduled task environment attachments into dispatched sessions", async () => {
    const grant = await testGrant(dbClient.db);
    const environment = await seedWorkspaceEnvironment(dbClient.db, grant, {
      TASK_TOKEN: "task-secret-123456",
    });
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "environment dispatch",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
      environmentId: environment.id,
      metadata: {},
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        environmentsEncryptionKey: workerEnvironmentsKey,
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });
    const dispatched = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });
    expect(dispatched.action).toBe("start");
    const session = await getSession(dbClient.db, grant.workspaceId, dispatched.sessionId);
    expect(session?.environmentId).toBe(environment.id);
    const events = await listSessionEvents(
      dbClient.db,
      grant.workspaceId,
      dispatched.sessionId,
      0,
      10,
    );
    const createdEvent = events.find((event) => event.type === "session.created");
    expect(createdEvent?.payload).toMatchObject({
      environmentId: environment.id,
      environmentName: environment.name,
    });
    expect(JSON.stringify(events)).not.toContain("task-secret-123456");
  });

  test("fails reusable dispatch when the task attachment diverges from its session", async () => {
    const grant = await testGrant(dbClient.db);
    const environment = await seedWorkspaceEnvironment(dbClient.db, grant, {
      DIVERGED_TOKEN: "diverged-value-123456",
    });
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "reusable",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "diverged reusable",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "run", resources: [], tools: [], metadata: {} },
      environmentId: environment.id,
      metadata: {},
    });
    await updateScheduledTask(dbClient.db, grant.workspaceId, task.id, {
      reusableSessionId: session.id,
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        environmentsEncryptionKey: workerEnvironmentsKey,
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });
    await expect(
      activities.dispatchScheduledTaskRun({
        workspaceId: grant.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
      }),
    ).rejects.toThrow("scheduled task environment attachment does not match its reusable session");
    const runs = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(runs[0]?.status).toBe("failed");
  });

  test("refuses to revive a cancelled reusable session on the next fire", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "reusable",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    // The user explicitly cancelled this reusable session (the one terminal
    // state). The next scheduled fire must NOT resurrect and re-bill it.
    await setSessionStatus(dbClient.db, grant.workspaceId, session.id, "cancelled", null);
    const beforeEvents = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "cancelled reusable",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "follow up", resources: [], tools: [], metadata: {} },
      metadata: {},
    });
    await updateScheduledTask(dbClient.db, grant.workspaceId, task.id, {
      reusableSessionId: session.id,
    });
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    await expect(
      activities.dispatchScheduledTaskRun({
        workspaceId: grant.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
      }),
    ).rejects.toThrow(/cancelled/i);

    // Nothing was appended to the cancelled session: no new user.message, no
    // turn queued, and the session stays cancelled (not revived to queued).
    const afterEvents = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(afterEvents.length).toBe(beforeEvents.length);
    expect(afterEvents.filter((event) => event.type === "user.message")).toHaveLength(0);
    expect(afterEvents.filter((event) => event.type === "turn.queued")).toHaveLength(0);
    const revived = await getSession(dbClient.db, grant.workspaceId, session.id);
    expect(revived?.status).toBe("cancelled");
    const queuedTurns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id, 50);
    expect(queuedTurns.filter((turn) => turn.status === "queued")).toHaveLength(0);
    // The run is recorded as failed, not dispatched.
    const runs = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(runs[0]?.status).toBe("failed");
  });

  test("synthesizes billed goal continuation turns and auto-pauses on no progress", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "pursue the goal",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "service deployed and healthy",
      successCriteria: "probe returns 200",
      createdBy: "api",
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        goalNoProgressLimit: 1,
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: "http://127.0.0.1:65531/v1/workspaces/{workspaceId}/mcp",
            cacheToolsList: true,
          },
        ],
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    const first = await activities.maybeContinueGoal({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
    });
    expect(first.action).toBe("continue");

    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    const continuation = turns.find((turn) => turn.source === "goal");
    expect(continuation).toBeTruthy();
    expect(continuation!.status).toBe("queued");
    expect(continuation!.temporalWorkflowId).toBe(`session-${session.id}`);
    expect(continuation!.prompt).toContain("[GOAL CONTINUATION 1/20]");
    expect(continuation!.prompt).toContain("service deployed and healthy");
    expect(continuation!.prompt).toContain("probe returns 200");
    // The first-party MCP server is forced onto continuation turns so the
    // goal_complete/goal_pause escape hatches stay reachable.
    expect(continuation!.tools).toContainEqual({ kind: "mcp", id: "opengeni" });
    expect(continuation!.metadata.autoContinuation).toBe(1);

    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const continuationEvent = events.find((event) => event.type === "goal.continuation");
    expect(continuationEvent).toBeTruthy();
    expect(continuation!.triggerEventId).toBe(continuationEvent!.id);
    expect(
      events.some((event) => event.type === "turn.queued" && event.turnId === continuation!.id),
    ).toBe(true);
    const usage = await listUsageEvents(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
    });
    expect(
      usage.some(
        (event) =>
          event.eventType === "agent_run.created" && event.sourceResourceId === continuation!.id,
      ),
    ).toBe(true);

    // While the continuation turn is queued the queue wins.
    expect(
      (
        await activities.maybeContinueGoal({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          workflowId: `session-${session.id}`,
        })
      ).action,
    ).toBe("queue");

    // The continuation finishes without tool calls; goalNoProgressLimit 1
    // pauses the goal on the next pass with a visible event.
    await finishTurn(dbClient.db, grant.workspaceId, continuation!.id, "completed");
    const second = await activities.maybeContinueGoal({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
    });
    expect(second.action).toBe("paused");
    const goal = await getSessionGoal(dbClient.db, grant.workspaceId, session.id);
    expect(goal?.status).toBe("paused");
    expect(goal?.pausedReason).toBe("no_progress");
    const afterEvents = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const pausedEvent = afterEvents.find((event) => event.type === "goal.paused");
    expect(pausedEvent).toBeTruthy();
    expect((pausedEvent!.payload as { reason?: string }).reason).toBe("no_progress");
  });

  test("pauses goals on exhausted budgets without consuming continuation budget", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "budget goal",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "objective beyond the budget",
      createdBy: "api",
    });
    const activities = createActivities({
      // Managed limits with a zero credit balance block new agent runs.
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        usageLimitsMode: "managed",
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });
    const result = await activities.maybeContinueGoal({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
    });
    expect(result.action).toBe("paused");
    const goal = await getSessionGoal(dbClient.db, grant.workspaceId, session.id);
    expect(goal?.status).toBe("paused");
    expect(goal?.pausedReason).toBe("limits");
    expect(goal?.rationale).toBe("insufficient OpenGeni credits");
    // The limits pause happened before the counter bump: no budget consumed,
    // no continuation turn synthesized.
    expect(goal?.autoContinuations).toBe(0);
    expect(await listSessionTurns(dbClient.db, grant.workspaceId, session.id)).toHaveLength(0);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const pausedEvent = events.find((event) => event.type === "goal.paused");
    expect((pausedEvent?.payload as { reason?: string } | undefined)?.reason).toBe("limits");
  });

  test("user interrupts pause active goals even when no turn is active", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "interrupt me",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "long objective",
      createdBy: "api",
    });
    const [interruptEvent] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.interrupt", payload: {} },
    ]);
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    // The interrupt landed after the turn cleared activeTurnId; the goal must
    // still pause so the loop does not auto-continue what the user stopped.
    await activities.interruptActiveTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: interruptEvent!.id,
      workflowId: `session-${session.id}`,
    });
    const goal = await getSessionGoal(dbClient.db, grant.workspaceId, session.id);
    expect(goal?.status).toBe("paused");
    expect(goal?.pausedReason).toBe("user_interrupt");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const pausedEvents = events.filter((event) => event.type === "goal.paused");
    expect(pausedEvents).toHaveLength(1);
    expect((pausedEvents[0]!.payload as { actor?: string }).actor).toBe("user");

    // Idempotent: a second interrupt pause emits no duplicate event.
    await activities.pauseGoalForInterrupt({
      workspaceId: grant.workspaceId,
      sessionId: session.id,
    });
    const after = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(after.filter((event) => event.type === "goal.paused")).toHaveLength(1);

    // And a paused goal declines continuation.
    expect(
      (
        await activities.maybeContinueGoal({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          workflowId: `session-${session.id}`,
        })
      ).action,
    ).toBe("none");
  });

  test("steer interrupts cancel the active turn without pausing the goal", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "steer me",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "long objective",
      createdBy: "api",
    });
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });
    const workflowId = `session-${session.id}`;
    const [messageTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "steer me" } },
    ]);
    await enqueueSessionTurn(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: messageTrigger!.id,
      temporalWorkflowId: workflowId,
      source: "user",
      prompt: "steer me",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "low",
      sandboxBackend: "none",
      metadata: {},
    });
    const claimed = await activities.claimNextQueuedTurn({
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      workflowId,
    });
    expect(claimed).not.toBeNull();

    // A steer interrupt (`reason: "steer"`, sent by steerMessage) cancels the
    // running turn to deliver the steered message next — redirection, not a
    // stop — so the goal loop must stay active.
    const [steerEvent] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.interrupt", payload: { reason: "steer" } },
    ]);
    await activities.interruptActiveTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: steerEvent!.id,
      workflowId,
    });
    const turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turns.find((turn) => turn.id === claimed!.id)?.status).toBe("cancelled");
    const goal = await getSessionGoal(dbClient.db, grant.workspaceId, session.id);
    expect(goal?.status).toBe("active");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.filter((event) => event.type === "goal.paused")).toHaveLength(0);
    expect(events.filter((event) => event.type === "turn.cancelled")).toHaveLength(1);

    // The idle-path pause activity also recognizes the steer tag.
    await activities.pauseGoalForInterrupt({
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: steerEvent!.id,
    });
    expect((await getSessionGoal(dbClient.db, grant.workspaceId, session.id))?.status).toBe(
      "active",
    );

    // A plain stop (no steer tag) still pauses the goal.
    const [stopEvent] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.interrupt", payload: {} },
    ]);
    await activities.pauseGoalForInterrupt({
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: stopEvent!.id,
    });
    const paused = await getSessionGoal(dbClient.db, grant.workspaceId, session.id);
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedReason).toBe("user_interrupt");
  });

  test("scheduled tasks with goals arm and re-arm session goals on dispatch", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "maintain staging",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "skip",
      agentConfig: {
        prompt: "keep staging healthy",
        resources: [],
        tools: [],
        metadata: {},
        goal: { text: "staging healthy", successCriteria: "all probes green" },
      },
      metadata: {},
    });
    const activities = createActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        mcpServers: [
          {
            id: "opengeni",
            name: "OpenGeni",
            url: "http://127.0.0.1:65532/v1/workspaces/{workspaceId}/mcp",
            cacheToolsList: true,
          },
        ],
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    const firstDispatch = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });
    expect(firstDispatch.action).toBe("start");
    const goal = await getSessionGoal(dbClient.db, grant.workspaceId, firstDispatch.sessionId);
    expect(goal?.status).toBe("active");
    expect(goal?.createdBy).toBe("scheduled_task");
    expect(goal?.successCriteria).toBe("all probes green");
    const session = await getSession(dbClient.db, grant.workspaceId, firstDispatch.sessionId);
    expect(session?.tools).toContainEqual({ kind: "mcp", id: "opengeni" });
    const events = await listSessionEvents(
      dbClient.db,
      grant.workspaceId,
      firstDispatch.sessionId,
      0,
      50,
    );
    expect(events.map((event) => event.type).slice(0, 3)).toEqual([
      "session.created",
      "goal.set",
      "user.message",
    ]);

    // The goal paused between fires; the next fire re-arms it.
    await activities.pauseGoalForInterrupt({
      workspaceId: grant.workspaceId,
      sessionId: firstDispatch.sessionId,
    });
    const secondDispatch = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });
    expect(secondDispatch.action).toBe("signal");
    expect(secondDispatch.sessionId).toBe(firstDispatch.sessionId);
    const rearmed = await getSessionGoal(dbClient.db, grant.workspaceId, firstDispatch.sessionId);
    expect(rearmed?.status).toBe("active");
    expect(rearmed?.autoContinuations).toBe(0);
    const rearmEvents = await listSessionEvents(
      dbClient.db,
      grant.workspaceId,
      firstDispatch.sessionId,
      0,
      100,
    );
    const goalSetEvents = rearmEvents.filter((event) => event.type === "goal.set");
    expect(goalSetEvents).toHaveLength(2);
    expect((goalSetEvents[1]!.payload as { replaced?: boolean }).replaced).toBe(true);
  });

  test("runs goal continuation turns through the agent with saved context", async () => {
    const model = new ScriptedModel([
      { outputText: "initial work", chunks: ["initial ", "work"] },
      { outputText: "continued work", chunks: ["continued ", "work"] },
    ]);
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "start",
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
    const [userTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "start" } },
    ]);
    expect(
      (
        await activities.runAgentTurn({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          triggerEventId: userTrigger!.id,
          workflowId: "workflow-goal-continuation",
        })
      ).status,
    ).toBe("idle");

    const [goalTrigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "goal.continuation", payload: { text: "[GOAL CONTINUATION 1/20] keep going" } },
    ]);
    const turn = await enqueueSessionTurn(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: goalTrigger!.id,
      temporalWorkflowId: "workflow-goal-continuation",
      source: "goal",
      prompt: "[GOAL CONTINUATION 1/20] keep going",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "low",
      sandboxBackend: "none",
      metadata: {},
    });
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: goalTrigger!.id,
      workflowId: "workflow-goal-continuation",
      turnId: turn.id,
    });
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    const completions = events.filter((event) => event.type === "turn.completed");
    expect(completions).toHaveLength(2);
    expect((completions[1]!.payload as { output?: string }).output).toBe("continued work");
    // The continuation reused the saved run state from the first turn.
    expect(JSON.stringify(model.requests[1])).toContain("initial work");
  });

  test("requeueTurnAfterWorkerDeath requeues from dual-written truth and bounds crash loops", async () => {
    const grant = await testGrant(dbClient.db);
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      sessionHistorySource: "items",
    });
    const activities = createActivities({
      settings,
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "unused" }]),
      }),
    });
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "long job",
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "long job" } },
    ]);
    const workflowId = `session-${session.id}`;
    await enqueueSessionTurn(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId: trigger!.id,
      temporalWorkflowId: workflowId,
      source: "user",
      prompt: "long job",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: settings.openaiReasoningEffort,
      sandboxBackend: "none",
      metadata: {},
    });
    const claimScope = { workspaceId: grant.workspaceId, sessionId: session.id, workflowId };
    const claimed = await activities.claimNextQueuedTurn(claimScope);
    expect(claimed).not.toBeNull();
    const turnId = claimed!.id;
    const requeueInput = (triggerEventId: string) => ({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      triggerEventId,
      workflowId,
      turnId,
    });

    // Death before any checkpoint: the original trigger replays cleanly.
    expect(await activities.requeueTurnAfterWorkerDeath(requeueInput(trigger!.id))).toEqual({
      action: "requeued",
      redispatches: 1,
    });
    let turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turns.map((turn) => turn.status)).toEqual(["queued"]);
    expect(turns[0]?.triggerEventId).toBe(trigger!.id);
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("queued");
    let events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    let preemptions = events.filter((event) => event.type === "turn.preempted");
    expect(preemptions).toHaveLength(1);
    expect(preemptions[0]!.payload as Record<string, unknown>).toMatchObject({
      reason: "worker_death",
      resumeWithNotice: false,
    });

    // Death after the turn checkpointed conversation truth: the rerun enters
    // through a synthesized resume notice instead of replaying input the
    // model has already seen.
    await activities.claimNextQueuedTurn(claimScope);
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId,
      items: [{ position: 0, item: { type: "message", role: "user", content: "long job" } }],
    });
    expect(await activities.requeueTurnAfterWorkerDeath(requeueInput(trigger!.id))).toEqual({
      action: "requeued",
      redispatches: 2,
    });
    events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    preemptions = events.filter((event) => event.type === "turn.preempted");
    expect(preemptions).toHaveLength(2);
    const notice = preemptions[1]!;
    expect(notice.payload as Record<string, unknown>).toMatchObject({
      reason: "worker_death",
      resumeWithNotice: true,
      text: WORKER_DEATH_RESUME_TEXT,
    });
    turns = await listSessionTurns(dbClient.db, grant.workspaceId, session.id);
    expect(turns[0]?.status).toBe("queued");
    expect(turns[0]?.triggerEventId).toBe(notice.id);

    // Crash-loop guard: the counter persists on the turn row; past the
    // ceiling the activity refuses so the workflow fails the session for real.
    await activities.claimNextQueuedTurn(claimScope);
    expect(await activities.requeueTurnAfterWorkerDeath(requeueInput(notice.id))).toEqual({
      action: "requeued",
      redispatches: WORKER_DEATH_MAX_REDISPATCHES,
    });
    await activities.claimNextQueuedTurn(claimScope);
    expect(await activities.requeueTurnAfterWorkerDeath(requeueInput(notice.id))).toEqual({
      action: "exceeded",
      redispatches: WORKER_DEATH_MAX_REDISPATCHES,
    });

    // A settled turn (the timed-out attempt was a zombie that actually
    // finished) is left untouched.
    await finishTurn(dbClient.db, grant.workspaceId, turnId, "idle");
    expect(await activities.requeueTurnAfterWorkerDeath(requeueInput(notice.id))).toEqual({
      action: "stale",
    });
  });

  // Parent wakeup: a spawned worker reaching a terminal-for-now state must
  // wake its manager (parent) session exactly once so the manager can resume,
  // read the worker's output, and continue — no busy-polling, no stall.
  function wakeActivities(wakes: Array<{ sessionId: string; workflowId: string }>) {
    return createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      wakeSessionWorkflow: async ({ sessionId, workflowId }) => {
        wakes.push({ sessionId, workflowId });
      },
    });
  }

  async function makeManagerIdle(grant: AccessGrant) {
    const manager = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "orchestrate",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    // A manager that spawned a worker and is now idle awaiting it.
    await setSessionStatus(dbClient.db, grant.workspaceId, manager.id, "idle", null);
    return manager;
  }

  test("waking the parent: a worker that goes idle queues exactly one manager turn", async () => {
    const grant = await testGrant(dbClient.db);
    const manager = await makeManagerIdle(grant);
    const worker = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "do the work",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      parentSessionId: manager.id,
    });
    // Simulate the worker having done a turn: it produced events and is running
    // when the workflow decides to idle it.
    await appendOwnedEvents(dbClient.db, grant, worker.id, [
      { type: "user.message", payload: { text: "do the work" } },
      { type: "turn.completed", payload: { output: "done" } },
    ]);
    await setSessionStatus(dbClient.db, grant.workspaceId, worker.id, "running", null);

    const wakes: Array<{ sessionId: string; workflowId: string }> = [];
    const activities = wakeActivities(wakes);
    await activities.markSessionIdle({ workspaceId: grant.workspaceId, sessionId: worker.id });

    // The manager was woken: it has a queued turn and is back to queued.
    const managerAfter = await getSession(dbClient.db, grant.workspaceId, manager.id);
    expect(managerAfter?.status).toBe("queued");
    const managerTurns = await listSessionTurns(dbClient.db, grant.workspaceId, manager.id, 10);
    expect(managerTurns).toHaveLength(1);
    expect(managerTurns[0]?.status).toBe("queued");
    // The wake message names the worker and reuses the user.message path.
    const managerEvents = await listSessionEvents(
      dbClient.db,
      grant.workspaceId,
      manager.id,
      0,
      50,
    );
    const wake = managerEvents.find((event) => event.type === "user.message");
    expect(wake).toBeDefined();
    expect(JSON.stringify(wake?.payload)).toContain(worker.id);
    expect(JSON.stringify(wake?.payload)).toContain("gone idle");
    // The parent workflow was signalled (signalWithStart) so an already-drained
    // manager run gets restarted to claim the queued turn.
    expect(wakes).toEqual([{ sessionId: manager.id, workflowId: `session-${manager.id}` }]);

    // Idempotent: re-running the SAME terminal transition (activity retry, the
    // workflow's idle re-check) does not enqueue a second manager turn.
    await activities.markSessionIdle({ workspaceId: grant.workspaceId, sessionId: worker.id });
    const managerTurnsAfterRetry = await listSessionTurns(
      dbClient.db,
      grant.workspaceId,
      manager.id,
      10,
    );
    expect(managerTurnsAfterRetry).toHaveLength(1);
    expect(wakes).toHaveLength(1);
  });

  test("waking the parent: a genuinely new idle-after-work episode notifies again, churn does not", async () => {
    const grant = await testGrant(dbClient.db);
    const manager = await makeManagerIdle(grant);
    const worker = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "do the work",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      parentSessionId: manager.id,
    });
    await appendOwnedEvents(dbClient.db, grant, worker.id, [
      { type: "turn.completed", payload: { output: "batch 1" } },
    ]);
    await setSessionStatus(dbClient.db, grant.workspaceId, worker.id, "running", null);

    const wakes: Array<{ sessionId: string; workflowId: string }> = [];
    const activities = wakeActivities(wakes);
    await activities.markSessionIdle({ workspaceId: grant.workspaceId, sessionId: worker.id });
    expect(wakes).toHaveLength(1);

    // idle -> queued -> idle with NO intervening work (same lastSequence) does
    // not spam: the worker is re-queued and idled again without new events.
    await setSessionStatus(dbClient.db, grant.workspaceId, worker.id, "queued", null);
    await setSessionStatus(dbClient.db, grant.workspaceId, worker.id, "running", null);
    await activities.markSessionIdle({ workspaceId: grant.workspaceId, sessionId: worker.id });
    expect(wakes).toHaveLength(1);

    // A genuinely new work episode (new events advance lastSequence) before the
    // next idle DOES notify the manager again — managers expect to be woken on
    // each batch of worker progress, which is correct re-entrant behavior.
    await appendOwnedEvents(dbClient.db, grant, worker.id, [
      { type: "turn.completed", payload: { output: "batch 2" } },
    ]);
    await setSessionStatus(dbClient.db, grant.workspaceId, worker.id, "running", null);
    await activities.markSessionIdle({ workspaceId: grant.workspaceId, sessionId: worker.id });
    expect(wakes).toHaveLength(2);

    const managerTurns = await listSessionTurns(dbClient.db, grant.workspaceId, manager.id, 10);
    expect(managerTurns).toHaveLength(2);
  });

  test("waking the parent: a failed worker wakes the manager, and a parentless session never notifies", async () => {
    const grant = await testGrant(dbClient.db);
    const manager = await makeManagerIdle(grant);
    const worker = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "do the work",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      parentSessionId: manager.id,
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, worker.id, [
      { type: "user.message", payload: { text: "do the work" } },
    ]);
    await setSessionStatus(dbClient.db, grant.workspaceId, worker.id, "running", null);

    const wakes: Array<{ sessionId: string; workflowId: string }> = [];
    const activities = wakeActivities(wakes);
    await activities.failSession({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: worker.id,
      triggerEventId: trigger!.id,
      workflowId: `session-${worker.id}`,
      error: "boom",
    });
    expect(wakes).toEqual([{ sessionId: manager.id, workflowId: `session-${manager.id}` }]);
    const managerEvents = await listSessionEvents(
      dbClient.db,
      grant.workspaceId,
      manager.id,
      0,
      50,
    );
    const wake = managerEvents.find((event) => event.type === "user.message");
    expect(JSON.stringify(wake?.payload)).toContain("FAILED");

    // A parentless session (a top-level session, a scheduled run) never wakes
    // anyone: no parent_session_id, no notification, no spurious turns.
    const lonely = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "standalone",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendOwnedEvents(dbClient.db, grant, lonely.id, [
      { type: "turn.completed", payload: { output: "done" } },
    ]);
    await setSessionStatus(dbClient.db, grant.workspaceId, lonely.id, "running", null);
    const wakesBefore = wakes.length;
    await activities.markSessionIdle({ workspaceId: grant.workspaceId, sessionId: lonely.id });
    expect(wakes).toHaveLength(wakesBefore);
  });

  test("waking the parent: a worker that dies INSIDE its turn (not via failSession) still wakes the manager", async () => {
    // The common failure path: runAgentTurn marks the session failed and
    // returns "failed", and the session workflow exits WITHOUT calling
    // failSession/markSessionIdle. The wake must fire from runAgentTurn too.
    const grant = await testGrant(dbClient.db);
    const manager = await makeManagerIdle(grant);
    const worker = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "do the work",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      parentSessionId: manager.id,
    });
    const [trigger] = await appendOwnedEvents(dbClient.db, grant, worker.id, [
      { type: "user.message", payload: { text: "do the work" } },
    ]);
    const wakes: Array<{ sessionId: string; workflowId: string }> = [];
    const activities = createActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error: new Error("worker exploded mid-turn") }]),
      }),
      wakeSessionWorkflow: async ({ sessionId, workflowId }) => {
        wakes.push({ sessionId, workflowId });
      },
    });
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: worker.id,
      triggerEventId: trigger!.id,
      workflowId: `session-${worker.id}`,
    });
    expect(result.status).toBe("failed");
    expect((await getSession(dbClient.db, grant.workspaceId, worker.id))?.status).toBe("failed");
    // The manager was woken with a FAILED wake even though failSession never ran.
    expect(wakes).toEqual([{ sessionId: manager.id, workflowId: `session-${manager.id}` }]);
    const managerEvents = await listSessionEvents(
      dbClient.db,
      grant.workspaceId,
      manager.id,
      0,
      50,
    );
    const wake = managerEvents.find((event) => event.type === "user.message");
    expect(JSON.stringify(wake?.payload)).toContain("FAILED");
    expect(JSON.stringify(wake?.payload)).toContain(worker.id);
    const managerTurns = await listSessionTurns(dbClient.db, grant.workspaceId, manager.id, 10);
    expect(managerTurns).toHaveLength(1);

    // If the activity's finally throws after the failed return, Temporal fails
    // the activity and the workflow calls failSession on the already-failed
    // session. That must NOT wake the manager a second time nor re-append
    // terminal events: failSession no-ops on an already-failed session.
    const workerEventsBefore = (
      await listSessionEvents(dbClient.db, grant.workspaceId, worker.id, 0, 200)
    ).length;
    await activities.failSession({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: worker.id,
      triggerEventId: trigger!.id,
      workflowId: `session-${worker.id}`,
      error: "redundant failSession after in-turn failure",
    });
    expect(wakes).toHaveLength(1);
    expect(await listSessionTurns(dbClient.db, grant.workspaceId, manager.id, 10)).toHaveLength(1);
    const workerEventsAfter = (
      await listSessionEvents(dbClient.db, grant.workspaceId, worker.id, 0, 200)
    ).length;
    expect(workerEventsAfter).toBe(workerEventsBefore);
  });

  test("maybeCompactContext compacts an over-budget Azure session into [user messages..., summary]", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "long session",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    // Two old turns with a tool-call pair each, then one recent turn. Positions
    // are absolute and contiguous.
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "old turn 1" } },
        {
          position: 1,
          item: { type: "function_call", callId: "c0", name: "shell", arguments: "{}" },
        },
        {
          position: 2,
          item: { type: "function_call_result", callId: "c0", status: "completed", output: "ok0" },
        },
        {
          position: 3,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "a1" }],
          },
        },
        { position: 4, item: { type: "message", role: "user", content: "old turn 2" } },
        {
          position: 5,
          item: { type: "function_call", callId: "c1", name: "shell", arguments: "{}" },
        },
        {
          position: 6,
          item: { type: "function_call_result", callId: "c1", status: "completed", output: "ok1" },
        },
        {
          position: 7,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "a2" }],
          },
        },
        { position: 8, item: { type: "message", role: "user", content: "recent turn" } },
        {
          position: 9,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "a3" }],
          },
        },
      ],
    });

    // Azure provider -> client mode. Force a tiny keep budget so only the recent
    // turn (positions 8..9) is kept verbatim, and a last-turn token count above
    // the soft threshold so the trigger fires.
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      sessionHistorySource: "items",
      openaiProvider: "azure",
      contextCompactionMode: "auto",
      contextWindowTokens: 1000,
      contextReservedOutputTokens: 0,
      contextCompactSoftFraction: 0.5,
      contextKeepRecentTokens: 40,
    });

    let summarizerCalls = 0;
    const result = await maybeCompactContext(
      dbClient.db,
      settings,
      { accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id },
      900, // last-turn input tokens, well above soft = 500
      async (_s, messages) => {
        summarizerCalls += 1;
        // The summarizer sees the current active history plus Codex's checkpoint prompt.
        expect(
          messages.some((item) =>
            String((item as Record<string, unknown>).content).includes("old turn 1"),
          ),
        ).toBe(true);
        expect(
          messages.some((item) =>
            String((item as Record<string, unknown>).content).includes("old turn 2"),
          ),
        ).toBe(true);
        expect(
          messages.some((item) =>
            String((item as Record<string, unknown>).content).includes("recent turn"),
          ),
        ).toBe(true);
        expect(String((messages.at(-1) as Record<string, unknown> | undefined)?.content)).toContain(
          "CONTEXT CHECKPOINT COMPACTION",
        );
        return "objective: ship; blocker: none; next: continue. Durable facts are in the notebook (pointers only).";
      },
    );

    expect(summarizerCalls).toBe(1);
    expect(result.compacted).toBe(true);

    // Active read path now returns retained user messages followed by one
    // summary; assistant/tool rows remain only in the audit trail.
    const active = await getActiveSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    const types = active.map((row) => (row.item as Record<string, unknown>).type);
    expect((active.at(-1)!.item as Record<string, unknown>).opengeni_context_summary).toBe(true);
    expect(active.some((row) => (row.item as Record<string, unknown>).callId === "c0")).toBe(false);
    expect(active.some((row) => (row.item as Record<string, unknown>).callId === "c1")).toBe(false);
    expect(active.slice(0, -1).map((row) => (row.item as Record<string, unknown>).content)).toEqual(
      ["old turn 1", "old turn 2", "recent turn"],
    );
    expect(types).not.toContain("function_call_result");
    expect(active.every((row) => (row.item as Record<string, unknown>).role === "user")).toBe(true);

    // Audit trail intact: ALL ten seeded rows still present (none overwritten),
    // plus three retained user-message replacement rows and one summary row.
    const all = await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(all.length).toBe(14);
    expect(
      all.filter((row) => (row.item as Record<string, unknown>).opengeni_context_summary === true),
    ).toHaveLength(1);
    // Every original seeded position (0..9) survives verbatim — in particular the
    // assistant 'a2' at position 7 that the half-step before the boundary used to
    // overwrite is untouched.
    for (let position = 0; position <= 9; position += 1) {
      expect(all.some((row) => row.position === position)).toBe(true);
    }
    const seededAssistant = all.find((row) => row.position === 7);
    expect(seededAssistant!.item).toMatchObject({
      role: "assistant",
      content: [{ type: "output_text", text: "a2" }],
    });
  });

  test("maybeCompactContext records the summary under the current turn (per-turn count stays correct)", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "turn-count session",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    // Prefix rows belong to an OLD turn; the summary must NOT inherit that turn's
    // id. The overwrite bug (onConflictDoUpdate set only {item, active}) left the
    // summary stranded under the prefix row's turn_id, so the compaction turn's
    // per-turn count (the worker-death resume-with-notice signal) miscounted.
    const oldTurnId = await createTurn(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      temporalWorkflowId: `wf-old-${crypto.randomUUID()}`,
      triggerEventId: crypto.randomUUID(),
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: oldTurnId,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "old turn 1" } },
        {
          position: 1,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "a1" }],
          },
        },
        { position: 2, item: { type: "message", role: "user", content: "old turn 2" } },
        {
          position: 3,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "a2" }],
          },
        },
        { position: 4, item: { type: "message", role: "user", content: "recent turn" } },
        {
          position: 5,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "a3" }],
          },
        },
      ],
    });
    const compactionTurnId = await createTurn(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      temporalWorkflowId: `wf-new-${crypto.randomUUID()}`,
      triggerEventId: crypto.randomUUID(),
    });

    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      sessionHistorySource: "items",
      openaiProvider: "azure",
      contextCompactionMode: "auto",
      contextWindowTokens: 1000,
      contextReservedOutputTokens: 0,
      contextCompactSoftFraction: 0.5,
      contextKeepRecentTokens: 40,
    });

    const result = await maybeCompactContext(
      dbClient.db,
      settings,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        turnId: compactionTurnId,
      },
      900,
      async () => "objective: ship; durable facts in the notebook (pointers only).",
    );
    expect(result.compacted).toBe(true);

    // The summary is attributed to the compaction turn, not the prefix's old
    // turn — so the per-turn count used by the worker-death resume decision sees
    // exactly the one row this turn wrote.
    expect(
      await countTurnSessionHistoryItems(dbClient.db, grant.workspaceId, compactionTurnId),
    ).toBe(1);
    expect(await countTurnSessionHistoryItems(dbClient.db, grant.workspaceId, oldTurnId)).toBe(6);
  });

  test("maybeCompactContext is a no-op on the OpenAI platform (server path owns compaction there)", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "server-mode",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "u" } },
        {
          position: 1,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "a" }],
          },
        },
      ],
    });
    let called = false;
    const result = await maybeCompactContext(
      dbClient.db,
      testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
        openaiProvider: "openai",
        contextCompactionMode: "auto",
      }),
      { accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id },
      9_000_000,
      async () => {
        called = true;
        return "x";
      },
    );
    expect(result).toEqual({ compacted: false, reason: "mode_not_client" });
    expect(called).toBe(false);
  });

  test("maybeCompactContext falls back deterministically when the summarizer hard-fails", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "summarize-fail",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "old" } },
        {
          position: 1,
          item: { type: "message", role: "assistant", content: "x".repeat(50_000 * 4) },
        },
        { position: 2, item: { type: "message", role: "user", content: "recent" } },
        {
          position: 3,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "a2" }],
          },
        },
      ],
    });
    let attempts = 0;
    const result = await maybeCompactContext(
      dbClient.db,
      testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        sessionHistorySource: "items",
        openaiProvider: "azure",
        contextCompactionMode: "client",
        contextWindowTokens: 1000,
        contextReservedOutputTokens: 0,
        contextCompactSoftFraction: 0.5,
        contextKeepRecentTokens: 30,
      }),
      { accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id },
      900,
      async (_settings, _messages, options) => {
        attempts += 1;
        if (attempts === 2) {
          expect(options?.attempt).toBe("hard_trim");
          expect(options?.maxTranscriptTokens).toBeGreaterThan(0);
        }
        return null;
      },
    );
    expect(result.compacted).toBe(true);
    expect(result.compacted && result.method).toBe("fallback");
    expect(attempts).toBe(2);
    const active = await getActiveSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(
      active.some((row) =>
        String((row.item as Record<string, unknown>).content).includes(
          "Non-LLM context compaction fallback",
        ),
      ),
    ).toBe(true);
    expect(
      active.some(
        (row) => (row.item as Record<string, unknown>).content === "x".repeat(50_000 * 4),
      ),
    ).toBe(false);
  });

  test("maybeCompactContext force bypasses the budget trigger (the /compact path)", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "force-compact",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await appendSessionHistoryItems(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      items: [
        { position: 0, item: { type: "message", role: "user", content: "old turn 1" } },
        {
          position: 1,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "a1" }],
          },
        },
        { position: 2, item: { type: "message", role: "user", content: "recent turn" } },
        {
          position: 3,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "a2" }],
          },
        },
      ],
    });
    // A budget so high the soft trigger would never fire on its own.
    const settings = testSettings({
      databaseUrl: services.databaseUrl,
      natsUrl: services.natsUrl,
      sessionHistorySource: "items",
      openaiProvider: "azure",
      contextCompactionMode: "client",
      contextWindowTokens: 10_000_000,
      contextReservedOutputTokens: 0,
      contextCompactSoftFraction: 0.9,
      contextKeepRecentTokens: 20,
    });
    const scope = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
    };
    const summarize = async () => "summary of the old prefix.";

    // Without force, the tiny token count is below budget -> no-op.
    const skipped = await maybeCompactContext(dbClient.db, settings, scope, 10, summarize, {});
    expect(skipped.compacted).toBe(false);

    // With force, it compacts despite being below budget.
    const forced = await maybeCompactContext(dbClient.db, settings, scope, 10, summarize, {
      force: true,
    });
    expect(forced.compacted).toBe(true);
    const active = await getActiveSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect((active.at(-1)!.item as Record<string, unknown>).opengeni_context_summary).toBe(true);
    expect(active.slice(0, -1).map((row) => (row.item as Record<string, unknown>).content)).toEqual(
      ["old turn 1", "recent turn"],
    );
  });
});

type TestDb = ReturnType<typeof createDb>["db"];

const workerEnvironmentsKey = Buffer.alloc(32, 8).toString("base64");

async function seedWorkspaceEnvironment(
  db: TestDb,
  grant: AccessGrant,
  values: Record<string, string>,
  description?: string,
): Promise<{ id: string; name: string }> {
  const key = new Uint8Array(Buffer.from(workerEnvironmentsKey, "base64"));
  const environment = await createWorkspaceEnvironment(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    name: `worker-env-${crypto.randomUUID()}`,
    ...(description !== undefined ? { description } : {}),
  });
  for (const [name, value] of Object.entries(values)) {
    await setWorkspaceEnvironmentVariable(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      environmentId: environment.id,
      name,
      valueEncrypted: encryptEnvironmentValue(key, value),
    });
  }
  return { id: environment.id, name: environment.name };
}

async function testGrant(db: TestDb): Promise<AccessGrant> {
  const id = crypto.randomUUID();
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:worker",
    accountExternalId: `account:${id}`,
    accountName: "Worker integration account",
    workspaceExternalSource: "test:worker",
    workspaceExternalId: `workspace:${id}`,
    workspaceName: "Worker integration workspace",
    subjectId: `test:worker:${id}`,
    subjectLabel: "Worker integration",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) {
    throw new Error("Worker test did not create a workspace grant");
  }
  return grant;
}

async function createOwnedSession(
  db: TestDb,
  grant: AccessGrant,
  input: Omit<Parameters<typeof createSession>[1], "accountId" | "workspaceId">,
) {
  return await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ...input,
  });
}

async function appendOwnedEvents(
  db: TestDb,
  grant: AccessGrant,
  sessionId: string,
  events: Parameters<typeof appendSessionEvents>[3],
) {
  return await appendSessionEvents(db, grant.workspaceId, sessionId, events);
}

async function createOwnedFileUpload(
  db: TestDb,
  grant: AccessGrant,
  input: Omit<Parameters<typeof createFileUpload>[1], "accountId" | "workspaceId">,
) {
  return await createFileUpload(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ...input,
  });
}

async function createOwnedScheduledTask(
  db: TestDb,
  grant: AccessGrant,
  input: Omit<Parameters<typeof createScheduledTask>[1], "accountId" | "workspaceId">,
) {
  return await createScheduledTask(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ...input,
  });
}

function contextOverflowError(message: string): Error {
  const error = new Error(message);
  Object.assign(error, { status: 400, code: "context_length_exceeded" });
  return error;
}

function runtimeWithCompactionClient(
  model: ScriptedModel,
  create: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
): OpenGeniRuntime {
  const runtime = createProductionAgentRuntime({ model });
  const fakeClient = {
    responses: {
      create,
    },
  };
  return {
    ...runtime,
    resolveTurnModel: () =>
      ({
        provider: { kind: "api-key", api: "responses", compactionMode: "client" },
        client: fakeClient,
        model: {} as never,
        configured: { id: "scripted-model", hostedWebSearch: false },
      }) as never,
  };
}

function runtimeWithFakeCompactionSummarizer(
  model: ScriptedModel,
  summary: string,
): OpenGeniRuntime {
  return runtimeWithCompactionClient(model, async () => ({ output_text: summary }));
}

function fakeObjectStorage(body: string): ObjectStorage {
  return {
    bucket: "test",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    createPutUrl: async () => ({
      url: "https://storage.example.test/put",
      requiredHeaders: {},
      expiresAt: new Date(Date.now() + 60_000),
    }),
    createGetUrl: async () => ({
      url: "https://storage.example.test/get",
      expiresAt: new Date(Date.now() + 60_000),
    }),
    headFile: async () => ({
      ContentLength: new TextEncoder().encode(body).byteLength,
      ContentType: "text/plain",
    }),
    getFileBytes: async () => new TextEncoder().encode(body),
  };
}

function startOfUtcMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
