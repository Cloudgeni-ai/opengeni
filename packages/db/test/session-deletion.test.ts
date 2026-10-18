import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createWorkspace,
  deleteSessionTreeIfQuiescent,
  deleteWorkspaceIfQuiescent,
  initializeSessionStartAtomically,
  isSessionDefinitivelyDeleted,
  peekSessionWork,
  waitForSessionInputWithEvent,
  withSessionRlsActorContext,
} from "../src/index";
import { createSessionStateActivities } from "../../../apps/worker/src/activities/session-state";
import { createGoalActivities } from "../../../apps/worker/src/activities/goals";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-deletion");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(initialMessage = "") {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "deletion-test",
    accountExternalId: id,
    accountName: "Deletion test",
    workspaceExternalSource: "deletion-test",
    workspaceExternalId: id,
    workspaceName: "Deletion test",
    subjectId: `subject-${id}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { grant, workspaceId, session };
}

test("application-role deletion proof distinguishes tenant/actor invisibility and deleted rows", async () => {
  const { grant, workspaceId, session } = await fixture();
  const absentId = crypto.randomUUID();
  expect(
    await isSessionDefinitivelyDeleted(client.db, workspaceId, session.id, grant.accountId),
  ).toBe(false);
  expect(
    await isSessionDefinitivelyDeleted(client.db, workspaceId, absentId, crypto.randomUUID()),
  ).toBe(false);
  expect(
    await withSessionRlsActorContext({ subjectId: "other-human" }, () =>
      isSessionDefinitivelyDeleted(client.db, workspaceId, absentId, grant.accountId),
    ),
  ).toBe(false);
  expect(
    await isSessionDefinitivelyDeleted(client.db, workspaceId, absentId, grant.accountId),
  ).toBe(true);
  expect(
    await isSessionDefinitivelyDeleted(client.db, crypto.randomUUID(), absentId, grant.accountId),
  ).toBe(true);
  const activities = createSessionStateActivities(async () => ({ db: client.db }) as any);
  const input = { workspaceId, sessionId: session.id, observerAccountId: grant.accountId };
  expect(
    await deleteSessionTreeIfQuiescent(client.db, {
      workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
    }),
  ).toMatchObject({ status: "deleted" });
  expect(await activities.peekSessionWork(input)).toEqual({ kind: "unavailable" });
  expect(await activities.peekSessionWork({ ...input, includeDeletion: true })).toEqual({
    kind: "deleted",
  });
  await expect(activities.markSessionIdle(input)).resolves.toBeUndefined();
  await expect(
    activities.markSessionIdle({ workspaceId: crypto.randomUUID(), sessionId: session.id }),
  ).resolves.toBeUndefined();
  const deletedScope = {
    accountId: grant.accountId,
    workspaceId: crypto.randomUUID(),
    sessionId: session.id,
  };
  const goals = createGoalActivities(async () => ({ db: client.db }) as any);
  await expect(
    goals.maybeContinueGoal({ ...deletedScope, workflowId: "deleted" }),
  ).resolves.toEqual({ action: "none" });
  await expect(
    activities.settleSessionInterruptions({
      ...deletedScope,
      workflowId: "deleted",
      attemptId: crypto.randomUUID(),
    }),
  ).resolves.toEqual({ action: "stale" });
  await expect(
    activities.persistSessionAttemptQuiescence({
      ...deletedScope,
      workflowId: "deleted",
      workflowRunId: crypto.randomUUID(),
      activityId: "deleted",
      attemptId: crypto.randomUUID(),
    }),
  ).resolves.toBeUndefined();
}, 60_000);

async function settledFixture(waitForInput = false) {
  const scope = await fixture("Complete this turn");
  const { grant, workspaceId, session } = scope;
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
    goal: null,
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
  if (claimed.action !== "claimed") throw new Error("Test turn was not claimed");
  const turn = claimed.turn;
  if (waitForInput) {
    await waitForSessionInputWithEvent(client.db, workspaceId, session.id, {
      reason: "Waiting for test input",
      timeoutSeconds: 600,
      command: {
        accountId: grant.accountId,
        actor: {
          type: "agent_attempt",
          attemptId,
          sessionId: session.id,
          turnId: turn.id,
          executionGeneration: turn.executionGeneration,
        },
        operationKey: crypto.randomUUID(),
      },
    });
  }
  expect(
    await applySessionTurnSettlement(client.db, workspaceId, {
      sessionId: session.id,
      turnId: turn.id,
      triggerEventId: turn.triggerEventId,
      attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "test" } }],
    }),
  ).toMatchObject({ action: "settled" });
  return { ...scope, turn, attemptId };
}

test("recoverDispatch returns stale after canonical deletion of a durably settled session", async () => {
  const { grant, workspaceId, session, attemptId } = await settledFixture();
  const publish = mock(async () => undefined);
  const activities = createSessionStateActivities(async () => ({ db: client.db }) as any, {
    publishDurableSessionEvents: publish,
  });
  expect(
    await deleteSessionTreeIfQuiescent(client.db, {
      workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
    }),
  ).toMatchObject({ status: "deleted" });
  const input = {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    attemptId,
    timeoutType: "HEARTBEAT" as const,
  };
  // A denied absence proof must keep the original activity failure retryable.
  await expect(
    activities.recoverDispatch({ ...input, accountId: crypto.randomUUID() }),
  ).rejects.toThrow();
  await expect(
    withSessionRlsActorContext({ subjectId: "other-human" }, () =>
      activities.recoverDispatch(input),
    ),
  ).rejects.toThrow();
  await expect(activities.recoverDispatch(input)).resolves.toEqual({ action: "stale" });
  expect(publish).not.toHaveBeenCalled();
}, 60_000);

test("settleSessionInputWait returns stale after canonical workspace deletion between peek and settlement", async () => {
  const { grant, workspaceId, session, turn } = await settledFixture(true);
  // Canonical deletion requires another workspace in the same organization.
  await createWorkspace(client.db, {
    accountId: grant.accountId,
    name: "Surviving test workspace",
  });
  const peek = await peekSessionWork(client.db, workspaceId, session.id, false, grant.accountId);
  expect(peek).toMatchObject({ kind: "input-wait", disposition: "held", waitTurnId: turn.id });
  if (peek.kind !== "input-wait") throw new Error("Missing durable input wait");
  expect(
    await deleteWorkspaceIfQuiescent(client.db, { accountId: grant.accountId, workspaceId }),
  ).toMatchObject({ status: "deleted" });
  const publish = mock(async () => undefined);
  const activities = createSessionStateActivities(async () => ({ db: client.db }) as any, {
    publishDurableSessionEvents: publish,
  });
  await expect(
    activities.settleSessionInputWait({
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      waitTurnId: peek.waitTurnId,
      disposition: peek.disposition,
    }),
  ).resolves.toEqual({ action: "stale" });
  expect(publish).not.toHaveBeenCalled();
}, 60_000);
