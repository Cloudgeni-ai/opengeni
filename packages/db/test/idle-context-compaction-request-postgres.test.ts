import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  convertSessionToPortableCompactionForModelSwitch,
  createDb,
  createSession,
  createSessionGoal,
  enqueueSessionWorkflowWake,
  getSessionEvent,
  recordSkippedContextCompaction,
  requestIdleSessionCompactionIfDue,
  requestSessionCompaction,
  sessionCompactionRequestTrigger,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const db = await acquireSharedTestDatabase("idle-context-compaction-request");
  if (!db) throw new Error("test postgres unavailable");
  shared = db;
  client = createDb(db.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const THRESHOLD = 244_800;

async function fixture(options: { parent?: boolean } = {}) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "idle compaction",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "idle compaction",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const base: Parameters<typeof createSession>[1] = {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  };
  const root = await createSession(client.db, base);
  const session = options.parent
    ? await createSession(client.db, { ...base, parentSessionId: root.id })
    : root;
  return { grant, workspaceId, session };
}

async function setLastInputTokens(workspaceId: string, sessionId: string, tokens: number | null) {
  await withWorkspaceSessionActivityRls(client.db, workspaceId, async (db) => {
    await db
      .update(schema.sessions)
      .set({ lastInputTokens: tokens })
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
  });
}

async function storedTrigger(workspaceId: string, sessionId: string) {
  return await withWorkspaceRls(client.db, workspaceId, async (db) => {
    const [row] = await db
      .select({
        compactRequested: schema.sessions.compactRequested,
        compactRequestTrigger: schema.sessions.compactRequestTrigger,
      })
      .from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    return row!;
  });
}

async function claim(workspaceId: string, sessionId: string, attemptId = crypto.randomUUID()) {
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`not claimed: ${JSON.stringify(claimed)}`);
  return claimed.turn;
}

test("an idle root session at its threshold gets a proactive maintenance compaction", async () => {
  const { grant, workspaceId, session } = await fixture();
  await setLastInputTokens(workspaceId, session.id, THRESHOLD + 695);

  const requested = await requestIdleSessionCompactionIfDue(client.db, {
    workspaceId,
    sessionId: session.id,
    thresholdTokens: THRESHOLD,
  });
  expect(requested).toMatchObject({ requested: true, temporalWorkflowId: `session-${session.id}` });
  expect(await sessionCompactionRequestTrigger(client.db, workspaceId, session.id)).toBe(
    "proactive",
  );

  // Already pending: a second idle request changes nothing.
  expect(
    await requestIdleSessionCompactionIfDue(client.db, {
      workspaceId,
      sessionId: session.id,
      thresholdTokens: THRESHOLD,
    }),
  ).toEqual({ requested: false, reason: "already_requested" });

  const attemptId = crypto.randomUUID();
  const turn = await claim(workspaceId, session.id, attemptId);
  expect(turn.source).toBe("compaction");
  const requestedEvent = await getSessionEvent(client.db, workspaceId, turn.triggerEventId);
  expect(requestedEvent?.type).toBe("session.context.compaction.requested");
  expect(requestedEvent?.payload).toMatchObject({ trigger: "proactive" });

  // A running session is no longer idle.
  expect(
    await requestIdleSessionCompactionIfDue(client.db, {
      workspaceId,
      sessionId: session.id,
      thresholdTokens: THRESHOLD,
    }),
  ).toEqual({ requested: false, reason: "not_idle" });

  // Consuming the request clears its label with it.
  expect(
    await recordSkippedContextCompaction(client.db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      turnId: turn.id,
      expectedExecutionGeneration: turn.executionGeneration,
      expectedAttemptId: attemptId,
      reason: "no_history",
    }),
  ).toMatchObject({ recorded: true });
  expect(await storedTrigger(workspaceId, session.id)).toEqual({
    compactRequested: false,
    compactRequestTrigger: null,
  });
  expect(await sessionCompactionRequestTrigger(client.db, workspaceId, session.id)).toBeNull();
}, 180_000);

test("below threshold, unknown tokens and child sessions are not requested", async () => {
  const below = await fixture();
  await setLastInputTokens(below.workspaceId, below.session.id, THRESHOLD - 1);
  expect(
    await requestIdleSessionCompactionIfDue(client.db, {
      workspaceId: below.workspaceId,
      sessionId: below.session.id,
      thresholdTokens: THRESHOLD,
    }),
  ).toEqual({ requested: false, reason: "below_threshold" });

  const unknown = await fixture();
  await setLastInputTokens(unknown.workspaceId, unknown.session.id, null);
  expect(
    await requestIdleSessionCompactionIfDue(client.db, {
      workspaceId: unknown.workspaceId,
      sessionId: unknown.session.id,
      thresholdTokens: THRESHOLD,
    }),
  ).toEqual({ requested: false, reason: "below_threshold" });

  const child = await fixture({ parent: true });
  await setLastInputTokens(child.workspaceId, child.session.id, THRESHOLD + 1);
  expect(
    await requestIdleSessionCompactionIfDue(client.db, {
      workspaceId: child.workspaceId,
      sessionId: child.session.id,
      thresholdTokens: THRESHOLD,
    }),
  ).toEqual({ requested: false, reason: "child_session" });

  for (const value of [below, unknown, child]) {
    expect(await storedTrigger(value.workspaceId, value.session.id)).toEqual({
      compactRequested: false,
      compactRequestTrigger: null,
    });
  }
}, 180_000);

