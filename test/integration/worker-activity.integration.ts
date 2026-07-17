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
import * as dbSchema from "../../packages/db/src/schema";
import {
  appendSessionEvents,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  completeFileUpload,
  applyCreditLedgerEntry,
  claimSessionWorkForAttempt,
  createDb,
  createFileUpload,
  createScheduledTask,
  createSession,
  createSessionGoal,
  createWorkspaceEnvironment,
  dbSql,
  encryptEnvironmentValue,
  enablePackInstallation,
  registerWorkspacePack,
  setWorkspaceEnvironmentVariable,
  getSession,
  getSessionGoal,
  getBillingBalance,
  getActiveSessionHistoryItems,
  getLatestRunState,
  getSessionHistoryItems,
  listSessions,
  listOutstandingSessionSystemUpdates,
  listSessionTurns,
  listUsageEvents,
  listSessionEvents,
  listScheduledTaskRuns,
  recordUsageEvent,
  requireScheduledTask,
  saveRunState,
  mutateWorkspaceControlInTransaction,
  sumUsageQuantity,
  updateScheduledTask,
  withWorkspaceRls,
  type Database,
} from "@opengeni/db";
import { submitTestHumanPrompt } from "./helpers/session-control";
import type { AccessGrant, SessionStatus } from "@opengeni/contracts";
import { createNatsEventBus, type EventBus } from "@opengeni/events";
import { createObservability } from "@opengeni/observability";
import {
  createProductionAgentRuntime,
  MaxTurnsExceededError,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { createActivityTestHarness as createWorkerActivities } from "../../apps/worker/src/activities";
import { createApp, type SessionWorkflowClient } from "../../apps/api/src/app";
import { PROVIDER_BACKPRESSURE_DELAY_MS } from "../../apps/worker/src/activities/agent-turn";
import {
  loadWorkspaceEnvironmentForRun,
  sandboxEnvironmentForRun,
} from "../../apps/worker/src/activities/environment";
import { settingsWithSessionMcpServersForRun } from "../../apps/worker/src/activities/capabilities";
import {
  ScriptedModel,
  functionCall,
  latestStatus,
  startTestMcpServer,
  startTestServices,
  testSettings,
  type TestServices,
} from "@opengeni/testing";

async function setSessionStatus(
  db: Database,
  workspaceId: string,
  sessionId: string,
  status: SessionStatus,
  activeTurnId: string | null = null,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.execute(dbSql`
      update sessions
      set status = ${status}, active_turn_id = ${activeTurnId}, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${sessionId}
    `);
  });
}

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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createWorkerActivities({
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
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: "workflow-activity",
      workflowRunId: crypto.randomUUID(),
    });
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "agent.message.delta")).toBe(true);
    expect(events.some((event) => event.type === "turn.completed")).toBe(true);
    expect(latestStatus(events)).toBe("idle");
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
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
      await appendOwnedEvents(dbClient.db, grant, session.id, [
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
      const activities = createWorkerActivities({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });

      // Turn 1: the tool call is gated — the turn pauses instead of running it.
      const first = await activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-mcp-approval",
        workflowRunId: crypto.randomUUID(),
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
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "approval", triggerEventId: approvalTrigger!.id },
        // Distinct workflowId so the resume's event producerId
        // (`${workflowId}:${turnId}`) does not collide with turn 1's — the real
        // system disambiguates via the Temporal activityId, which is absent here.
        workflowId: "workflow-mcp-approval-resume",
        workflowRunId: crypto.randomUUID(),
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
      requestSessionWorkflowWakeDispatch: async () => undefined,
      signalApprovalDecision: async () => undefined,
      signalSessionControl: async () => undefined,
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
      await appendOwnedEvents(dbClient.db, grant, session.id, [
        { type: "user.message", payload: { text: "list the fleet" } },
      ]);
      const activities = createWorkerActivities({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });
      const result = await activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-manager-mcp",
        workflowRunId: crypto.randomUUID(),
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
      requestSessionWorkflowWakeDispatch: async () => undefined,
      signalApprovalDecision: async () => undefined,
      signalSessionControl: async () => undefined,
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
      await appendOwnedEvents(dbClient.db, grant, manager.id, [
        { type: "user.message", payload: { text: "spawn a worker" } },
      ]);
      const activities = createWorkerActivities({
        settings,
        db: dbClient.db,
        bus,
        runtime: createProductionAgentRuntime({ model }),
      });
      await activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: manager.id,
        trigger: { kind: "next" },
        workflowId: "workflow-spawn-link",
        workflowRunId: crypto.randomUUID(),
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
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "first question" } },
    ]);
    await activities.runAgentTurn({
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: "workflow-followup",
      workflowRunId: crypto.randomUUID(),
    });
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "second question" } },
    ]);
    await activities.runAgentTurn({
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: "workflow-followup",
      workflowRunId: crypto.randomUUID(),
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "look at this", resources: [resource] } },
    ]);
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });

    await activities.runAgentTurn({
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: "workflow-image-context",
      workflowRunId: crypto.randomUUID(),
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "look at this", resources: [resource] } },
    ]);
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });

    await activities.runAgentTurn({
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: "workflow-oversized-image-context",
      workflowRunId: crypto.randomUUID(),
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "should not run", chunks: ["never"] }]),
      }),
    });

    const result = await activities.runAgentTurn({
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: "workflow-pack-image-conflict",
      workflowRunId: crypto.randomUUID(),
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "fail" } },
    ]);
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error: new Error("scripted failure") }]),
      }),
    });

    await expect(
      activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-fail",
        workflowRunId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "failed" });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "turn.failed")).toBe(true);
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "long task" } },
    ]);
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error: new MaxTurnsExceededError("Max turns (40) exceeded") }]),
      }),
    });

    await expect(
      activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-max-turns",
        workflowRunId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "idle" });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    const completed = events.find((event) => event.type === "turn.completed");
    expect(completed?.payload).toEqual({ output: "", segmentLimit: "max_turns" });
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "rate limit" } },
    ]);
    const error = new Error("Too Many Requests");
    Object.assign(error, { status: 429 });
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error }]),
      }),
    });

    await expect(
      activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-rate-limit",
        workflowRunId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "idle" });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const failed = events.find((event) => event.type === "turn.failed");
    expect(failed?.payload).toEqual({
      error: "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
      code: "provider_rate_limited",
      retryable: true,
      recovery: "user_message",
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "rate limit with goal" } },
    ]);
    const error = new Error("Too Many Requests");
    Object.assign(error, { status: 429 });
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ error }]),
      }),
    });

    await expect(
      activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-rate-limit-goal",
        workflowRunId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "idle", continueDelayMs: PROVIDER_BACKPRESSURE_DELAY_MS });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 50);
    const failed = events.find((event) => event.type === "turn.failed");
    expect(failed?.payload).toEqual({
      error: "Model provider rate limit hit. Try again in a minute or lower the reasoning effort.",
      code: "provider_rate_limited",
      retryable: true,
      recovery: "goal_continuation",
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

  test("an MCP stream timeout after a successful tool output checkpoints once and continues the active goal", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createOwnedSession(dbClient.db, grant, {
      initialMessage: "continue after transient MCP transport loss",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "finish without repeating completed tool side effects",
      createdBy: "api",
    });
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "continue after transient MCP transport loss" } },
    ]);
    const callId = "call-before-mcp-timeout";
    const state = {
      history: [
        {
          type: "message",
          role: "user",
          content: "continue after transient MCP transport loss",
        },
        {
          type: "function_call",
          callId,
          name: "opengeni__session_send_message",
          arguments: "{}",
          status: "completed",
        },
        {
          type: "function_call_result",
          callId,
          status: "completed",
          output: { ok: true, durableEventId: "event-once" },
        },
      ],
      usage: {},
      toString: () => "checkpointed-state",
    };
    const baseRuntime = createProductionAgentRuntime({
      model: new ScriptedModel([{ outputText: "unused" }]),
    });
    const runtime: OpenGeniRuntime = {
      ...baseRuntime,
      runStream: async () =>
        ({
          toStream: () =>
            (async function* () {
              yield {
                type: "run_item_stream_event",
                item: {
                  id: "tool-call-item",
                  type: "tool_call_item",
                  rawItem: {
                    callId,
                    type: "function_call",
                    name: "opengeni__session_send_message",
                    arguments: "{}",
                  },
                },
              };
              yield {
                type: "run_item_stream_event",
                item: {
                  id: "tool-output-item",
                  type: "tool_call_output_item",
                  rawItem: { callId, type: "function_call_result" },
                  output: { ok: true, durableEventId: "event-once" },
                },
              };
              // Reproduce the actual escaped boundary: no new tool call is
              // created after the successful output; next-loop MCP transport
              // work rejects the stream iterator instead.
              throw new Error("MCP error -32001: Request timed out");
            })(),
          completed: Promise.resolve(),
          interruptions: [],
          state,
          finalOutput: "",
        }) as never,
    };
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime,
    });

    await expect(
      activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-mcp-timeout-after-output",
        workflowRunId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "idle", continueDelayMs: PROVIDER_BACKPRESSURE_DELAY_MS });

    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    const outputIndex = events.findIndex((event) => event.type === "agent.toolCall.output");
    const failedIndex = events.findIndex((event) => event.type === "turn.failed");
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(failedIndex).toBeGreaterThan(outputIndex);
    expect(events[failedIndex]?.payload).toMatchObject({
      code: "mcp_transport_timeout",
      retryable: true,
      recovery: "goal_continuation",
    });
    expect(events.filter((event) => event.type === "agent.toolCall.output")).toHaveLength(1);
    const activeHistory = await getActiveSessionHistoryItems(
      dbClient.db,
      grant.workspaceId,
      session.id,
    );
    expect(
      activeHistory.filter(
        (row) =>
          (row.item as Record<string, unknown>).type === "function_call_result" &&
          (row.item as Record<string, unknown>).callId === callId,
      ),
    ).toHaveLength(1);
    expect((await getSession(dbClient.db, grant.workspaceId, session.id))?.status).toBe("idle");
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
    const activities = createWorkerActivities({
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
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: crypto.randomUUID(),
        trigger: { kind: "next" },
        workflowId: "workflow-missing-session",
        workflowRunId: crypto.randomUUID(),
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    let updateCalls = 0;
    const failSecondUpdate = (targetDb: typeof dbClient.db): typeof dbClient.db =>
      new Proxy(targetDb, {
        get(target, prop, receiver) {
          if (prop === "transaction") {
            return async (fn: (tx: typeof dbClient.db) => Promise<unknown>, ...args: unknown[]) =>
              await (target.transaction as any)(
                async (tx: typeof dbClient.db) => await fn(failSecondUpdate(tx)),
                ...args,
              );
          }
          const value = Reflect.get(target, prop, receiver);
          if (prop === "update" && typeof value === "function") {
            return (...args: unknown[]) => {
              updateCalls += 1;
              // Atomic claim updates the turn then the session. Failing update 2
              // proves the whole admission transaction rolls back before any
              // turn-start event can become authoritative.
              if (updateCalls === 2) {
                throw new Error("status update failed");
              }
              return value.apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as typeof dbClient.db;
    const failingDb = failSecondUpdate(dbClient.db);
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: failingDb,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "unused" }]),
      }),
    });

    await expect(
      activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-status-update-fails",
        workflowRunId: crypto.randomUUID(),
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "needs approval" } },
    ]);
    const initialAttemptId = crypto.randomUUID();
    const initialClaim = await claimSessionWorkForAttempt(dbClient.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: initialAttemptId,
      dispatchId: `approval-fixture-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (initialClaim.action !== "claimed") {
      throw new Error(`approval fixture was not claimed: ${initialClaim.reason}`);
    }
    const turn = initialClaim.turn;
    await saveRunState(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      turnId: turn.id,
      expectedExecutionGeneration: turn.executionGeneration,
      expectedAttemptId: initialAttemptId,
      serializedRunState: "saved-state",
      pendingApprovals: [{ id: "approval-1" }],
    });
    expect(
      await applySessionTurnSettlement(dbClient.db, grant.workspaceId, {
        sessionId: session.id,
        turnId: turn.id,
        triggerEventId: turn.triggerEventId,
        attemptId: initialAttemptId,
        turnStatus: "requires_action",
        sessionStatus: "requires_action",
        activeTurnId: turn.id,
        events: [],
      }),
    ).toMatchObject({ action: "settled" });
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
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime,
    });

    await expect(
      activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "approval", triggerEventId: approvalTrigger!.id },
        workflowId,
        workflowRunId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "idle", turnId: turn.id });

    expect(observedDuringRun).toEqual({ status: "running", activeTurnId: turn.id });
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
          sandboxBackend: "modal",
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "read repo" } },
    ]);
    const sandboxExecCalls: Array<Record<string, unknown>> = [];
    const activities = createWorkerActivities({
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
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: "workflow-modal-repo-clone",
      workflowRunId: crypto.randomUUID(),
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
      await appendOwnedEvents(dbClient.db, grant, session.id, [
        { type: "user.message", payload: { text: "search docs" } },
      ]);
      const activities = createWorkerActivities({
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
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-mcp",
        workflowRunId: crypto.randomUUID(),
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
      await appendOwnedEvents(dbClient.db, grant, session.id, [
        { type: "user.message", payload: { text: "search docs" } },
      ]);
      const activities = createWorkerActivities({
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
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-per-response-usage",
        workflowRunId: crypto.randomUUID(),
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "expensive run" } },
    ]);
    const activities = createWorkerActivities({
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
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: "workflow-capped-model-debit",
      workflowRunId: crypto.randomUUID(),
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

  test("persists conversation items and resumes follow-up turns from them", async () => {
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
    const firstTurnActivities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "remember the codeword zebra" } },
    ]);
    await expect(
      firstTurnActivities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-items-turn-1",
        workflowRunId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "idle" });
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

    // The follow-up reads conversation truth from the canonical items table.
    const itemsActivities = createWorkerActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "what is the codeword?" } },
    ]);
    await expect(
      itemsActivities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-items-turn-2",
        workflowRunId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "idle" });
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
    expect(await getLatestRunState(dbClient.db, grant.workspaceId, session.id)).toBeNull();
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
    // Seed a stored history that is corrupt exactly the way the live incidents
    // were: a valid user turn, then a function_call_result with NO matching
    // function_call anywhere in the items.
    await withWorkspaceRls(dbClient.db, grant.workspaceId, async (db) => {
      await db.insert(dbSchema.sessionHistoryItems).values(
        [
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
        ].map(({ position, item }) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          position,
          item,
        })),
      );
    });

    const model = new ScriptedModel([
      { id: "orphan-recover", outputText: "recovered", chunks: ["recovered"] },
    ]);
    const activities = createWorkerActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
      }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({ model }),
    });
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "continue please" } },
    ]);

    // The turn SUCCEEDS instead of failing the session with a 400.
    await expect(
      activities.runAgentTurn({
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-orphan-recover",
        workflowRunId: crypto.randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "idle" });

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
    const activities = createWorkerActivities({
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
    const activities = createWorkerActivities({
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
    await appendOwnedEvents(dbClient.db, grant, session.id, [
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
    const activities = createWorkerActivities({
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
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: "workflow-exact-run-cap",
      workflowRunId: crypto.randomUUID(),
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
      await appendOwnedEvents(dbClient.db, grant, session.id, [
        {
          type: "user.message",
          payload: {
            text: "search docs now",
            tools: [{ kind: "mcp", id: "docs" }],
          },
        },
      ]);
      const activities = createWorkerActivities({
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
        attemptId: crypto.randomUUID(),
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        trigger: { kind: "next" },
        workflowId: "workflow-follow-up-mcp",
        workflowRunId: crypto.randomUUID(),
      });

      expect(result.status).toBe("idle");
      expect(mcp.calls).toEqual([{ tool: "search_documents", args: { query: "network policy" } }]);
      expect(JSON.stringify(model.requests[0])).toContain("docs__search_documents");
    } finally {
      mcp.close();
    }
  });

  test("dispatches scheduled tasks into new sessions as typed internal updates", async () => {
    const grant = await testGrant(dbClient.db);
    const workflowWakes: unknown[] = [];
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
    const activities = createWorkerActivities({
      settings: testSettings({
        databaseUrl: services.databaseUrl,
        natsUrl: services.natsUrl,
        mcpServers: [{ id: "docs", url: "http://127.0.0.1:1/mcp", name: "Docs" }],
      }),
      db: dbClient.db,
      bus,
      wakeSessionWorkflow: async (input) => {
        workflowWakes.push(input);
      },
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });

    const result = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
    });

    expect(result.action).toBe("start");
    expect(result.workflowId).toBe(`session-${result.sessionId}`);
    expect(workflowWakes).toEqual([
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: result.sessionId,
        workflowId: result.workflowId,
        wakeRevision: result.workflowWakeRevision,
      },
    ]);
    const session = await getSession(dbClient.db, grant.workspaceId, result.sessionId);
    expect(session?.metadata).toMatchObject({ scheduledTaskId: task.id, source: "test" });
    expect(session?.tools).toEqual([{ kind: "mcp", id: "docs" }]);
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, result.sessionId, 0, 10);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "session.status.changed",
      "system.update.pending",
    ]);
    const pendingUpdates = await listOutstandingSessionSystemUpdates(
      dbClient.db,
      grant.workspaceId,
      result.sessionId,
    );
    expect(pendingUpdates).toHaveLength(1);
    expect(pendingUpdates[0]).toMatchObject({
      kind: "scheduled_occurrence",
      summary: "inspect nightly",
      payload: { type: "scheduled_occurrence", text: "inspect nightly", scheduledTaskId: task.id },
    });
    expect(await listSessionTurns(dbClient.db, grant.workspaceId, result.sessionId)).toHaveLength(
      0,
    );
    const [run] = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(run).toMatchObject({
      status: "dispatched",
      sessionId: result.sessionId,
      triggerEventId: result.triggerEventId,
    });
  });

  test("scheduled dispatch and its retry remain inert while the workspace is paused", async () => {
    const grant = await testGrant(dbClient.db);
    await withWorkspaceRls(dbClient.db, grant.workspaceId, (db) =>
      db.transaction((tx) =>
        mutateWorkspaceControlInTransaction(tx as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          actor: { type: "human", subjectId: grant.subjectId },
          action: "pause",
          reason: "test",
          operationKey: `pause:${crypto.randomUUID()}`,
          expectedRevision: 0,
        }),
      ),
    );
    const task = await createOwnedScheduledTask(dbClient.db, grant, {
      name: "paused-scheduled-session",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "wait for resume", resources: [], tools: [], metadata: {} },
      metadata: {},
    });
    const workflowWakes: unknown[] = [];
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      wakeSessionWorkflow: async (input) => {
        workflowWakes.push(input);
      },
      runtime: createProductionAgentRuntime({ model: new ScriptedModel([{ outputText: "ok" }]) }),
    });
    const producerKey = `paused-fire:${crypto.randomUUID()}`;

    const first = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey,
    });
    const retry = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey,
    });

    expect(first.workflowWakeRevision).toBeNull();
    expect(retry).toMatchObject({ sessionId: first.sessionId, workflowWakeRevision: null });
    expect(workflowWakes).toHaveLength(0);
    expect(await getSession(dbClient.db, grant.workspaceId, first.sessionId)).toMatchObject({
      status: "queued",
      effectiveControl: { state: "paused" },
    });
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, first.sessionId, 0, 10);
    expect(events.find((event) => event.type === "session.created")?.payload).toMatchObject({
      status: "queued",
    });
    expect(events.find((event) => event.type === "session.status.changed")?.payload).toMatchObject({
      status: "queued",
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
    const activities = createWorkerActivities({
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
    const activities = createWorkerActivities({
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
    const activities = createWorkerActivities({
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
    const activities = createWorkerActivities({
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
    expect(events.filter((event) => event.type === "user.message")).toHaveLength(0);
    expect(events.filter((event) => event.type === "system.update.pending")).toHaveLength(2);
    expect(
      await listOutstandingSessionSystemUpdates(dbClient.db, grant.workspaceId, first.sessionId),
    ).toHaveLength(2);
    expect(
      await listSessionTurns(dbClient.db, grant.workspaceId, first.sessionId, 10),
    ).toHaveLength(0);
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
    ).rejects.toThrow("variable set not found");
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
      variableSetId: environment.id,
    });
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createWorkerActivities({
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
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: "workflow-environment-redaction",
      workflowRunId: crypto.randomUUID(),
    });
    expect(result.status).toBe("idle");
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 100);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[redacted:LEAKED_TOKEN]");
    const completed = events.find((event) => event.type === "agent.message.completed");
    expect((completed?.payload as { text?: string } | undefined)?.text).toBe(
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
      variableSetId: environment.id,
    });
    await appendOwnedEvents(dbClient.db, grant, session.id, [
      { type: "user.message", payload: { text: "run" } },
    ]);
    const activities = createWorkerActivities({
      settings: testSettings({ databaseUrl: services.databaseUrl, natsUrl: services.natsUrl }),
      db: dbClient.db,
      bus,
      runtime: createProductionAgentRuntime({
        model: new ScriptedModel([{ outputText: "never reached" }]),
      }),
    });
    const result = await activities.runAgentTurn({
      attemptId: crypto.randomUUID(),
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      trigger: { kind: "next" },
      workflowId: "workflow-environment-missing-key",
      workflowRunId: crypto.randomUUID(),
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
      variableSetId: environment.id,
      metadata: {},
    });
    const activities = createWorkerActivities({
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
      variableSetId: environment.id,
      variableSetName: environment.name,
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
      variableSetId: environment.id,
      metadata: {},
    });
    await updateScheduledTask(dbClient.db, grant.workspaceId, task.id, {
      reusableSessionId: session.id,
    });
    const activities = createWorkerActivities({
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
    ).rejects.toThrow("scheduled task variableSet attachment does not match its reusable session");
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
    const activities = createWorkerActivities({
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
      variableSetId: environment.id,
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
  if (events.length === 1 && events[0]?.type === "user.message") {
    const event = events[0];
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const accepted = await submitTestHumanPrompt(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      subjectId: grant.subjectId,
      text: String(payload.text ?? ""),
      resources: Array.isArray(payload.resources) ? (payload.resources as never[]) : [],
      tools: Array.isArray(payload.tools) ? (payload.tools as never[]) : [],
      ...(typeof payload.model === "string" ? { model: payload.model } : {}),
      ...(typeof payload.reasoningEffort === "string"
        ? { reasoningEffort: payload.reasoningEffort as "low" | "medium" | "high" | "xhigh" }
        : {}),
      ...(event.clientEventId ? { operationKey: event.clientEventId } : {}),
      delivery: "send",
      reasoningEffortFallback: "medium",
    });
    return [accepted.accepted];
  }
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
