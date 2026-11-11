import { afterAll, beforeAll, expect, test } from "bun:test";
import { RunRawModelStreamEvent } from "@openai/agents-core";
import { modelCallProcessingResidency } from "@opengeni/contracts";
import {
  createTurnHistorySink,
  type TurnHistorySinkDeps,
} from "../src/activities/agent-turn/history-sink";
import {
  appendSessionEventsForTurnAttempt,
  appendSessionHistoryItemsInTransaction,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  type AppendEventInput,
  type SessionEventMutation,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import {
  createCompactionModelUsageEventState,
  createModelResponseEventState,
  createSessionTitleModelUsageEventState,
  emitModelCallUsage,
  processCompactionModelUsageEvent,
  processModelResponseTerminalEvent,
  processSessionTitleModelUsageEvent,
  type TurnEventPublisher,
} from "../src/activities/agent-turn/model-usage";

const PROVIDER = "organization-claude-subscription";
const MAIN_MODEL = `${PROVIDER}/claude-sonnet-5-5`;
const TITLE_MODEL = `${PROVIDER}/claude-haiku-5-5`;
const usage = { inputTokens: 164, outputTokens: 12, totalTokens: 176 };

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("model-usage-purpose");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function claimedTurn() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "model-usage-purpose",
    accountExternalId: suffix,
    accountName: "Model usage purpose",
    workspaceExternalSource: "model-usage-purpose",
    workspaceExternalId: suffix,
    workspaceName: "Model usage purpose",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    initialMessage: "Name this session",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("fixture turn not claimed");
  const publish: TurnEventPublisher = async (events, _immediate, mutate, project) =>
    await appendSessionEventsForTurnAttempt(
      client.db,
      workspaceId,
      session.id,
      claimed.turn.id,
      claimed.turn.executionGeneration,
      attemptId,
      events as AppendEventInput[],
      undefined,
      mutate || project
        ? {
            rowProjection: "event",
            mutate: mutate ?? (async () => true),
            ...(project ? { project } : {}),
          }
        : undefined,
    );
  return {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
    publish,
  };
}

function terminalInput(turn: Awaited<ReturnType<typeof claimedTurn>>, responseId: string) {
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    billingMode: "disabled",
    usageLimitsMode: "none",
  });
  return {
    ...turn,
    turnAttemptId: turn.attemptId,
    dispatchId: turn.attemptId,
    event: new RunRawModelStreamEvent({
      type: "response_done",
      response: { id: responseId, output: [], usage },
    }),
    state: createModelResponseEventState(),
    emittedSourceKeys: new Set<string>(),
    settings,
    db: client.db,
    observability: createObservability(settings, { component: "worker" }),
    model: MAIN_MODEL,
    provider: PROVIDER,
    providerApi: "anthropic-messages" as const,
    metricProvider: PROVIDER,
    externallyBilled: true,
    servingCredentialId: null,
    priorSessionCredentialId: null,
    renewLease: async () => {},
    leaseLost: () => false,
    leaseLostMessage: "fixture lease lost",
    processingResidency: modelCallProcessingResidency(null),
    setLastInputTokens: async () => {
      throw new Error("unexpected separate token transaction");
    },
  };
}