test("an operator /compact always wins the label and is never relabeled", async () => {
  const { workspaceId, session } = await fixture();
  await setLastInputTokens(workspaceId, session.id, THRESHOLD);

  expect(
    await requestIdleSessionCompactionIfDue(client.db, {
      workspaceId,
      sessionId: session.id,
      thresholdTokens: THRESHOLD,
    }),
  ).toMatchObject({ requested: true });
  await requestSessionCompaction(client.db, workspaceId, session.id);
  expect(await sessionCompactionRequestTrigger(client.db, workspaceId, session.id)).toBe(
    "operator",
  );

  expect(
    await requestIdleSessionCompactionIfDue(client.db, {
      workspaceId,
      sessionId: session.id,
      thresholdTokens: THRESHOLD,
    }),
  ).toEqual({ requested: false, reason: "already_requested" });
  expect(await sessionCompactionRequestTrigger(client.db, workspaceId, session.id)).toBe(
    "operator",
  );

  const turn = await claim(workspaceId, session.id);
  const requestedEvent = await getSessionEvent(client.db, workspaceId, turn.triggerEventId);
  expect(requestedEvent?.payload).toMatchObject({ trigger: "operator" });
}, 180_000);

async function setSessionColumns(
  workspaceId: string,
  sessionId: string,
  values: Partial<typeof schema.sessions.$inferInsert>,
) {
  await withWorkspaceSessionActivityRls(client.db, workspaceId, async (db) => {
    await db
      .update(schema.sessions)
      .set(values)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
  });
}

async function eventsOfTurn(workspaceId: string, sessionId: string, turnId: string) {
  return await withWorkspaceRls(client.db, workspaceId, async (db) =>
    db
      .select({ type: schema.sessionEvents.type, payload: schema.sessionEvents.payload })
      .from(schema.sessionEvents)
      .where(
        and(
          eq(schema.sessionEvents.workspaceId, workspaceId),
          eq(schema.sessionEvents.sessionId, sessionId),
          eq(schema.sessionEvents.turnId, turnId),
        ),
      )
      .orderBy(schema.sessionEvents.sequence),
  );
}

/** The capacity-deferral settlement `deferCoreCompaction` sends. */
async function deferForCapacity(
  workspaceId: string,
  sessionId: string,
  turn: { id: string; triggerEventId: string },
  attemptId: string,
) {
  return await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId,
    turnId: turn.id,
    triggerEventId: turn.triggerEventId,
    attemptId,
    turnStatus: "cancelled",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [
      {
        type: "turn.cancelled",
        payload: {
          maintenance: "context_compaction",
          reason: "subscription_capacity_unavailable",
          waitReason: "all_capped",
          requestPreserved: true,
        },
      },
      { type: "session.status.changed", payload: { status: "idle" } },
    ],
    dropProactiveCompactionRequest: {},
  });
}

test("a capacity deferral drops a proactive request and keeps an operator one", async () => {
  const proactive = await fixture();
  await setLastInputTokens(proactive.workspaceId, proactive.session.id, THRESHOLD);
  expect(
    await requestIdleSessionCompactionIfDue(client.db, {
      workspaceId: proactive.workspaceId,
      sessionId: proactive.session.id,
      thresholdTokens: THRESHOLD,
    }),
  ).toMatchObject({ requested: true });
  const proactiveAttempt = crypto.randomUUID();
  const proactiveTurn = await claim(proactive.workspaceId, proactive.session.id, proactiveAttempt);
  expect(
    await deferForCapacity(
      proactive.workspaceId,
      proactive.session.id,
      proactiveTurn,
      proactiveAttempt,
    ),
  ).toMatchObject({ action: "settled" });
  expect(await storedTrigger(proactive.workspaceId, proactive.session.id)).toEqual({
    compactRequested: false,
    compactRequestTrigger: null,
  });
  const proactiveEvents = await eventsOfTurn(
    proactive.workspaceId,
    proactive.session.id,
    proactiveTurn.id,
  );
  expect(proactiveEvents.map((event) => event.type)).toEqual([
    "session.context.compaction.requested",
    "session.context.compaction.skipped",
    "turn.cancelled",
    "session.status.changed",
  ]);
  expect(proactiveEvents[1]?.payload).toEqual({
    reason: "capacity_unavailable",
    trigger: "proactive",
  });
  expect(proactiveEvents[2]?.payload).toMatchObject({ requestPreserved: false });

  const operator = await fixture();
  await requestSessionCompaction(client.db, operator.workspaceId, operator.session.id);
  const operatorAttempt = crypto.randomUUID();
  const operatorTurn = await claim(operator.workspaceId, operator.session.id, operatorAttempt);
  expect(
    await deferForCapacity(
      operator.workspaceId,
      operator.session.id,
      operatorTurn,
      operatorAttempt,
    ),
  ).toMatchObject({ action: "settled" });
  expect(await storedTrigger(operator.workspaceId, operator.session.id)).toEqual({
    compactRequested: true,
    compactRequestTrigger: "operator",
  });
  const operatorEvents = await eventsOfTurn(
    operator.workspaceId,
    operator.session.id,
    operatorTurn.id,
  );
  expect(operatorEvents.map((event) => event.type)).toEqual([
    "session.context.compaction.requested",
    "turn.cancelled",
    "session.status.changed",
  ]);
  expect(operatorEvents[1]?.payload).toMatchObject({ requestPreserved: true });
}, 180_000);

