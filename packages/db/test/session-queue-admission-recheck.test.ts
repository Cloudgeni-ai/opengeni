import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  blockSessionWorkBeforeAttemptClaim,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  listSessionTurns,
  initializeSessionStartAtomically,
  markSessionWorkflowWakeDelivered,
  peekSessionWork,
  steerQueuedTurnInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("queue-admission-recheck");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Queue recheck",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Queue recheck",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "Accepted work",
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    resources: [],
    metadata: {},
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  });
  const turns = await listSessionTurns(client.db, workspaceId, session.id);
  const target = turns[0]!;
  return { grant, workspaceId, sessionId: session.id, target };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function block(f: Fixture) {
  const peek = await peekSessionWork(client.db, f.workspaceId, f.sessionId, true);
  if (peek.kind !== "runnable" || !peek.admissionFence) throw new Error("fixture not runnable");
  expect(
    await blockSessionWorkBeforeAttemptClaim(client.db, f.workspaceId, {
      accountId: f.grant.accountId,
      sessionId: f.sessionId,
      workflowId: `session-${f.sessionId}`,
      attemptId: crypto.randomUUID(),
      fence: peek.admissionFence,
      reason: "database_claim_rejected",
      sqlState: "42501",
    }),
  ).toMatchObject({ action: "blocked" });
}

function steer(f: Fixture, operationKey: string) {
  return withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.grant.subjectId, (db) =>
    db.transaction((tx) =>
      steerQueuedTurnInTransaction(tx as unknown as typeof db, {
        accountId: f.grant.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        turnId: f.target.id,
        expectedTurnVersion: f.target.version,
        actor: { type: "human", subjectId: f.grant.subjectId },
        operationKey,
      }),
    ),
  );
}

test("queue-row Steer rechecks admission and retains wake debt until the prompt is claimed", async () => {
  const f = await fixture();
  await block(f);
  expect(await peekSessionWork(client.db, f.workspaceId, f.sessionId)).toEqual({
    kind: "admission-blocked",
  });
  const result = await steer(f, crypto.randomUUID());
  expect(await getSession(client.db, f.workspaceId, f.sessionId)).toMatchObject({
    status: "queued",
    admissionBlock: null,
  });
  expect(await peekSessionWork(client.db, f.workspaceId, f.sessionId)).toMatchObject({
    kind: "runnable",
  });
  expect(
    await markSessionWorkflowWakeDelivered(client.db, {
      accountId: f.grant.accountId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      temporalWorkflowId: result.workflowId,
      wakeRevision: result.wakeRevision,
    }),
  ).toEqual({ action: "pending_admission", blocker: "pending_prompt_turn" });
  const claimed = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId: f.sessionId,
    workflowId: result.workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(claimed).toMatchObject({ action: "claimed", turn: { id: f.target.id } });
});

test("replaying an earlier queue Steer cannot clear a newer admission rejection", async () => {
  const f = await fixture();
  const operationKey = crypto.randomUUID();
  await block(f);
  await steer(f, operationKey);
  await block(f);
  const before = await getSession(client.db, f.workspaceId, f.sessionId);
  const replay = await steer(f, operationKey);
  expect(replay.replay).toBe(true);
  expect((await getSession(client.db, f.workspaceId, f.sessionId))?.admissionBlock).toEqual(
    before?.admissionBlock,
  );
  expect(await peekSessionWork(client.db, f.workspaceId, f.sessionId)).toEqual({
    kind: "admission-blocked",
  });
});
