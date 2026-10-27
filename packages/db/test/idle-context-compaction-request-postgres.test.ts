import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
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
