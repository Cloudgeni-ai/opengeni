import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionAttemptActivityRef,
  initializeSessionStartAtomically,
  markSessionAttemptQuiesced,
  mutateWorkspaceControlInTransaction,
  peekSessionWork,
  reconcileSessionAttemptQuiescence,
  repairMissingQuiescenceReceiptWakes,
  requestSessionTurnRecovery,
  mutateSessionControlInTransaction,
  withWorkspaceRls,
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

/** Whether the deployment-wide inventory currently discovers this session. */
async function discovered(sessionId: string) {
  let after: { workspaceId: string; sessionId: string } | null = null;
  for (;;) {
    const rows: { workspace_id: string; session_id: string }[] = await shared.admin`
      select workspace_id::text, session_id::text
      from opengeni_private.list_quiescence_receipt_wake_repairs_v1(
        100, ${after?.workspaceId ?? null}::uuid, ${after?.sessionId ?? null}::uuid)
    `;
    if (rows.some((row) => row.session_id === sessionId)) return true;
    if (rows.length < 100) return false;
    const last = rows.at(-1)!;
    after = { workspaceId: last.workspace_id, sessionId: last.session_id };
  }
}

async function ageDeliveredWake(sessionId: string) {
  await shared.admin`update session_workflow_wake_outbox set delivered_revision = wake_revision,
    updated_at = now() - interval '20 minutes' where session_id = ${sessionId}`;
}

async function sessionControl(
  target: { accountId: string; workspaceId: string; subjectId: string; sessionId: string },
  action: "pause" | "resume",
) {
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    target.workspaceId,
    target.subjectId,
    (db) =>
      mutateSessionControlInTransaction(db, {
        accountId: target.accountId,
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        operationKey: crypto.randomUUID(),
        action,
        actor: { type: "human", subjectId: target.subjectId },
      }),
  );
}

/** Pause has parked the quiesced turn exactly as the workflow does: idle
 * projection, same `recovering` logical turn and active-turn pointer. */
