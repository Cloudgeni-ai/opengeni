import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  addSessionSystemUpdate,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createSessionGoal,
  getActiveSessionHistoryItems,
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
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import type { EventBus } from "@opengeni/events";
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
  ScriptedModel,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createActivityTestHarness } from "../src/activities";
import { isContextWindowExceeded, maybeCompactContext } from "../src/activities/context-compaction";

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
      sandboxBackend: "none",
    });
    await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
      await db.insert(schema.sessionHistoryItems).values([
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          position: 0,
          item: { type: "message", role: "user", content: "build the queue correctly" },
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
        provider: { id: "test-chat", kind: "api-key", api: "chat", builtin: false },
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
    const bus = {
      publish: async () => undefined,
      subscribe: async function* () {},
      close: async () => undefined,
    } as unknown as EventBus;
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
                usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
                choices: [{ message: { content: "" }, finish_reason: "stop" }],
              }),
            },
          },
        },
        provider: { id: "test-chat", kind: "api-key", api: "chat", builtin: false },
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
    const bus = {
      publish: async () => undefined,
      subscribe: async function* () {},
      close: async () => undefined,
    } as unknown as EventBus;
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
      sandboxBackend: "none",
    });
    const originalItems = [
      { type: "message", role: "user", content: "preserve this transient request" },
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
        provider: { id: "test-chat", kind: "api-key", api: "chat", builtin: false },
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
    const bus = {
      publish: async () => undefined,
      subscribe: async function* () {},
      close: async () => undefined,
    } as unknown as EventBus;
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
        provider: { id: "test-chat", kind: "api-key", api: "chat", builtin: false },
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
    const bus = {
      publish: async () => undefined,
      subscribe: async function* () {},
      close: async () => undefined,
    } as unknown as EventBus;
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
      kind: "child_terminal_result",
      classification: "success",
      sourceId: crypto.randomUUID(),
      dedupeKey: `child-${crypto.randomUUID()}`,
      summary: "Child completed",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
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
    const bus = {
      publish: async () => undefined,
      subscribe: async function* () {},
      close: async () => undefined,
    } as unknown as EventBus;
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
    expect(
      JSON.stringify(
        (await getActiveSessionHistoryItems(client.db, grant.workspaceId!, session.id)).map(
          (row) => row.item,
        ),
      ),
    ).toBe(historyBefore);
    expect(
      await listOutstandingSessionSystemUpdates(client.db, grant.workspaceId!, session.id),
    ).toMatchObject([{ id: ordinary.update.id, state: "deferred", deliveredTurnId: null }]);
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
    expect(storedGoalContinuation?.state).toBe("failed");
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
      (
        await listOutstandingSessionSystemUpdates(client.db, grant.workspaceId!, session.id)
      ).map((update) => update.id),
    ).toEqual(expect.arrayContaining([ordinary.update.id, newUpdate.update.id]));

    await withWorkspaceSubjectRls(
      client.db,
      grant.workspaceId!,
      grant.subjectId,
      async (db) =>
        await db.transaction(async (tx) =>
          await submitHumanPromptInTransaction(tx as typeof db, {
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
        ),
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
    ).toEqual(expect.arrayContaining([ordinary.update.id, newUpdate.update.id]));
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
      { force: true, clearRequestedCompaction: true, trigger: "operator" },
    );

    expect(outcome).toMatchObject({
      compacted: false,
      reason: "replacement_not_smaller",
      requestConsumed: true,
      events: [expect.objectContaining({ type: "session.context.compaction.skipped" })],
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
    expect(
      isContextWindowExceeded(
        new CompactionProviderResponseError(
          { stage: "stream", responseFailed: true },
          new Error("provider authentication failed"),
        ),
      ),
    ).toBe(false);
  });
});