test("response checkpoint commits canonical usage, token signal and history; replay cannot replace them", async () => {
  const turn = await claimedTurn();
  let historyWrites = 0;
  const history: SessionEventMutation<"event"> = async (tx, fence) => {
    if (!fence.allowed) throw new Error("lost fixture fence");
    await appendSessionHistoryItemsInTransaction(
      tx,
      {
        ...turn,
        expectedAttemptId: turn.attemptId,
        expectedExecutionGeneration: turn.executionGeneration,
        items: [
          {
            position: 100,
            item: { type: "message", role: "assistant", content: "durable answer" },
          },
        ],
      },
      fence,
    );
    historyWrites++;
    return true;
  };
  const checkpoint = async (
    persist: (history: SessionEventMutation<"event">) => Promise<boolean>,
  ) => persist(history);
  const first = terminalInput(turn, "response-atomic");
  expect((await processModelResponseTerminalEvent({ ...first, checkpoint })).status).toBe(
    "processed",
  );
  expect(first.state.contextSignal?.totalTokens).toBe(176);
  expect(historyWrites).toBe(1);
  const [session] =
    await shared.admin`select last_input_tokens from sessions where id = ${turn.sessionId}`;
  expect(session!.last_input_tokens).toBe(164);
  const replay = terminalInput(turn, "response-atomic");
  expect(await processModelResponseTerminalEvent({ ...replay, checkpoint })).toMatchObject({
    authoritative: false,
  });
  expect(replay.state.contextSignal).toBeNull();
  expect(historyWrites).toBe(1);
  const [rows] =
    await shared.admin`select count(*)::int as count from session_history_items where session_id = ${turn.sessionId} and position = 100`;
  expect(rows!.count).toBe(1);
});

test("lost credential commits incurred usage but neither token signals nor prepared history", async () => {
  const turn = await claimedTurn();
  let historyWrites = 0;
  const input = terminalInput(turn, "response-lost-lease");
  await expect(
    processModelResponseTerminalEvent({
      ...input,
      leaseLost: () => true,
      checkpoint: async (persist) =>
        persist(async () => {
          historyWrites++;
          return true;
        }),
    }),
  ).rejects.toThrow("fixture lease lost");
  expect(historyWrites).toBe(0);
  expect(input.state.contextSignal).toBeNull();
  const [session] =
    await shared.admin`select last_input_tokens from sessions where id = ${turn.sessionId}`;
  expect(session!.last_input_tokens).toBeNull();
  const [events] =
    await shared.admin`select count(*)::int as count from session_events where session_id = ${turn.sessionId} and type = 'agent.model.usage' and turn_association = 'current'`;
  expect(events!.count).toBe(1);
  const [facts] =
    await shared.admin`select count(*)::int as count from model_call_facts where session_id = ${turn.sessionId}`;
  expect(facts!.count).toBe(1);
});

test("a soft fact SQL failure rolls back its savepoint without poisoning the response checkpoint", async () => {
  const turn = await claimedTurn();
  await shared.admin.unsafe(`
    create function fail_checkpoint_fact() returns trigger language plpgsql as $$
    begin raise exception using errcode = '22000', message = 'synthetic fact failure'; end $$;
    create trigger fail_checkpoint_fact before insert on model_call_facts
      for each row execute function fail_checkpoint_fact();
  `);
  try {
    const input = terminalInput(turn, "response-soft-fact");
    const result = await processModelResponseTerminalEvent({
      ...input,
      checkpoint: async (persist) => persist(async () => true),
    });
    expect(result).toMatchObject({ authoritative: true });
    expect(input.state.contextSignal?.totalTokens).toBe(176);
    const [session] =
      await shared.admin`select last_input_tokens from sessions where id = ${turn.sessionId}`;
    expect(session!.last_input_tokens).toBe(164);
    const [events] =
      await shared.admin`select count(*)::int as count from session_events where session_id = ${turn.sessionId} and type = 'agent.model.usage'`;
    expect(events!.count).toBe(1);
    const [facts] =
      await shared.admin`select count(*)::int as count from model_call_facts where session_id = ${turn.sessionId}`;
    expect(facts!.count).toBe(0);
  } finally {
    await shared.admin.unsafe(
      "drop trigger fail_checkpoint_fact on model_call_facts; drop function fail_checkpoint_fact()",
    );
  }
});

