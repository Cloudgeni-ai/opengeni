import { afterAll, beforeAll, expect, test } from "bun:test";
import { RunRawModelStreamEvent } from "@openai/agents-core";
import {
  appendSessionEventsForTurnAttempt,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  type AppendEventInput,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
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
  const publish: TurnEventPublisher = async (events) =>
    await appendSessionEventsForTurnAttempt(
      client.db,
      workspaceId,
      session.id,
      claimed.turn.id,
      claimed.turn.executionGeneration,
      attemptId,
      events as AppendEventInput[],
    );
  return {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    publish,
  };
}

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
