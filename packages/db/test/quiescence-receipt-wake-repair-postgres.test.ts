import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  markSessionAttemptQuiesced,
  repairMissingQuiescenceReceiptWakes,
  requestSessionTurnRecovery,
  mutateSessionControlInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("quiescence-receipt-wake-repair");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

/** A recovering session whose interrupted attempt closed `closedSecondsAgo`
 * and whose last workflow wake was delivered `wakeDeliveredSecondsAgo`. */
async function strandedRecovery(input: {
  closedSecondsAgo: number;
  wakeDeliveredSecondsAgo: number;
  quiesce?: boolean;
}) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Quiescence repair",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Quiescence repair",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
    initialMessage: "root",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
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
  if (claimed.action !== "claimed") throw new Error(`could not claim fixture: ${claimed.reason}`);
  const recovery = await requestSessionTurnRecovery(client.db, workspaceId, {
    sessionId: session.id,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId,
    reason: "worker_shutdown",
  });
  expect(recovery.action).toBe("recovering");
  if (input.quiesce) {
    await markSessionAttemptQuiesced(client.db, {
      workspaceId,
      sessionId: session.id,
      attemptId,
      temporalWorkflowId: `session-${session.id}`,
    });
  }
  // The closing activity died before its receipt; every wake it produced was
  // already delivered to a workflow run that has since closed.
  await shared.admin`
    update session_turn_attempts
    set closed_at = closed_at - make_interval(secs => ${input.closedSecondsAgo})
    where id = ${attemptId}
  `;
  await shared.admin`
    update session_workflow_wake_outbox
    set delivered_revision = wake_revision,
      updated_at = now() - make_interval(secs => ${input.wakeDeliveredSecondsAgo})
    where session_id = ${session.id}
  `;
  return {
    accountId: grant.accountId,
    subjectId: grant.subjectId,
    workspaceId,
    sessionId: session.id,
    attemptId,
  };
}

async function wakeOf(sessionId: string) {
  const [row] = await shared.admin<
    { wake_revision: string; delivered_revision: string; reason: string }[]
  >`
    select wake_revision::text, delivered_revision::text, reason
    from session_workflow_wake_outbox where session_id = ${sessionId}
  `;
  return {
    pending: Number(row!.wake_revision) > Number(row!.delivered_revision),
    reason: row!.reason,
  };
}

async function repairAll() {
  let cursor = null;
  do {
    const lap = await repairMissingQuiescenceReceiptWakes(client.db, 100, cursor);
    expect(lap.failed).toBe(0);
    cursor = lap.cursor;
  } while (cursor);
}

describe("missing quiescence-receipt wake repair", () => {
  test("a stranded interrupted attempt gets one wake, then is paced", async () => {
    const stranded = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 1_200,
    });
    expect((await wakeOf(stranded.sessionId)).pending).toBe(false);

    await repairAll();
    expect(await wakeOf(stranded.sessionId)).toEqual({
      pending: true,
      reason: "attempt_quiescence_repair",
    });

    // Delivered just now: the next lap does not wake it again.
    await shared.admin`
      update session_workflow_wake_outbox
      set delivered_revision = wake_revision, updated_at = now()
      where session_id = ${stranded.sessionId}
    `;
    await repairAll();
    expect((await wakeOf(stranded.sessionId)).pending).toBe(false);

    // Still stranded ten minutes later: wake again.
    await shared.admin`
      update session_workflow_wake_outbox
      set updated_at = now() - interval '11 minutes'
      where session_id = ${stranded.sessionId}
    `;
    await repairAll();
    expect((await wakeOf(stranded.sessionId)).pending).toBe(true);
  });

  test("the closing activity's own receipt window is not preempted", async () => {
    const fresh = await strandedRecovery({ closedSecondsAgo: 0, wakeDeliveredSecondsAgo: 1_200 });
    await repairAll();
    expect((await wakeOf(fresh.sessionId)).pending).toBe(false);
  });

  test("a quiesced active recovery is rediscovered, but a recent wake is paced", async () => {
    const quiesced = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 1_200,
      quiesce: true,
    });
    const recentlyWoken = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 60,
    });
    // Historical projection drift must not hide the logical turn from the
    // bounded inventory; actual admission still owns whether it can execute.
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update sessions set status = 'idle' where id = ${quiesced.sessionId}`;
    });
    await repairAll();
    expect(await wakeOf(quiesced.sessionId)).toEqual({
      pending: true,
      reason: "turn_recovery_repair",
    });
    expect((await wakeOf(recentlyWoken.sessionId)).pending).toBe(false);
  });

  test("a durable receipt does not turn intentional Pause into abandoned work", async () => {
    const paused = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 1_200,
      quiesce: true,
    });
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      paused.workspaceId,
      paused.subjectId,
      (db) =>
        mutateSessionControlInTransaction(db, {
          accountId: paused.accountId,
          workspaceId: paused.workspaceId,
          sessionId: paused.sessionId,
          operationKey: crypto.randomUUID(),
          action: "pause",
          actor: { type: "human", subjectId: paused.subjectId },
        }),
    );
    await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision,
      updated_at = now() - interval '20 minutes' where session_id = ${paused.sessionId}`;
    await repairAll();
    expect((await wakeOf(paused.sessionId)).pending).toBe(false);
    const [turn] =
      await shared.admin`select status from session_turns where session_id = ${paused.sessionId}`;
    expect(turn!.status).toBe("recovering");
  });

  test("the inventory is the dispatcher's private capability", async () => {
    const [posture] = await shared.admin<
      { same_owner: boolean; definer: boolean; public_execute: boolean }[]
    >`
      select repair.proowner = dispatcher.proowner as same_owner,
        repair.prosecdef as definer,
        has_function_privilege('public', repair.oid, 'EXECUTE') as public_execute
      from pg_proc repair, pg_proc dispatcher
      where repair.oid = 'opengeni_private.list_quiescence_receipt_wake_repairs_v1(integer,uuid,uuid)'::regprocedure
        and dispatcher.oid = 'opengeni_private.claim_session_workflow_wakes(integer)'::regprocedure
    `;
    expect(posture).toEqual({ same_owner: true, definer: true, public_execute: false });
  });
});