test("failed response projection rolls back its whole checkpoint without erasing incurred billing", async () => {
  const turn = await claimedTurn();
  const input = terminalInput(turn, "response-rollback");
  await expect(
    processModelResponseTerminalEvent({
      ...input,
      checkpoint: async (persist) =>
        persist(async () => {
          throw new Error("checkpoint crash");
        }),
    }),
  ).rejects.toThrow();
  expect(input.state.contextSignal).toBeNull();
  const [session] =
    await shared.admin`select last_input_tokens from sessions where id = ${turn.sessionId}`;
  expect(session!.last_input_tokens).toBeNull();
  const [events] =
    await shared.admin`select count(*)::int as count from session_events where session_id = ${turn.sessionId} and type = 'agent.model.usage'`;
  expect(events!.count).toBe(0);
  const [billing] =
    await shared.admin`select count(*)::int as count from usage_events where session_id = ${turn.sessionId}`;
  expect(billing!.count).toBeGreaterThan(0);
  const retry = terminalInput(turn, "response-rollback");
  await processModelResponseTerminalEvent({
    ...retry,
    checkpoint: async (persist) => persist(async () => true),
  });
  const [after] =
    await shared.admin`select count(*)::int as count from usage_events where session_id = ${turn.sessionId}`;
  expect(after!.count).toBe(billing!.count);
  expect(retry.state.contextSignal?.totalTokens).toBe(176);
});

test("real history savepoint failure retains response truth and can be reconciled after recovery", async () => {
  const turn = await claimedTurn();
  const input = terminalInput(turn, "response-history-failure");
  const sink = createTurnHistorySink({
    db: client.db,
    ...turn,
    getTurnId: () => turn.turnId,
    getExecutionGeneration: () => turn.executionGeneration,
    getModelRunSettings: () => input.settings,
    getStream: () => ({
      state: { history: [{ type: "message", role: "assistant", content: "recover this answer" }] },
    }),
    media: {
      retainNativeGeneratedImagesFromHistory: async () => {},
      retainedScreenshotReceiptsByCallId: new Map(),
      generatedImageReceiptsByProviderItemId: new Map(),
    },
  } as unknown as TurnHistorySinkDeps);
  sink.seedHistory([], 0);
  sink.nextHistoryPosition = 100;
  await shared.admin.unsafe(`
    create function fail_checkpoint_history() returns trigger language plpgsql as $$
    begin raise exception using errcode = '22000', message = 'synthetic history failure'; end $$;
    create trigger fail_checkpoint_history before insert on session_history_items
      for each row execute function fail_checkpoint_history();
  `);
  try {
    await expect(
      processModelResponseTerminalEvent({
        ...input,
        checkpoint: (persist) => sink.reconcileConversationTruth({ requireDurable: true, persist }),
      }),
    ).rejects.toThrow();
    expect(sink.persistedHistoryCount).toBe(0);
    const [session] =
      await shared.admin`select last_input_tokens from sessions where id = ${turn.sessionId}`;
    expect(session!.last_input_tokens).toBe(164);
    const [events] =
      await shared.admin`select count(*)::int as count from session_events where session_id = ${turn.sessionId} and type = 'agent.model.usage'`;
    expect(events!.count).toBe(1);
  } finally {
    await shared.admin.unsafe(
      "drop trigger fail_checkpoint_history on session_history_items; drop function fail_checkpoint_history()",
    );
  }
  await sink.reconcileConversationTruth({ requireDurable: true });
  expect(sink.persistedHistoryCount).toBe(1);
  const [history] =
    await shared.admin`select count(*)::int as count from session_history_items where session_id = ${turn.sessionId} and position = 100`;
  expect(history!.count).toBe(1);
});

