import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { coalesceSessionEventDeltasWithCoverage } from "../../events/src/coalesce";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  foldSessionTurnDeltas,
  listSessionDeltaFoldCandidates,
  listSessionEventPage,
  submitHumanPromptInTransaction,
  unfoldSessionEventDeltas,
  withWorkspaceSessionActivityRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-delta-folding");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/** A session whose one turn streamed an answer and reasoning, settled an hour ago. */
async function settledTurn() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Delta folding",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Delta folding",
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
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    sessionId: session.id,
  };
  await withWorkspaceSessionActivityRls(client.db, scope.workspaceId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        ...scope,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Explain it",
        resources: [],
        source: "user",
        reasoningEffortFallback: "medium",
      }),
    ),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("turn was not claimed");
  await applySessionTurnSettlement(client.db, scope.workspaceId, {
    sessionId: session.id,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [
      { type: "agent.reasoning.delta", payload: { text: "Think" } },
      { type: "agent.reasoning.delta", payload: { text: "ing." } },
      // A surrogate pair split across fragments must survive folding.
      { type: "agent.message.delta", payload: { text: "Hi \uD83D", messageId: "m1" } },
      { type: "agent.message.delta", payload: { text: "\uDE00 there", messageId: "m1" } },
      { type: "agent.message.delta", payload: { text: "!", messageId: "m1" } },
      { type: "agent.toolCall.created", payload: { callId: "c1", name: "lookup" } },
      { type: "agent.message.delta", payload: { text: "Done", messageId: "m2" } },
      { type: "agent.message.completed", payload: { text: "Hi \uD83D\uDE00 there!" } },
      { type: "turn.completed", payload: { output: "Hi" } },
    ],
  });
  await shared.admin.begin(async (sql) => {
    await sql`set local session_replication_role = replica`;
    await sql`update session_turns set updated_at = updated_at - interval '1 hour'
      where workspace_id = ${scope.workspaceId} and session_id = ${scope.sessionId}`;
  });
  return { ...scope, turnId: claimed.turn.id };
}

async function allEvents(scope: { workspaceId: string; sessionId: string }) {
  return (
    await listSessionEventPage(client.db, scope.workspaceId, scope.sessionId, {
      after: 0,
      limit: 500,
      payloadMode: "full",
    })
  ).events;
}

describe("folding streamed deltas of settled turns", () => {
  test("folds adjacent runs losslessly and only once", async () => {
    const turn = await settledTurn();
    const before = await allEvents(turn);
    const deltasBefore = before.filter((event) => event.type.endsWith(".delta"));
    expect(deltasBefore.length).toBe(6);

    const candidates = await listSessionDeltaFoldCandidates(client.db, {
      settleSeconds: 600,
      limit: 500,
    });
    const candidate = candidates.find((entry) => entry.turnId === turn.turnId);
    expect(candidate).toBeDefined();
    expect(await foldSessionTurnDeltas(client.db, candidate!)).toEqual({
      runs: 2,
      removedRows: 3,
      refused: 0,
    });

    const after = await allEvents(turn);
    expect(after.length).toBe(before.length - 3);
    const reasoning = after.find((event) => event.type === "agent.reasoning.delta")!;
    expect(reasoning.payload).toMatchObject({
      text: "Thinking.",
      coalescedUntil: reasoning.sequence + 1,
    });
    const answer = after.find(
      (event) =>
        event.type === "agent.message.delta" &&
        (event.payload as { messageId?: string }).messageId === "m1",
    )!;
    expect((answer.payload as { text: string }).text).toBe("Hi \uD83D\uDE00 there!");
    // The lone fragment after the tool call is not folded.
    expect(
      after.find(
        (event) =>
          event.type === "agent.message.delta" &&
          (event.payload as { messageId?: string }).messageId === "m2",
      )?.payload,
    ).toEqual({ text: "Done", messageId: "m2" });

    // Unfolding restores every original fragment exactly.
    const restored = after.flatMap(unfoldSessionEventDeltas);
    const project = (events: typeof before) =>
      events
        .filter((event) => event.type.endsWith(".delta"))
        .map((event) => ({
          id: event.id,
          sequence: event.sequence,
          type: event.type,
          payload: event.payload,
          occurredAt: event.occurredAt,
        }));
    expect(project(restored)).toEqual(project(deltasBefore));

    // Read projections cover the folded sequences.
    const projection = coalesceSessionEventDeltasWithCoverage(after);
    expect(projection.coveredThroughBySequence.get(answer.sequence)).toBe(answer.sequence + 2);

    // The turn is recorded as folded and is not offered again.
    const again = await listSessionDeltaFoldCandidates(client.db, {
      settleSeconds: 600,
      limit: 500,
    });
    expect(again.some((entry) => entry.turnId === turn.turnId)).toBe(false);
  }, 120_000);

  test("a turn that settled moments ago is not a candidate, and a mismatched run is refused", async () => {
    const turn = await settledTurn();
    await shared.admin.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await sql`update session_turns set updated_at = now() where id = ${turn.turnId}`;
    });
    const candidates = await listSessionDeltaFoldCandidates(client.db, {
      settleSeconds: 600,
      limit: 500,
    });
    expect(candidates.some((entry) => entry.turnId === turn.turnId)).toBe(false);

    const events = await allEvents(turn);
    const reasoning = events.filter((event) => event.type === "agent.reasoning.delta");
    const payload = JSON.stringify({
      text: "x",
      coalescedUntil: reasoning[1]!.sequence,
      folded: { v: 1, parts: [] },
    });
    const [refused] = await shared.admin`select opengeni_private.fold_session_event_delta_run(
      ${turn.workspaceId}::uuid, ${turn.sessionId}::uuid, ${turn.turnId}::uuid,
      ${reasoning[0]!.sequence}::integer, ${reasoning[1]!.sequence}::integer,
      ${`{${reasoning[1]!.id},${reasoning[0]!.id}}`}::uuid[],
      ${payload}::jsonb, 1) as removed`;
    expect(Number(refused!.removed)).toBe(-1);
    expect((await allEvents(turn)).length).toBe(events.length);
  }, 120_000);
});
