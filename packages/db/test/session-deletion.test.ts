import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  deleteSessionTreeIfQuiescent,
  isSessionDefinitivelyDeleted,
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

test("application-role deletion proof distinguishes tenant/actor invisibility and deleted rows", async () => {
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
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
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