async function parkedUnderPause() {
  const parked = await strandedRecovery({
    closedSecondsAgo: 300,
    wakeDeliveredSecondsAgo: 1_200,
    quiesce: true,
  });
  await sessionControl(parked, "pause");
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set status = 'idle' where id = ${parked.sessionId}`;
  });
  await ageDeliveredWake(parked.sessionId);
  return parked;
}

async function statusOf(sessionId: string) {
  const [row] = await shared.admin<{ session_status: string; turn_status: string }[]>`
    select session.status as session_status, turn.status as turn_status
    from sessions session
    join session_turns turn on turn.id = session.active_turn_id
    where session.id = ${sessionId}
  `;
  return row;
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

  test("a paused stale recovering projection is parked once, then left for Resume", async () => {
    const paused = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 1_200,
      quiesce: true,
    });
    await sessionControl(paused, "pause");
    await ageDeliveredWake(paused.sessionId);
    expect(await statusOf(paused.sessionId)).toEqual({
      session_status: "recovering",
      turn_status: "recovering",
    });
    // The receipt is durable but the projection still says `recovering`: the
    // wake routes the turn through DB-only projection settlement, not admission.
    expect(await discovered(paused.sessionId)).toBe(true);
    await repairAll();
    expect(await wakeOf(paused.sessionId)).toEqual({
      pending: true,
      reason: "turn_recovery_repair",
    });
    const peek = await peekSessionWork(client.db, paused.workspaceId, paused.sessionId);
    expect(peek).toEqual({ kind: "cancellation-wait", attemptId: paused.attemptId });
    const workflowId = `session-${paused.sessionId}`;
    const ref = await getSessionAttemptActivityRef(client.db, {
      accountId: paused.accountId,
      workspaceId: paused.workspaceId,
      sessionId: paused.sessionId,
      attemptId: paused.attemptId,
      temporalWorkflowId: workflowId,
    });
    expect(ref?.quiesced).toBe(true);
    const parked = await reconcileSessionAttemptQuiescence(client.db, {
      accountId: paused.accountId,
      workspaceId: paused.workspaceId,
      sessionId: paused.sessionId,
      attemptId: paused.attemptId,
      temporalWorkflowId: workflowId,
      temporalWorkflowRunId: ref!.workflowRunId,
      temporalActivityId: ref!.activityId,
      activitySettled: true,
    });
    expect(parked.action).toBe("quiesced");
    // Pause preserves the logical turn; only the projection parked.
    expect(await statusOf(paused.sessionId)).toEqual({
      session_status: "idle",
      turn_status: "recovering",
    });
    await ageDeliveredWake(paused.sessionId);
    expect(await discovered(paused.sessionId)).toBe(false);
    await repairAll();
    expect((await wakeOf(paused.sessionId)).pending).toBe(false);
  });

  test("Pause-parked turns leave discovery and return after Resume", async () => {
    const parked = await parkedUnderPause();
    expect(await discovered(parked.sessionId)).toBe(false);
    await repairAll();
    expect((await wakeOf(parked.sessionId)).pending).toBe(false);
    expect(await statusOf(parked.sessionId)).toEqual({
      session_status: "idle",
      turn_status: "recovering",
    });

    // Resume commits its own wake for the preserved turn.
    await sessionControl(parked, "resume");
    expect((await wakeOf(parked.sessionId)).pending).toBe(true);
    expect((await peekSessionWork(client.db, parked.workspaceId, parked.sessionId)).kind).toBe(
      "runnable",
    );
    // If that wake is delivered but lost, ordinary rediscovery repairs it.
    await ageDeliveredWake(parked.sessionId);
    expect(await discovered(parked.sessionId)).toBe(true);
    await repairAll();
    expect(await wakeOf(parked.sessionId)).toEqual({
      pending: true,
      reason: "turn_recovery_repair",
    });
  });

  test("ancestor and workspace Pause park descendants with the override algebra", async () => {
    const child = await parkedUnderPause();
    // Selected Resume on the child advances its subtree override.
    await sessionControl(child, "resume");
    await ageDeliveredWake(child.sessionId);
    const parent = await createSession(client.db, {
      accountId: child.accountId,
      workspaceId: child.workspaceId,
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
      initialMessage: "parent",
    });
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update sessions set parent_session_id = ${parent.id}, root_session_id = ${parent.id}
        where id = ${child.sessionId}`;
    });
    expect(await discovered(child.sessionId)).toBe(true);
    // A newer ancestor Pause is not defeated by the child's older override.
    await sessionControl({ ...child, sessionId: parent.id }, "pause");
    await ageDeliveredWake(child.sessionId);
    expect(await discovered(child.sessionId)).toBe(false);
    await sessionControl({ ...child, sessionId: parent.id }, "resume");
    await ageDeliveredWake(child.sessionId);
    expect(await discovered(child.sessionId)).toBe(true);

    await withWorkspaceRls(client.db, child.workspaceId, (db) =>
      db.transaction((tx) =>
        mutateWorkspaceControlInTransaction(tx as unknown as typeof db, {
          accountId: child.accountId,
          workspaceId: child.workspaceId,
          actor: { type: "human", subjectId: child.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
        }),
      ),
    );
    await ageDeliveredWake(child.sessionId);
    expect(await discovered(child.sessionId)).toBe(false);
  });

  test("admission blocks and sandbox setup markers are durable waits, not lost wakes", async () => {
    const blocked = await strandedRecovery({
      closedSecondsAgo: 300,
      wakeDeliveredSecondsAgo: 1_200,
      quiesce: true,
    });
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update sessions set status = 'requires_action', admission_block = ${tx.json({
        reason: "database_claim_rejected",
        sqlState: null,
        retryPolicy: "explicit_recheck",
        blockedAt: new Date().toISOString(),
        attemptId: crypto.randomUUID(),
        fence: { lastSequence: 1, controlVersion: 1 },
        previousStatus: "recovering",
      })} where id = ${blocked.sessionId}`;
    });
    expect(await discovered(blocked.sessionId)).toBe(false);

    const markers = {
      sandboxSetupOutcomeUnknown: (turnId: string, attemptId: string) => ({
        version: 1,
        turnId,
        attemptId,
        reason: "sandbox_command_start_outcome_unknown",
      }),
      sandboxSetupRecoveryExhausted: (turnId: string, attemptId: string) => ({
        version: 1,
        turnId,
        attemptId,
        reason: "sandbox_command_start_recovery_exhausted",
        setupOutcome: "not_started",
        providerRecoveryCount: 5,
      }),
    };
    for (const [key, marker] of Object.entries(markers)) {
      const waiting = await strandedRecovery({
        closedSecondsAgo: 300,
        wakeDeliveredSecondsAgo: 1_200,
        quiesce: true,
      });
      const [turn] = await shared.admin<{ id: string }[]>`
        select active_turn_id::text as id from sessions where id = ${waiting.sessionId}`;
      await shared.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update session_turns
          set metadata = coalesce(metadata, '{}'::jsonb) || ${tx.json({
            [key]: marker(turn!.id, waiting.attemptId),
          })}
          where id = ${turn!.id}`;
      });
      expect((await peekSessionWork(client.db, waiting.workspaceId, waiting.sessionId)).kind).toBe(
        "admission-blocked",
      );
      expect(await discovered(waiting.sessionId)).toBe(false);
      // A malformed marker does not block admission, so it stays discoverable.
      await shared.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update session_turns set metadata = jsonb_set(metadata, ${[key, "attemptId"]}::text[], '""')
          where id = ${turn!.id}`;
      });
      expect((await peekSessionWork(client.db, waiting.workspaceId, waiting.sessionId)).kind).toBe(
        "runnable",
      );
      expect(await discovered(waiting.sessionId)).toBe(true);
    }
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
