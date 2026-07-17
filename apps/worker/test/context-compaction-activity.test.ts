import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getActiveSessionHistoryItems,
  getSessionTurn,
  isSessionCompactionRequested,
  listSessionEvents,
  requestSessionCompaction,
  withWorkspaceRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import type { EventBus } from "@opengeni/events";
import type { OpenGeniRuntime } from "@opengeni/runtime";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createActivityTestHarness } from "../src/activities";
import { maybeCompactContext } from "../src/activities/context-compaction";

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
});
