import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MODEL_ATTACHMENT_REFS_FIELD } from "@opengeni/contracts";
import {
  ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES,
  ACTIVE_SESSION_HISTORY_MAX_JSON_NODES,
  ACTIVE_SESSION_HISTORY_MAX_JSON_PROPERTIES,
  ACTIVE_SESSION_HISTORY_MAX_ROWS,
  ActiveSessionHistoryLimitExceededError,
  ApprovalRunStateLimitExceededError,
  addSessionSystemUpdate,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createSessionGoal,
  getActiveSessionHistoryItems,
  getActiveSessionHistoryItemsPaged,
  getLatestRunState,
  getSession,
  getSessionQueueSnapshot,
  getSessionTurn,
  initializeSessionStartAtomically,
  isSessionCompactionRequested,
  listOutstandingSessionSystemUpdates,
  listSessionEvents,
  listSessionSystemUpdatesForTurn,
  peekSessionWork,
  requestSessionCompaction,
  saveRunState,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls,
  type Database,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import {
  CompactionNeededError,
  CompactionProviderResponseError,
  createProductionAgentRuntime,
  EmptyCompactionSummaryError,
  SUMMARY_PREFIX,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  ScriptedModel,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createActivityTestHarness } from "../src/activities";
import {
  isContextWindowExceeded,
  isExactContextLengthExceeded,
  maybeCompactContext,
} from "../src/activities/context-compaction";

async function claimCompactionForAttempt(
  db: Parameters<typeof claimSessionWorkForAttempt>[0],
  workspaceId: string,
  sessionId: string,
  attemptId: string,
) {
  const result = await claimSessionWorkForAttempt(db, workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (result.action !== "claimed") {
    throw new Error(`Expected compaction claim, got ${result.reason}`);
  }
  return result.turn;
}

describe("standalone context compaction execution", () => {
  let shared: SharedTestDatabase;
  let client: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("context-compaction-activity");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
    client = createDb(shared.appUrl);
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 60_000);

  test("uses the production active-history materialization envelope", () => {
    expect(ACTIVE_SESSION_HISTORY_MAX_JSON_BYTES).toBe(15 * 1024 * 1024);
    expect(ACTIVE_SESSION_HISTORY_MAX_ROWS).toBe(8_192);
    expect(ACTIVE_SESSION_HISTORY_MAX_JSON_NODES).toBe(131_072);
    expect(ACTIVE_SESSION_HISTORY_MAX_JSON_PROPERTIES).toBe(65_536);
  });

  test("does not touch durable history when provider accounting is below threshold", async () => {
    const inaccessibleDb = new Proxy(
      {},
      {
        get() {
          throw new Error("durable history was touched");
        },
      },
    ) as Database;
    const scope = {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      executionGeneration: 1,
      attemptId: crypto.randomUUID(),
    };
    const settings = testSettings({
      contextWindowTokens: 272_000,
      contextAutoCompactThresholdTokens: 244_800,
    });

    await expect(maybeCompactContext(inaccessibleDb, settings, scope, 244_799)).resolves.toEqual({
      compacted: false,
      reason: "below_threshold",
      events: [],
      requestConsumed: false,
    });
    await expect(maybeCompactContext(inaccessibleDb, settings, scope, 244_800)).rejects.toThrow(
      "durable history was touched",
    );
  });

  test("rejects an oversized active UTF-8 JSON transcript before paged item decoding", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "History envelope test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "History envelope test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values([
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 0,
          item: { type: "message", role: "user", content: "x".repeat(4_096) },
        },
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 1,
          item: { type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] },
        },
      ]);
    });

    const read = getActiveSessionHistoryItemsPaged(
      client.db,
      grant.workspaceId!,
      session.id,
      16,
      1_024,
    );
    await expect(read).rejects.toBeInstanceOf(ActiveSessionHistoryLimitExceededError);
    await expect(read).rejects.toMatchObject({
      code: "active_history_too_large",
      maximumBytes: 1_024,
      actualBytes: expect.any(Number),
    });

    await expect(
      getActiveSessionHistoryItemsPaged(client.db, grant.workspaceId!, session.id, 16, 100_000, 1),
    ).rejects.toMatchObject({ limitKind: "rows", actual: 2, maximum: 1 });
    await expect(
      getActiveSessionHistoryItemsPaged(
        client.db,
        grant.workspaceId!,
        session.id,
        16,
        100_000,
        10,
        1,
      ),
    ).rejects.toMatchObject({ limitKind: "json_nodes", actual: 2, maximum: 1 });
    await expect(
      getActiveSessionHistoryItemsPaged(
        client.db,
        grant.workspaceId!,
        session.id,
        16,
        100_000,
        10,
        100,
        1,
      ),
    ).rejects.toMatchObject({ limitKind: "json_properties", actual: 2, maximum: 1 });
  });

  test("withholds approval RunState before decoding when any materialization bound fails", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "RunState envelope test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "RunState envelope test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.agentRunStates).values({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        stateVersion: 1,
        serializedRunState: JSON.stringify({
          schemaVersion: "test",
          history: [{ type: "message", role: "user", content: "bounded" }],
        }),
        pendingApprovals: [{ id: "approval-1" }, { id: "approval-2" }],
      });
    });

    const defaults = {
      maximumJsonBytes: 100_000,
      maximumJsonNodes: 100,
      maximumJsonProperties: 100,
      maximumPendingApprovalBytes: 100_000,
      maximumPendingApprovalItems: 10,
    };
    await expect(
      getLatestRunState(client.db, grant.workspaceId!, session.id, {
        ...defaults,
        maximumJsonBytes: 10,
      }),
    ).rejects.toMatchObject({
      code: "approval_run_state_too_large",
      limitKind: "json_bytes",
    });
    await expect(
      getLatestRunState(client.db, grant.workspaceId!, session.id, {
        ...defaults,
        maximumJsonNodes: 1,
      }),
    ).rejects.toMatchObject({ limitKind: "json_nodes", actual: 2, maximum: 1 });
    await expect(
      getLatestRunState(client.db, grant.workspaceId!, session.id, {
        ...defaults,
        maximumJsonProperties: 1,
      }),
    ).rejects.toMatchObject({ limitKind: "json_properties", actual: 2, maximum: 1 });
    await expect(
      getLatestRunState(client.db, grant.workspaceId!, session.id, {
        ...defaults,
        maximumPendingApprovalBytes: 2,
      }),
    ).rejects.toBeInstanceOf(ApprovalRunStateLimitExceededError);
    await expect(
      getLatestRunState(client.db, grant.workspaceId!, session.id, {
        ...defaults,
        maximumPendingApprovalItems: 1,
      }),
    ).rejects.toMatchObject({ limitKind: "pending_approval_items", actual: 2, maximum: 1 });

    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const turn = await claimCompactionForAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      attemptId,
    );
    const saveInput = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      turnId: turn.id,
      expectedExecutionGeneration: turn.executionGeneration,
      expectedAttemptId: attemptId,
      pendingApprovals: [] as unknown[],
    };
    await expect(
      saveRunState(client.db, {
        ...saveInput,
        serializedRunState: JSON.stringify({ text: "x".repeat(32 * 1024 * 1024) }),
      }),
    ).rejects.toMatchObject({ limitKind: "json_bytes" });
    await expect(
      saveRunState(client.db, {
        ...saveInput,
        serializedRunState: `{"history":[${"0,".repeat(200_000)}0]}`,
      }),
    ).rejects.toMatchObject({ limitKind: "json_nodes" });
    await expect(
      saveRunState(client.db, {
        ...saveInput,
        serializedRunState: `{${Array.from(
          { length: 32_769 },
          (_, index) => `"property_${index}":0`,
        ).join(",")}}`,
      }),
    ).rejects.toMatchObject({ limitKind: "json_properties" });
    await expect(
      saveRunState(client.db, {
        ...saveInput,
        serializedRunState: '{"schemaVersion":"test","history":[]}',
        pendingApprovals: Array.from({ length: 257 }, (_, index) => ({ id: index })),
      }),
    ).rejects.toMatchObject({ limitKind: "pending_approval_items" });
  });

  test("compacts idle history without preparing tools, input, or a sandbox", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Compaction activity test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Compaction activity test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values([
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 0,
          item: {
            type: "message",
            role: "user",
            content: "build the queue correctly",
          },
        },
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 1,
          item: {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "working notes that should be summarized ".repeat(1_000),
              },
            ],
          },
        },
      ]);
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);

    let compactionCalls = 0;
    let forbiddenRuntimeCalls = 0;
    const forbid = () => {
      forbiddenRuntimeCalls += 1;
      throw new Error("standalone compaction entered the agent/sandbox runtime");
    };
    const fakeClient = {
      chat: {
        completions: {
          create: async () => {
            compactionCalls += 1;
            return {
              id: "chatcmpl-compaction",
              usage: {
                prompt_tokens: 1_234,
                completion_tokens: 56,
                total_tokens: 1_290,
              },
              choices: [
                {
                  message: {
                    content:
                      "The user is building a correct queue and the implementation is in progress.",
                  },
                },
              ],
            };
          },
        },
      },
    };
    const runtime = {
      configure: () => undefined,
      resolveTurnModel: () => ({
        client: fakeClient,
        provider: {
          id: "test-chat",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
        configured: {
          id: "scripted-compactor",
          contextWindowTokens: 250_000,
          effectiveContextWindowTokens: 250_000,
          autoCompactLimitTokens: 225_000,
          hostedWebSearch: false,
        },
      }),
      buildAgent: forbid,
      prepareTools: forbid,
      prepareInput: forbid,
      runStream: forbid,
      serializeApprovals: forbid,
    } as unknown as OpenGeniRuntime;
    const bus = new MemoryEventBus();
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-compactor",
        sandboxBackend: "none",
      }),
      db: client.db,
      bus,
      runtime,
    });

    const attemptId = crypto.randomUUID();
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });

    expect(result).toMatchObject({ status: "idle", attemptId });
    if (result.status === "unclaimed") throw new Error("Compaction was not claimed");
    const turn = await getSessionTurn(client.db, grant.workspaceId!, result.turnId);
    expect(turn?.source).toBe("compaction");
    expect(compactionCalls).toBe(1);
    expect(forbiddenRuntimeCalls).toBe(0);
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      false,
    );
    expect(turn?.status).toBe("completed");
    const activeHistory = await getActiveSessionHistoryItems(
      client.db,
      grant.workspaceId!,
      session.id,
    );
    expect(activeHistory.map((row) => row.item)).toEqual([
      { type: "message", role: "user", content: "build the queue correctly" },
      expect.objectContaining({
        type: "message",
        role: "user",
        content: expect.stringContaining("The user is building a correct queue"),
      }),
    ]);
    const events = await listSessionEvents(client.db, grant.workspaceId!, session.id, {
      after: 0,
      limit: 100,
    });
    expect(events.map((event) => event.type)).toContain("session.context.compaction.requested");
    expect(events.map((event) => event.type)).toContain("session.context.compaction.started");
    expect(events.map((event) => event.type)).toContain("session.context.compacted");
    expect(events.map((event) => event.type)).toContain("turn.completed");
    expect(events.filter((event) => event.type === "agent.model.usage")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          sourceKey: "chatcmpl-compaction",
          inputTokens: 1_234,
          outputTokens: 56,
        }),
      }),
    ]);
  });

  test("uses the injected summarizer when model resolution is unavailable", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Injected compaction summarizer test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Injected compaction summarizer test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values([
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 0,
          item: { type: "message", role: "user", content: "retain this request" },
        },
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 1,
          item: {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "summarize these bounded notes ".repeat(1_000),
              },
            ],
          },
        },
      ]);
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);

    let injectedSummarizerCalls = 0;
    let forbiddenRuntimeCalls = 0;
    const forbid = () => {
      forbiddenRuntimeCalls += 1;
      throw new Error("null-resolution compaction entered the agent/sandbox runtime");
    };
    const runtime = {
      configure: () => undefined,
      resolveTurnModel: () => null,
      buildAgent: forbid,
      prepareTools: forbid,
      prepareInput: forbid,
      runStream: forbid,
      serializeApprovals: forbid,
    } as unknown as OpenGeniRuntime;
    const bus = new MemoryEventBus();
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiApiKey: "unused-test-key",
        openaiBaseUrl: "http://127.0.0.1:9/v1",
        openaiModel: "scripted-compactor",
        sandboxBackend: "none",
      }),
      db: client.db,
      bus,
      runtime,
      summarizeContextForCompaction: async (_settings, input, options) => {
        injectedSummarizerCalls += 1;
        expect(input.length).toBeGreaterThan(1);
        expect(options.model).toBe("scripted-compactor");
        return "Injected deterministic compaction summary.";
      },
    });

    const attemptId = crypto.randomUUID();
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });

    expect(result).toMatchObject({ status: "idle", attemptId });
    if (result.status === "unclaimed") throw new Error("Compaction was not claimed");
    expect(injectedSummarizerCalls).toBe(1);
    expect(forbiddenRuntimeCalls).toBe(0);
    expect(await getSessionTurn(client.db, grant.workspaceId!, result.turnId)).toMatchObject({
      source: "compaction",
      status: "completed",
    });
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual([
      { type: "message", role: "user", content: "retain this request" },
      expect.objectContaining({
        type: "message",
        role: "user",
        content: expect.stringContaining("Injected deterministic compaction summary"),
      }),
    ]);
  });

  test("never replays an invalidated provider artifact into the compaction model", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Invalidated compaction artifact test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Invalidated compaction artifact test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const invalidatedAt = new Date();
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values([
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 0,
          item: { type: "message", role: "user", content: "x".repeat(40_000) },
        },
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 1,
          item: {
            type: "reasoning",
            id: "rs_rejected",
            providerData: { encrypted_content: "must-never-replay" },
          },
          providerArtifactInvalidatedAt: invalidatedAt,
          providerArtifactInvalidationReason: "encrypted_content_rejected",
          providerArtifactInvalidatedByAttemptId: crypto.randomUUID(),
        },
      ]);
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const turn = await claimCompactionForAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      attemptId,
    );
    let summarizerInput: Array<Record<string, unknown>> = [];

    const outcome = await maybeCompactContext(
      client.db,
      testSettings({ contextWindowTokens: 10_000 }),
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        executionGeneration: turn!.executionGeneration,
        attemptId,
      },
      null,
      async (_settings, input) => {
        summarizerInput = input;
        return "Safe compacted context.";
      },
      {
        force: true,
        trigger: "operator",
        codexAccount: { currentCodexCredentialId: null },
      },
    );

    expect(outcome).toMatchObject({ compacted: false, reason: "replacement_not_smaller" });
    expect(summarizerInput.length).toBeGreaterThan(0);
    expect(summarizerInput.some((item) => item.type === "reasoning")).toBe(false);
    expect(JSON.stringify(summarizerInput)).not.toContain("must-never-replay");
  });

  test("compacts the model-safe view while retaining canonical attachment refs", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Attachment compaction test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Attachment compaction test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const attachmentRefs = [{ kind: "file", fileId: "00000000-0000-4000-8000-000000000081" }];
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values([
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 0,
          item: {
            type: "message",
            role: "user",
            content: "inspect the retained attachment",
            [MODEL_ATTACHMENT_REFS_FIELD]: attachmentRefs,
          },
        },
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 1,
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "working notes ".repeat(20_000) }],
          },
        },
      ]);
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const turn = await claimCompactionForAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      attemptId,
    );
    let summarizerInput: Array<Record<string, unknown>> = [];

    const outcome = await maybeCompactContext(
      client.db,
      testSettings({ contextWindowTokens: 10_000 }),
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
        attemptId,
      },
      null,
      async (_settings, input) => {
        summarizerInput = input;
        return "The user asked to inspect the retained attachment.";
      },
      {
        force: true,
        trigger: "operator",
        projectModelInput: async (items) =>
          items.map((item) => {
            if (!(MODEL_ATTACHMENT_REFS_FIELD in item)) return item;
            const projected = { ...item };
            delete projected[MODEL_ATTACHMENT_REFS_FIELD];
            return projected;
          }),
      },
    );

    expect(outcome).toMatchObject({ compacted: true });
    expect(JSON.stringify(summarizerInput)).not.toContain(MODEL_ATTACHMENT_REFS_FIELD);
    const active = (
      await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)
    ).map((row) => row.item);
    expect(active.find((item) => item.role === "user")).toMatchObject({
      [MODEL_ATTACHMENT_REFS_FIELD]: attachmentRefs,
    });
  });

  test("a failed standalone summary consumes the request once and preserves active history", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Failed standalone compaction test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Failed standalone compaction test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const originalItems = [
      { type: "message", role: "user", content: "preserve this request" },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "work in progress ".repeat(1_000) }],
      },
    ];
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(
        originalItems.map((item, position) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position,
          item,
        })),
      );
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);

    const runtime = {
      configure: () => undefined,
      resolveTurnModel: () => ({
        client: {
          chat: {
            completions: {
              create: async () => ({
                id: "chatcmpl-empty",
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 0,
                  total_tokens: 100,
                },
                choices: [{ message: { content: "" }, finish_reason: "stop" }],
              }),
            },
          },
        },
        provider: {
          id: "test-chat",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
        configured: {
          id: "scripted-compactor",
          contextWindowTokens: 250_000,
          effectiveContextWindowTokens: 250_000,
          autoCompactLimitTokens: 225_000,
          hostedWebSearch: false,
        },
      }),
      buildAgent: () => {
        throw new Error("failed standalone compaction entered the agent runtime");
      },
      prepareTools: () => {
        throw new Error("failed standalone compaction prepared tools");
      },
      prepareInput: () => {
        throw new Error("failed standalone compaction prepared input");
      },
      runStream: () => {
        throw new Error("failed standalone compaction started inference");
      },
      serializeApprovals: () => {
        throw new Error("failed standalone compaction serialized approvals");
      },
    } as unknown as OpenGeniRuntime;
    const bus = new MemoryEventBus();
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-compactor",
        sandboxBackend: "none",
      }),
      db: client.db,
      bus,
      runtime,
    });

    const attemptId = crypto.randomUUID();
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });

    expect(result).toMatchObject({ status: "idle", attemptId });
    if (result.status === "unclaimed") throw new Error("Compaction was not claimed");
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      false,
    );
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual(originalItems);
    const turn = await getSessionTurn(client.db, grant.workspaceId!, result.turnId);
    expect(turn).toMatchObject({ source: "compaction", status: "failed" });
    expect(await getSession(client.db, grant.workspaceId!, session.id)).toMatchObject({
      status: "idle",
      activeTurnId: null,
    });
    const events = await listSessionEvents(client.db, grant.workspaceId!, session.id, {
      after: 0,
      limit: 100,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.context.compaction.skipped",
        payload: { reason: "summarization_failed" },
      }),
    );
    expect(
      events.filter((event) => event.type === "session.context.compaction.requested"),
    ).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn.failed",
        payload: expect.objectContaining({
          code: "context_compaction_failed",
          retryable: false,
          recovery: "user_message",
        }),
      }),
    );
  });

  test("a transient standalone summary failure keeps the request on the same recovering turn", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Transient standalone compaction test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Transient standalone compaction test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const originalItems = [
      {
        type: "message",
        role: "user",
        content: "preserve this transient request",
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "work in progress ".repeat(1_000) }],
      },
    ];
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(
        originalItems.map((item, position) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position,
          item,
        })),
      );
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const runtime = {
      configure: () => undefined,
      resolveTurnModel: () => ({
        client: {
          chat: {
            completions: {
              create: async () => {
                throw Object.assign(new Error("temporary provider outage"), {
                  status: 503,
                  code: "server_error",
                });
              },
            },
          },
        },
        provider: {
          id: "test-chat",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
        configured: {
          id: "scripted-compactor",
          contextWindowTokens: 250_000,
          effectiveContextWindowTokens: 250_000,
          autoCompactLimitTokens: 225_000,
          hostedWebSearch: false,
        },
      }),
      buildAgent: () => {
        throw new Error("transient standalone compaction entered the agent runtime");
      },
      prepareTools: () => {
        throw new Error("transient standalone compaction prepared tools");
      },
      prepareInput: () => {
        throw new Error("transient standalone compaction prepared input");
      },
      runStream: () => {
        throw new Error("transient standalone compaction started inference");
      },
      serializeApprovals: () => {
        throw new Error("transient standalone compaction serialized approvals");
      },
    } as unknown as OpenGeniRuntime;
    const bus = new MemoryEventBus();
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-compactor",
        sandboxBackend: "none",
      }),
      db: client.db,
      bus,
      runtime,
    });

    const attemptId = crypto.randomUUID();
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });

    expect(result).toMatchObject({ status: "recovering", attemptId });
    if (result.status === "unclaimed") throw new Error("Compaction was not claimed");
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual(originalItems);
    expect(await getSessionTurn(client.db, grant.workspaceId!, result.turnId)).toMatchObject({
      source: "compaction",
      status: "recovering",
    });
    expect(await getSession(client.db, grant.workspaceId!, session.id)).toMatchObject({
      status: "recovering",
      activeTurnId: result.turnId,
    });
    const events = await listSessionEvents(client.db, grant.workspaceId!, session.id, {
      after: 0,
      limit: 100,
    });
    expect(events.map((event) => event.type)).not.toContain("session.context.compaction.skipped");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.recovery.requested" }));
  });

  test("a transient /compact inside a queued user turn preserves the request for same-turn recovery", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Transient in-turn compaction test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Transient in-turn compaction test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "continue after the checkpoint provider recovers",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
      goal: null,
    });
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        position: 0,
        item: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "prior work ".repeat(1_000) }],
        },
      });
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);

    const runtime = {
      configure: () => undefined,
      resolveTurnModel: () => ({
        client: {
          chat: {
            completions: {
              create: async () => {
                throw Object.assign(new Error("temporary provider outage"), {
                  status: 503,
                  code: "server_error",
                });
              },
            },
          },
        },
        provider: {
          id: "test-chat",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
        configured: {
          id: "scripted-compactor",
          contextWindowTokens: 250_000,
          effectiveContextWindowTokens: 250_000,
          autoCompactLimitTokens: 225_000,
          hostedWebSearch: false,
        },
      }),
      prepareTools: async () => ({
        mcpServers: [],
        resolvedMcpConnectionIds: new Map<string, string>(),
        codexConnectorNamespaces: new Set<string>(),
        close: async () => undefined,
      }),
      buildAgent: () => ({ instructions: "" }),
      prepareInput: () => {
        throw new Error("transient in-turn compaction prepared model input");
      },
      runStream: () => {
        throw new Error("transient in-turn compaction started inference");
      },
      serializeApprovals: () => {
        throw new Error("transient in-turn compaction serialized approvals");
      },
    } as unknown as OpenGeniRuntime;
    const bus = new MemoryEventBus();
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-compactor",
        sandboxBackend: "none",
      }),
      db: client.db,
      bus,
      runtime,
    });

    const attemptId = crypto.randomUUID();
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });

    expect(result).toMatchObject({ status: "recovering", attemptId });
    if (result.status === "unclaimed") throw new Error("User turn was not claimed");
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
    expect(await getSessionTurn(client.db, grant.workspaceId!, result.turnId)).toMatchObject({
      source: "user",
      status: "recovering",
    });
    expect(await getSession(client.db, grant.workspaceId!, session.id)).toMatchObject({
      status: "recovering",
      activeTurnId: result.turnId,
    });
    const events = await listSessionEvents(client.db, grant.workspaceId!, session.id, {
      after: 0,
      limit: 100,
    });
    expect(events.map((event) => event.type)).not.toContain("session.context.compaction.skipped");
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.recovery.requested" }));
  });

  test("Steer waits for in-turn compaction and supersedes before inference resumes", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Deferred Steer compaction test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Deferred Steer compaction test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "continue after safely compacting the prior work",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
      goal: null,
    });
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        position: 0,
        item: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "large prior work ".repeat(2_000) }],
        },
      });
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);

    let signalSummaryStarted!: () => void;
    const summaryStarted = new Promise<void>((resolve) => {
      signalSummaryStarted = resolve;
    });
    let releaseSummary!: () => void;
    const summaryRelease = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let compactionCalls = 0;
    let forbiddenInferenceCalls = 0;
    const runtime = {
      configure: () => undefined,
      resolveTurnModel: () => ({
        client: {
          chat: {
            completions: {
              create: async () => {
                compactionCalls += 1;
                signalSummaryStarted();
                await summaryRelease;
                return {
                  id: "chatcmpl-deferred-steer",
                  usage: {
                    prompt_tokens: 2_000,
                    completion_tokens: 20,
                    total_tokens: 2_020,
                  },
                  choices: [
                    {
                      message: {
                        content: "The prior work was compacted before changing direction.",
                      },
                    },
                  ],
                };
              },
            },
          },
        },
        provider: {
          id: "test-chat",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
        configured: {
          id: "scripted-compactor",
          contextWindowTokens: 250_000,
          effectiveContextWindowTokens: 250_000,
          autoCompactLimitTokens: 225_000,
          hostedWebSearch: false,
        },
      }),
      prepareTools: async () => ({
        mcpServers: [],
        resolvedMcpConnectionIds: new Map<string, string>(),
        codexConnectorNamespaces: new Set<string>(),
        close: async () => undefined,
      }),
      buildAgent: () => ({ instructions: "" }),
      prepareInput: () => {
        forbiddenInferenceCalls += 1;
        throw new Error("deferred Steer prepared inference after compaction");
      },
      runStream: () => {
        forbiddenInferenceCalls += 1;
        throw new Error("deferred Steer started inference after compaction");
      },
      serializeApprovals: () => {
        throw new Error("deferred Steer serialized approvals");
      },
    } as unknown as OpenGeniRuntime;
    const bus = new MemoryEventBus();
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-compactor",
        sandboxBackend: "none",
      }),
      db: client.db,
      bus,
      runtime,
    });

    const attemptId = crypto.randomUUID();
    const runPromise = activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    await summaryStarted;

    let steered: Awaited<ReturnType<typeof submitHumanPromptInTransaction>>;
    try {
      steered = await withWorkspaceSubjectSessionActivityRls(
        client.db,
        grant.workspaceId!,
        grant.subjectId,
        (db) =>
          db.transaction((tx) =>
            submitHumanPromptInTransaction(tx as unknown as Database, {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId!,
              sessionId: session.id,
              subjectId: grant.subjectId,
              actor: { type: "human", subjectId: grant.subjectId },
              operationKey: `steer-during-compaction-${crypto.randomUUID()}`,
              delivery: "steer",
              text: "take the new direction immediately after compaction",
              resources: [],
              reasoningEffortFallback: "low",
              source: "user",
            }),
          ),
      );
      expect(steered).toMatchObject({
        interruptionCount: 0,
        routing: "accepted_for_steering",
      });
      expect(steered.receipt.result.deferredUntilCompaction).toBe(true);
      expect(
        await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id),
      ).toMatchObject({
        stoppingPreviousAttempt: false,
        items: [],
      });
    } finally {
      releaseSummary();
    }

    const result = await runPromise;
    expect(result).toMatchObject({ status: "idle", attemptId });
    if (result.status === "unclaimed") throw new Error("User turn was not claimed");
    expect(compactionCalls).toBe(1);
    expect(forbiddenInferenceCalls).toBe(0);
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      false,
    );
    expect(await getSessionTurn(client.db, grant.workspaceId!, result.turnId)).toMatchObject({
      source: "user",
      status: "superseded",
    });
    expect(await getSession(client.db, grant.workspaceId!, session.id)).toMatchObject({
      status: "queued",
      activeTurnId: null,
    });
    const events = await listSessionEvents(client.db, grant.workspaceId!, session.id, {
      after: 0,
      limit: 100,
    });
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes.indexOf("session.context.compaction.started")).toBeGreaterThanOrEqual(0);
    expect(eventTypes.indexOf("session.context.compacted")).toBeGreaterThan(
      eventTypes.indexOf("session.context.compaction.started"),
    );
    expect(eventTypes.indexOf("turn.superseded")).toBeGreaterThan(
      eventTypes.indexOf("session.context.compacted"),
    );
    const next = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(next).toMatchObject({
      action: "claimed",
      turn: { id: steered.turnId, source: "user" },
    });
  });

  test("a post-compaction stream without a terminal response recovers before queued input advances", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Empty post-compaction continuation test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Empty post-compaction continuation test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "finish the active task after compacting",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
      goal: null,
    });
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        position: 0,
        item: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "durable completed work ".repeat(1_000) }],
        },
      });
    });
    const queued = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      grant.workspaceId!,
      grant.subjectId,
      async (db) =>
        await submitHumanPromptInTransaction(db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "this must remain queued until the active turn actually finishes",
          resources: [],
          tools: [],
          reasoningEffortFallback: "medium",
          source: "user",
        }),
    );
    expect(queued.routing).toBe("queued_for_execution");

    const scriptedModel = new ScriptedModel([
      {
        error: new CompactionNeededError({
          signalTokens: 250_000,
          thresholdTokens: 225_000,
          signalSource: "provider",
        }),
      },
      { outputText: "a cancelled continuation must not settle this text" },
    ]);
    let summaryCalls = 0;
    const summarizerClient = {
      chat: {
        completions: {
          create: async () => {
            summaryCalls += 1;
            return {
              id: "chatcmpl-post-compaction-checkpoint",
              usage: {
                prompt_tokens: 321,
                completion_tokens: 12,
                total_tokens: 333,
              },
              choices: [
                {
                  message: {
                    content: "The active task and its durable completed work must continue.",
                  },
                  finish_reason: "stop",
                },
              ],
            };
          },
        },
      },
    } as unknown as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"];
    const productionRuntime = createProductionAgentRuntime({ model: scriptedModel });
    let runStreamCalls = 0;
    const runtime: OpenGeniRuntime = {
      ...productionRuntime,
      configure: () => undefined,
      resolveTurnModel: () => ({
        provider: {
          id: "test-chat",
          label: "Test chat",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
        client: summarizerClient,
        model: scriptedModel,
        configured: {
          id: "scripted-model",
          label: "Scripted model",
          providerId: "test-chat",
          providerLabel: "Test chat",
          api: "chat",
          contextWindowTokens: 250_000,
          effectiveContextWindowTokens: 250_000,
          autoCompactTokenLimit: 225_000,
          reasoningEffort: false,
          hostedWebSearch: false,
        },
      }),
      runStream: async (agent, preparedInput, settings, options) => {
        runStreamCalls += 1;
        if (runStreamCalls === 1) {
          return await productionRuntime.runStream(agent, preparedInput, settings, options);
        }
        const cancelledContinuation = new AbortController();
        cancelledContinuation.abort(new Error("synthetic cancelled post-compaction stream"));
        return await productionRuntime.runStream(agent, preparedInput, settings, {
          ...options,
          signal: cancelledContinuation.signal,
        });
      },
    };
    const bus = new MemoryEventBus();
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-model",
        sandboxBackend: "none",
      }),
      db: client.db,
      bus,
      runtime,
    });

    const attemptId = crypto.randomUUID();
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });

    expect(result).toMatchObject({
      status: "recovering",
      attemptId,
      continueDelayMs: 2_000,
    });
    if (result.status === "unclaimed") throw new Error("User turn was not claimed");
    expect(runStreamCalls).toBe(2);
    expect(summaryCalls).toBe(1);
    expect(await getSessionTurn(client.db, grant.workspaceId!, result.turnId)).toMatchObject({
      source: "user",
      status: "recovering",
    });
    expect(await getSession(client.db, grant.workspaceId!, session.id)).toMatchObject({
      status: "recovering",
      activeTurnId: result.turnId,
    });
    expect(
      (await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id))?.items.map(
        (turn) => turn.id,
      ),
    ).toEqual([queued.turnId]);
    expect(await getSessionTurn(client.db, grant.workspaceId!, queued.turnId)).toMatchObject({
      status: "queued",
    });
    const history = await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id);
    expect(JSON.stringify(history.map((row) => row.item))).toContain(
      "The active task and its durable completed work must continue.",
    );
    const events = await listSessionEvents(client.db, grant.workspaceId!, session.id, {
      after: 0,
      limit: 200,
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "session.context.compacted" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "turn.recovery.requested" }));
    expect(
      events.some((event) => event.type === "turn.completed" && event.turnId === result.turnId),
    ).toBe(false);
    expect(
      events.some(
        (event) => event.type === "agent.message.completed" && event.turnId === result.turnId,
      ),
    ).toBe(false);
    expect(
      events.some((event) => event.type === "turn.started" && event.turnId === queued.turnId),
    ).toBe(false);
  });

  test("same-turn empty-summary recovery settles once and waits for actionable durable input", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Same-turn compaction convergence test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Same-turn compaction convergence test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const originalItems = [
      {
        type: "message",
        role: "user",
        content: "preserve the active transcript exactly",
      },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "durable work already completed" }],
      },
    ];
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(
        originalItems.map((item, position) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position,
          item,
        })),
      );
    });
    const historyBefore = JSON.stringify(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    );

    const ordinary = await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "agent_message",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: `ordinary-${crypto.randomUUID()}`,
      summary: "Ordinary durable notice",
      payload: {
        type: "agent_message",
        text: "Ordinary durable notice",
        operationId: crypto.randomUUID(),
      },
    });
    if (!ordinary.added) throw new Error("ordinary update was not inserted");
    const goal = await createSessionGoal(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      text: "Finish without a compaction loop",
      createdBy: "api",
    });
    const goalContinuation = await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "goal_continuation",
      classification: "info",
      sourceId: goal.id,
      dedupeKey: `goal-continuation:${goal.id}:${goal.version}:1`,
      summary: "Continue the goal",
      payload: {
        type: "goal_continuation",
        goalId: goal.id,
        goalVersion: goal.version,
        autoContinuation: 1,
        prompt: "Continue the goal",
      },
    });
    if (!goalContinuation.added) throw new Error("goal update was not inserted");

    const scriptedModel = new ScriptedModel([
      {
        error: new CompactionNeededError({
          signalTokens: 250_000,
          thresholdTokens: 225_000,
          signalSource: "provider",
        }),
      },
    ]);
    let summaryCalls = 0;
    const summarizerClient = {
      chat: {
        completions: {
          create: async () => {
            summaryCalls += 1;
            return {
              id: "chatcmpl-empty-recovery",
              usage: {
                prompt_tokens: 321,
                completion_tokens: 0,
                total_tokens: 321,
              },
              choices: [{ message: { content: "" }, finish_reason: "stop" }],
            };
          },
        },
      },
    } as unknown as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"];
    const productionRuntime = createProductionAgentRuntime({
      model: scriptedModel,
    });
    const runtime: OpenGeniRuntime = {
      ...productionRuntime,
      configure: () => undefined,
      resolveTurnModel: () => ({
        provider: {
          id: "test-chat",
          label: "Test chat",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
        client: summarizerClient,
        model: scriptedModel,
        configured: {
          id: "scripted-model",
          label: "Scripted model",
          providerId: "test-chat",
          providerLabel: "Test chat",
          api: "chat",
          contextWindowTokens: 250_000,
          effectiveContextWindowTokens: 250_000,
          autoCompactTokenLimit: 225_000,
          reasoningEffort: false,
          hostedWebSearch: false,
        },
      }),
    };
    const bus = new MemoryEventBus();
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-model",
        sandboxBackend: "none",
      }),
      db: client.db,
      bus,
      runtime,
    });

    const attemptId = crypto.randomUUID();
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });

    expect(result).toMatchObject({
      status: "idle",
      attemptId,
      deferredUntilWake: true,
    });
    if (result.status === "unclaimed") throw new Error("system update turn was not claimed");
    expect(scriptedModel.calls).toBe(1);
    expect(summaryCalls).toBe(1);
    expect(await getSessionTurn(client.db, grant.workspaceId!, result.turnId)).toMatchObject({
      source: "goal",
      metadata: { internalUpdateCount: 2 },
      status: "failed",
    });
    expect((await getSession(client.db, grant.workspaceId!, session.id))?.status).toBe("idle");
    const historyAfter = await getActiveSessionHistoryItems(
      client.db,
      grant.workspaceId!,
      session.id,
    );
    expect(JSON.stringify(historyAfter.slice(0, originalItems.length).map((row) => row.item))).toBe(
      historyBefore,
    );
    expect(historyAfter.at(-1)?.item).toMatchObject({
      type: "message",
      role: "user",
    });
    const continuationInput = JSON.stringify(historyAfter.at(-1)?.item);
    expect(continuationInput).toContain(ordinary.update.id);
    expect(continuationInput).toContain("Continue the goal");
    expect(continuationInput).not.toContain(goalContinuation.update.id);
    expect(
      await listOutstandingSessionSystemUpdates(client.db, grant.workspaceId!, session.id),
    ).toEqual([]);
    const storedUpdates = await withWorkspaceRls(
      client.db,
      grant.workspaceId!,
      async (db) =>
        await db
          .select({
            id: schema.sessionSystemUpdates.id,
            state: schema.sessionSystemUpdates.state,
          })
          .from(schema.sessionSystemUpdates),
    );
    const storedGoalContinuation = storedUpdates.find(
      (update) => update.id === goalContinuation.update.id,
    );
    expect(storedGoalContinuation?.state).toBe("delivered");
    expect(
      (await getSessionQueueSnapshot(client.db, grant.workspaceId!, session.id))?.items,
    ).toEqual([]);
    expect(await peekSessionWork(client.db, grant.workspaceId!, session.id)).toEqual({
      kind: "idle",
    });

    const newUpdate = await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "child_terminal_result",
      classification: "success",
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-${crypto.randomUUID()}`,
      summary: "A genuinely new child completed",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
      },
    });
    if (!newUpdate.added) throw new Error("new update was not inserted");
    const heldClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(heldClaim).toEqual({ action: "unclaimed", reason: "no-work" });
    expect(
      (await listOutstandingSessionSystemUpdates(client.db, grant.workspaceId!, session.id)).map(
        (update) => update.id,
      ),
    ).toEqual([newUpdate.update.id]);

    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      grant.workspaceId!,
      grant.subjectId,
      async (db) =>
        await submitHumanPromptInTransaction(db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "Retry after the compaction failure with new human input",
          resources: [],
          tools: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
    );
    const retryClaim = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(retryClaim).toMatchObject({
      action: "claimed",
      turn: { source: "user" },
    });
    if (retryClaim.action !== "claimed") throw new Error("human input did not wake the session");
    expect(
      (
        await listSessionSystemUpdatesForTurn(
          client.db,
          grant.workspaceId!,
          session.id,
          retryClaim.turn.id,
        )
      ).map((update) => update.id),
    ).toEqual([newUpdate.update.id]);
  });

  test("consumes an operator request without replacing history when its summary is not smaller", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Non-shrinking compaction test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Non-shrinking compaction test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const originalItems = [
      { type: "message", role: "user", content: "short prompt" },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "short answer" }],
      },
    ];
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(
        originalItems.map((item, position) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position,
          item,
        })),
      );
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const turn = await claimCompactionForAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      attemptId,
    );
    const startLifecycle: string[] = [];

    const outcome = await maybeCompactContext(
      client.db,
      testSettings({ contextWindowTokens: 250_000 }),
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        executionGeneration: turn!.executionGeneration,
        attemptId,
      },
      null,
      async () => "larger replacement ".repeat(1_000),
      {
        force: true,
        clearRequestedCompaction: true,
        trigger: "operator",
        onCompactionStarted: (trigger) => startLifecycle.push(`metric:${trigger}`),
        publishLiveEvents: async () => {
          startLifecycle.push("live-publish");
        },
      },
    );

    expect(startLifecycle).toEqual(["metric:operator", "live-publish"]);
    expect(outcome).toMatchObject({
      compacted: false,
      reason: "replacement_not_smaller",
      requestConsumed: true,
      events: [
        expect.objectContaining({ type: "session.context.compaction.started" }),
        expect.objectContaining({ type: "session.context.compaction.skipped" }),
      ],
    });
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      false,
    );
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual(originalItems);
  });

  test("forced overflow compaction proves shrink against active history, not stale input tokens", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Stale compaction signal test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Stale compaction signal test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values([
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 0,
          item: { type: "message", role: "user", content: "x".repeat(300_000) },
        },
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 1,
          item: {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "old answer" }],
          },
        },
      ]);
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const turn = await claimCompactionForAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      attemptId,
    );

    const outcome = await maybeCompactContext(
      client.db,
      testSettings({ contextWindowTokens: 100_000 }),
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        executionGeneration: turn!.executionGeneration,
        attemptId,
      },
      // This belongs to an earlier, tiny request. The forced overflow path must
      // derive its shrink proof from the active transcript instead of treating
      // this stale value as an impossible one-token replacement ceiling.
      1,
      async () => "Recovered compact context.",
      { force: true, trigger: "overflow" },
    );

    expect(outcome).toMatchObject({
      compacted: true,
      events: [
        expect.objectContaining({
          type: "session.context.compaction.started",
          payload: expect.objectContaining({ trigger: "overflow" }),
        }),
        expect.objectContaining({
          type: "session.context.compacted",
          payload: expect.objectContaining({ trigger: "overflow" }),
        }),
      ],
    });
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual([
      expect.objectContaining({ type: "message", role: "user" }),
      expect.objectContaining({
        type: "message",
        role: "user",
        opengeni_context_summary: true,
        content: expect.stringContaining("Recovered compact context"),
      }),
    ]);
  });

  test("an empty checkpoint cannot mutate or consume before the caller records terminal failure", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Empty checkpoint test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Empty checkpoint test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const originalItems = [
      { type: "message", role: "user", content: "x".repeat(100_000) },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "work in progress" }],
      },
    ];
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(
        originalItems.map((item, position) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position,
          item,
        })),
      );
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const turn = await claimCompactionForAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      attemptId,
    );

    await expect(
      maybeCompactContext(
        client.db,
        testSettings({ contextWindowTokens: 250_000 }),
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          turnId: turn!.id,
          executionGeneration: turn!.executionGeneration,
          attemptId,
        },
        null,
        async () => "   ",
        { force: true, clearRequestedCompaction: true, trigger: "operator" },
      ),
    ).rejects.toBeInstanceOf(EmptyCompactionSummaryError);
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual(originalItems);
  });

  test("an exact repeated checkpoint is consumed once without another history rewrite", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Repeated checkpoint test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Repeated checkpoint test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const originalItems = [
      { type: "message", role: "user", content: "keep this user request" },
      {
        type: "message",
        role: "user",
        content: `${SUMMARY_PREFIX}\nsame checkpoint`,
        opengeni_context_summary: true,
      },
    ];
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(
        originalItems.map((item, position) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position,
          item,
        })),
      );
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const turn = await claimCompactionForAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      attemptId,
    );
    const outcome = await maybeCompactContext(
      client.db,
      testSettings({ contextWindowTokens: 250_000 }),
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn!.id,
        executionGeneration: turn!.executionGeneration,
        attemptId,
      },
      null,
      async () => "same checkpoint",
      { force: true, clearRequestedCompaction: true, trigger: "operator" },
    );
    expect(outcome).toMatchObject({
      compacted: false,
      reason: "replacement_unchanged",
      requestConsumed: true,
    });
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      false,
    );
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual(originalItems);
  });

  test("remote v2 retries one exact overflow with only tool-result bodies projected", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Remote compaction overflow retry test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Remote compaction overflow retry test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const originalItems = [
      { type: "message", role: "user", content: "preserve the real request" },
      {
        type: "reasoning",
        id: "reasoning-remote-retry",
        content: [{ type: "input_text", text: "preserve reasoning" }],
      },
      {
        type: "function_call",
        callId: "remote-retry-call",
        name: "exec",
        status: "completed",
        arguments: "{}",
      },
      {
        type: "function_call_result",
        id: "remote-retry-result",
        callId: "remote-retry-call",
        name: "exec",
        status: "completed",
        providerData: { receipt: "preserve" },
        output: "large result ".repeat(2_000),
      },
    ];
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(
        originalItems.map((item, position) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position,
          item,
        })),
      );
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const turn = await claimCompactionForAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      attemptId,
    );
    const inputs: Array<Array<Record<string, unknown>>> = [];
    const overflow = new CompactionProviderResponseError({
      httpStatus: 400,
      code: "context_length_exceeded",
      type: "invalid_request_error",
    });

    const outcome = await maybeCompactContext(
      client.db,
      testSettings({ contextWindowTokens: 250_000 }),
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        turnId: turn.id,
        executionGeneration: turn.executionGeneration,
        attemptId,
      },
      null,
      async () => {
        throw new Error("remote v2 must not fall back to portable compaction");
      },
      {
        force: true,
        clearRequestedCompaction: true,
        trigger: "operator",
        codexCompactionMode: "remote_v2",
        isCodexSubscriptionTurn: true,
        requestRemoteCompactionV2: async (_settings, input) => {
          inputs.push(input);
          if (inputs.length === 1) throw overflow;
          return { type: "compaction", encrypted_content: "opaque-retry-success" };
        },
      },
    );

    expect(outcome.compacted).toBe(true);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toEqual(originalItems);
    expect(inputs[1]).toHaveLength(originalItems.length);
    for (const index of [0, 1, 2]) expect(inputs[1]![index]).toEqual(inputs[0]![index]);
    expect(inputs[1]![3]).toMatchObject({
      type: "function_call_result",
      id: "remote-retry-result",
      callId: "remote-retry-call",
      name: "exec",
      status: "completed",
      providerData: { receipt: "preserve" },
      output: expect.stringContaining("omitted tool result body"),
    });
    expect(
      outcome.events.find((event) => event.type === "session.context.compacted")?.payload,
    ).toMatchObject({
      implementation: "responses_compaction_v2",
      compactionInputProviderCalls: 2,
      compactionInputToolOutputsRewritten: 1,
    });
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      false,
    );
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual([
      originalItems[0],
      { type: "compaction", encrypted_content: "opaque-retry-success" },
    ]);
  });

  test("remote v2 stops after one projected retry and preserves durable history", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Remote compaction terminal overflow test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Remote compaction terminal overflow test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const originalItems = [
      { type: "message", role: "user", content: "history must remain active" },
      {
        type: "function_call",
        callId: "terminal-overflow-call",
        name: "exec",
        status: "completed",
        arguments: "{}",
      },
      {
        type: "function_call_result",
        callId: "terminal-overflow-call",
        name: "exec",
        status: "completed",
        output: "large result ".repeat(2_000),
      },
    ];
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values(
        originalItems.map((item, position) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position,
          item,
        })),
      );
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const turn = await claimCompactionForAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      attemptId,
    );
    const firstOverflow = Object.assign(new Error("first overflow"), {
      code: "context_length_exceeded",
    });
    const secondOverflow = Object.assign(new Error("retry overflow"), {
      code: "context_length_exceeded",
    });
    let calls = 0;

    await expect(
      maybeCompactContext(
        client.db,
        testSettings({ contextWindowTokens: 250_000 }),
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          turnId: turn.id,
          executionGeneration: turn.executionGeneration,
          attemptId,
        },
        null,
        async () => {
          throw new Error("remote v2 must not fall back to portable compaction");
        },
        {
          force: true,
          clearRequestedCompaction: true,
          trigger: "operator",
          codexCompactionMode: "remote_v2",
          isCodexSubscriptionTurn: true,
          requestRemoteCompactionV2: async () => {
            calls += 1;
            throw calls === 1 ? firstOverflow : secondOverflow;
          },
        },
      ),
    ).rejects.toBe(secondOverflow);

    expect(calls).toBe(2);
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual(originalItems);
  });

  test("matches Codex's overflow floor by trying the checkpoint prompt alone once", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Compaction overflow test",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Compaction overflow test",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-compactor",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const originalItem = {
      type: "message",
      role: "user",
      content: "the only real history item",
    };
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        position: 0,
        item: originalItem,
      });
    });
    await requestSessionCompaction(client.db, grant.workspaceId!, session.id);
    const attemptId = crypto.randomUUID();
    const turn = await claimCompactionForAttempt(
      client.db,
      grant.workspaceId!,
      session.id,
      attemptId,
    );

    const inputLengths: number[] = [];
    const overflow = Object.assign(new Error("maximum context length exceeded"), {
      code: "context_length_exceeded",
    });
    await expect(
      maybeCompactContext(
        client.db,
        testSettings({ contextWindowTokens: 250_000 }),
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          turnId: turn!.id,
          executionGeneration: turn!.executionGeneration,
          attemptId,
        },
        null,
        async (_settings, input) => {
          inputLengths.push(input.length);
          throw overflow;
        },
        { force: true, clearRequestedCompaction: true, trigger: "operator" },
      ),
    ).rejects.toBe(overflow);

    // Codex counts the synthesized checkpoint prompt in its input length. Our
    // active-history lengths 1 -> 0 therefore equal Codex input lengths 2 -> 1.
    expect(inputLengths).toEqual([2, 1]);
    expect(await isSessionCompactionRequested(client.db, grant.workspaceId!, session.id)).toBe(
      true,
    );
    expect(
      (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
        (row) => row.item,
      ),
    ).toEqual([originalItem]);
  });

  test("recognizes a provider overflow through the content-free compaction wrapper", () => {
    const providerOverflow = Object.assign(new Error("maximum context length exceeded"), {
      code: "context_length_exceeded",
    });
    const wrapped = new CompactionProviderResponseError(
      { stage: "stream", responseFailed: true },
      providerOverflow,
    );
    expect(isContextWindowExceeded(wrapped)).toBe(true);
    expect(isExactContextLengthExceeded(wrapped)).toBe(true);
    expect(
      isContextWindowExceeded(
        new CompactionProviderResponseError(
          { stage: "stream", responseFailed: true },
          new Error("provider authentication failed"),
        ),
      ),
    ).toBe(false);
    expect(
      isExactContextLengthExceeded(
        Object.assign(new Error("maximum context length exceeded"), {
          code: "different_provider_error",
        }),
      ),
    ).toBe(false);
    expect(
      isExactContextLengthExceeded(
        Object.assign(new Error("maximum context length exceeded"), {
          code: "CONTEXT_LENGTH_EXCEEDED",
        }),
      ),
    ).toBe(false);
  });
});
