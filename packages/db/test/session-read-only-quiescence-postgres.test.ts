import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { ApplicationFailure } from "@temporalio/activity";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  isSessionExecutionReadOnly,
  mutateSessionControlInTransaction,
  peekSessionWork,
  settleSessionAttemptInterruptions,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
import { createSessionStateActivities } from "../../../apps/worker/src/activities/session-state";
import {
  SESSION_READ_ONLY_FAILURE_MESSAGE,
  SESSION_READ_ONLY_FAILURE_TYPE,
} from "../../../apps/worker/src/activities/types";

setDefaultTimeout(30_000);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-read-only-quiescence");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/**
 * The state a session reaches when Archive cancels its running turn and the
 * idle archiver stores its content before the cancelled turn's activity has
 * reported that it physically stopped: the attempt is closed with a settled
 * interruption, its quiescence receipt is still missing, and (unless `archive`
 * is false) the session is read-only. The activity's late proof then arrives.
 */
async function archivedWhileAwaitingQuiescence(archive = true) {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "read-only-quiescence-test",
    accountExternalId: id,
    accountName: "Read-only quiescence test",
    workspaceExternalSource: "read-only-quiescence-test",
    workspaceExternalId: id,
    workspaceName: "Read-only quiescence test",
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
  await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: `send-${id}`,
        delivery: "send",
        text: "run until archived",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );
  const workflowId = `session-${session.id}`;
  const proof = {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    attemptId: crypto.randomUUID(),
    workflowId,
    workflowRunId: crypto.randomUUID(),
    activityId: `dispatch-${crypto.randomUUID()}`,
  };
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId,
    workflowRunId: proof.workflowRunId,
    attemptId: proof.attemptId,
    dispatchId: proof.activityId,
    trigger: { kind: "next" },
  });
  expect(claimed.action).toBe("claimed");
  await withWorkspaceSessionActivityRls(client.db, workspaceId, (db) =>
    db.transaction((tx) =>
      mutateSessionControlInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: `cancel-${id}`,
        action: "cancel",
      }),
    ),
  );
  await settleSessionAttemptInterruptions(client.db, workspaceId, session.id, proof.attemptId);
  expect(await peekSessionWork(client.db, workspaceId, session.id)).toEqual({
    kind: "cancellation-wait",
    attemptId: proof.attemptId,
  });
  if (archive)
    await shared.admin`update sessions
      set content_archive_state = 'archived', content_archive_started_at = now(),
        content_archived_at = now(), content_archive = '{"sha256": "test"}'::jsonb
      where workspace_id = ${workspaceId} and id = ${session.id}`;
  return { grant, workspaceId, session, proof };
}

function activitiesLogging(warnings: string[]) {
  return createSessionStateActivities(
    async () =>
      ({
        db: client.db,
        observability: {
          warn: (message: string) => warnings.push(message),
          error: () => undefined,
        },
      }) as any,
  );
}

test("a late quiescence proof for an archived session fails once, non-retryably, and says why", async () => {
  const { workspaceId, session, proof } = await archivedWhileAwaitingQuiescence();
  expect(await isSessionExecutionReadOnly(client.db, proof)).toBe(true);
  const warnings: string[] = [];
  const activities = activitiesLogging(warnings);

  const failure = await activities.persistSessionAttemptQuiescence(proof).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ApplicationFailure);
  expect(failure).toMatchObject({
    type: SESSION_READ_ONLY_FAILURE_TYPE,
    message: SESSION_READ_ONLY_FAILURE_MESSAGE,
    nonRetryable: true,
  });
  // The database's refusal, not a generic persistence failure, is logged.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("activity=persistSessionAttemptQuiescence");
  expect(warnings[0]).toContain("error=SessionEventPersistenceError");
  expect(warnings[0]).toContain("sqlState=OG002");
  expect(warnings[0]).toContain("reason=SESSION_ARCHIVED_READ_ONLY");
  expect(warnings[0]).toMatch(/functions=refuse_imported_archive_execution:\d+/);

  // The workflow's next peek closes it instead of reconciling the receipt.
  expect(await peekSessionWork(client.db, workspaceId, session.id)).toEqual({ kind: "read-only" });
  expect(
    await activities.peekSessionWork({
      workspaceId,
      sessionId: session.id,
      observerAccountId: proof.accountId,
      includeAdmissionFence: true,
      includeDeletion: true,
    }),
  ).toEqual({ kind: "read-only" });
});

test("the same late proof commits normally while the session is live", async () => {
  const { workspaceId, session, proof } = await archivedWhileAwaitingQuiescence(false);
  expect(await isSessionExecutionReadOnly(client.db, proof)).toBe(false);
  expect(await peekSessionWork(client.db, workspaceId, session.id)).toEqual({
    kind: "cancellation-wait",
    attemptId: proof.attemptId,
  });
  const warnings: string[] = [];
  await expect(
    activitiesLogging(warnings).persistSessionAttemptQuiescence(proof),
  ).resolves.toBeUndefined();
  expect(warnings).toEqual([]);
  expect(await peekSessionWork(client.db, workspaceId, session.id)).not.toMatchObject({
    kind: "cancellation-wait",
  });
});

test("a failure on a live session is rethrown unchanged and keeps retrying", async () => {
  const { proof } = await archivedWhileAwaitingQuiescence(false);
  const warnings: string[] = [];
  const failure = await activitiesLogging(warnings)
    .persistSessionAttemptQuiescence({ ...proof, activityId: "not-the-owner" })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(ApplicationFailure);
  expect(warnings).toEqual([]);
});