test("the session-event writer keeps the canonical event's worker-set purpose", async () => {
  const turn = await claimedTurn();
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    billingMode: "disabled",
    usageLimitsMode: "none",
  });
  const observability = createObservability(settings, { component: "worker" });
  const base = {
    dispatchId: "dispatch-A",
    settings,
    db: client.db,
    observability,
    publish: turn.publish,
    accountId: turn.accountId,
    workspaceId: turn.workspaceId,
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    turnAttemptId: turn.attemptId,
    provider: PROVIDER,
    providerApi: "anthropic-messages" as const,
    externallyBilled: true,
    servingCredentialId: null,
    priorSessionCredentialId: null,
    renewLease: async () => undefined,
    leaseLost: () => false,
    leaseLostMessage: "lease lost",
  };
  const claimed = new Set<string>();
  const emitted = new Set<string>();

  const results = [
    await processModelResponseTerminalEvent({
      ...base,
      model: MAIN_MODEL,
      event: new RunRawModelStreamEvent({
        type: "response_done",
        response: { id: "msg_main", output: [], usage },
      } as any) as any,
      state: createModelResponseEventState(claimed),
      metricProvider: PROVIDER,
      emittedSourceKeys: emitted,
      setLastInputTokens: async () => undefined,
    }),
    await processCompactionModelUsageEvent({
      ...base,
      model: MAIN_MODEL,
      usage: { responseId: "msg_compaction", usage } as any,
      state: createCompactionModelUsageEventState(claimed),
      emittedSourceKeys: emitted,
    }),
    await processSessionTitleModelUsageEvent({
      ...base,
      model: TITLE_MODEL,
      usage: { responseId: "msg_title", usage } as any,
      state: createSessionTitleModelUsageEventState(claimed),
      emittedSourceKeys: emitted,
    }),
  ];
  expect(results.map((result) => result.status === "processed" && result.authoritative)).toEqual([
    true,
    true,
    true,
  ]);
  // A pre-upgrade worker committed this usage without a purpose.
  const legacy = await turn.publish(
    [
      {
        type: "agent.model.usage",
        payload: {
          accountId: turn.accountId,
          workspaceId: turn.workspaceId,
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          provider: PROVIDER,
          providerApi: "anthropic-messages",
          model: TITLE_MODEL,
          sourceKey: "msg_legacy",
          ...usage,
        },
      },
    ],
    true,
  );
  expect(legacy.accepted).toBe(true);
  // Fresh process state replays the title response, and a newer writer labels the legacy one.
  expect(
    await processSessionTitleModelUsageEvent({
      ...base,
      model: TITLE_MODEL,
      usage: { responseId: "msg_title", usage } as any,
      state: createSessionTitleModelUsageEventState(),
      emittedSourceKeys: new Set(),
    }),
  ).toEqual({ status: "processed", sourceKey: "msg_title", authoritative: false });
  expect(
    await emitModelCallUsage({
      observability,
      publish: turn.publish,
      accountId: turn.accountId,
      workspaceId: turn.workspaceId,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      provider: PROVIDER,
      providerApi: "anthropic-messages",
      model: TITLE_MODEL,
      purpose: "session-title",
      sourceKey: "msg_legacy",
      usage: { usage },
    }),
  ).toBe(false);

  const rows = await shared.admin<
    Array<{
      id: string;
      payload: Record<string, unknown>;
      turn_association: string;
      duplicate_of_event_id: string | null;
    }>
  >`select id, payload, turn_association, duplicate_of_event_id from session_events
    where workspace_id = ${turn.workspaceId} and session_id = ${turn.sessionId}
      and type = 'agent.model.usage'
    order by sequence`;
  expect(
    rows.map((row) => [
      row.payload.sourceKey,
      row.payload.purpose ?? null,
      row.payload.model,
      row.turn_association,
    ]),
  ).toEqual([
    ["msg_main", "main", MAIN_MODEL, "current"],
    ["msg_compaction", "compaction", MAIN_MODEL, "current"],
    ["msg_title", "session-title", TITLE_MODEL, "current"],
    ["msg_legacy", null, TITLE_MODEL, "current"],
    ["msg_title", "session-title", TITLE_MODEL, "duplicate"],
    ["msg_legacy", "session-title", TITLE_MODEL, "duplicate"],
  ]);
  expect(rows[4]!.duplicate_of_event_id).toBe(rows[2]!.id);
  expect(rows[5]!.duplicate_of_event_id).toBe(rows[3]!.id);
}, 60_000);