test("an active goal, a held wait and a delayed wake are left alone", async () => {
  const goal = await fixture();
  await setLastInputTokens(goal.workspaceId, goal.session.id, THRESHOLD);
  await createSessionGoal(client.db, {
    accountId: goal.grant.accountId,
    workspaceId: goal.workspaceId,
    sessionId: goal.session.id,
    text: "keep going",
    createdBy: "api",
  });
  expect(
    await requestIdleSessionCompactionIfDue(client.db, {
      workspaceId: goal.workspaceId,
      sessionId: goal.session.id,
      thresholdTokens: THRESHOLD,
    }),
  ).toEqual({ requested: false, reason: "active_goal" });

  // A held wait: the declaring turn is the newest finished turn and its
  // deadline is in the future.
  const wait = await fixture();
  await requestSessionCompaction(client.db, wait.workspaceId, wait.session.id);
  const waitAttempt = crypto.randomUUID();
  const declaring = await claim(wait.workspaceId, wait.session.id, waitAttempt);
  expect(
    await applySessionTurnSettlement(client.db, wait.workspaceId, {
      sessionId: wait.session.id,
      turnId: declaring.id,
      triggerEventId: declaring.triggerEventId,
      attemptId: waitAttempt,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "session.status.changed", payload: { status: "idle" } }],
    }),
  ).toMatchObject({ action: "settled" });
  await setSessionColumns(wait.workspaceId, wait.session.id, {
    compactRequested: false,
    compactRequestTrigger: null,
    lastInputTokens: THRESHOLD,
    inputWaitTurnId: declaring.id,
    inputWaitUntil: new Date(Date.now() + 3_600_000),
    inputWaitReason: "waiting for the reviewer",
    inputWaitSetAt: new Date(),
  });
  expect(
    await requestIdleSessionCompactionIfDue(client.db, {
      workspaceId: wait.workspaceId,
      sessionId: wait.session.id,
      thresholdTokens: THRESHOLD,
    }),
  ).toEqual({ requested: false, reason: "input_wait" });

  const delayed = await fixture();
  await setLastInputTokens(delayed.workspaceId, delayed.session.id, THRESHOLD);
  await enqueueSessionWorkflowWake(client.db, {
    accountId: delayed.grant.accountId,
    workspaceId: delayed.workspaceId,
    sessionId: delayed.session.id,
    temporalWorkflowId: `session-${delayed.session.id}`,
    reason: "test_backoff",
    notBefore: new Date(Date.now() + 60_000),
  });
  expect(
    await requestIdleSessionCompactionIfDue(client.db, {
      workspaceId: delayed.workspaceId,
      sessionId: delayed.session.id,
      thresholdTokens: THRESHOLD,
    }),
  ).toEqual({ requested: false, reason: "pending_delayed_wake" });

  for (const value of [goal, wait, delayed]) {
    expect(await storedTrigger(value.workspaceId, value.session.id)).toEqual({
      compactRequested: false,
      compactRequestTrigger: null,
    });
  }
}, 180_000);

test("a model-switch request never inherits a stale label", async () => {
  const { workspaceId, session } = await fixture();
  // A fork copies the source row's label even with no request pending.
  await setSessionColumns(workspaceId, session.id, {
    codexCompactionMode: "remote_v2",
    compactRequested: false,
    compactRequestTrigger: "proactive",
  });
  const converted = await convertSessionToPortableCompactionForModelSwitch(
    client.db,
    workspaceId,
    session.id,
  );
  expect(converted).not.toBe("fenced");
  expect((await storedTrigger(workspaceId, session.id)).compactRequestTrigger).toBeNull();

  // A request already pending keeps its own label.
  await setSessionColumns(workspaceId, session.id, {
    codexCompactionMode: "remote_v2",
    compactRequested: true,
    compactRequestTrigger: "proactive",
  });
  await convertSessionToPortableCompactionForModelSwitch(client.db, workspaceId, session.id);
  expect(await storedTrigger(workspaceId, session.id)).toEqual({
    compactRequested: true,
    compactRequestTrigger: "proactive",
  });
}, 180_000);
