// Regression: a worker closed its attempt through a worker-shutdown recovery
// and then crashed before its writer drain settled the attempt's owned-box
// setup request. The request stayed open with no holder and no retained process
// on a box that stays warm, so the closed attempt never quiesced and the
// session never claimed its pending input. Real PostgreSQL ledger; Temporal's
// activity proof is the `activitySettled` input of the reconcile seam, and the
// worker's process-exit deadline is `workerProcessExitDeadlineMs`.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  advanceWorkspaceGeneration,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionTurn,
  initializeSessionStartAtomically,
  mutateSessionControlInTransaction,
  peekSessionWork,
  reconcileSessionAttemptQuiescence,
  requestSessionTurnRecovery,
  settleSessionAttemptInterruptions,
  steerQueuedTurnInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
import { crashedWorkerOrphanAdmissionSql } from "../src/session-attempt-writers";

setDefaultTimeout(30_000);

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("crashed-worker-setup-admission");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Grant = { accountId: string; workspaceId: string; subjectId: string };

async function send(
  grant: Grant,
  sessionId: string,
  text: string,
  requested: "send" | "steer" | "steer_now" = "send",
) {
  const delivery = requested === "steer_now" ? "send" : requested;
  const accepted = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: `${delivery}-${crypto.randomUUID()}`,
          delivery,
          text,
          resources: [],
          reasoningEffortFallback: "low",
          source: "user",
        }),
      ),
  );
  if (requested === "steer_now") {
    const queued = await getSessionTurn(client.db, grant.workspaceId, accepted.turnId);
    if (!queued) throw new Error(`Accepted turn missing: ${accepted.turnId}`);
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
      db.transaction((tx) =>
        steerQueuedTurnInTransaction(tx as unknown as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          turnId: queued.id,
          expectedTurnVersion: queued.version,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: `steer-now-${crypto.randomUUID()}`,
          interrupt: true,
        }),
      ),
    );
  }
  return accepted;
}

async function controlSession(grant: Grant, sessionId: string, action: "pause" | "cancel") {
  await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
    db.transaction((tx) =>
      mutateSessionControlInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        action,
      }),
    ),
  );
}

type Closure =
  | "worker_shutdown"
  | "deadline_rotation"
  | "setup_outcome_unknown"
  | "failed"
  | "pause"
  | "steer"
  | "cancel";

// The default turn worker process-exit deadline (force time plus margin).
const EXIT_DEADLINE_MS = 115_000;

/** A turn attempt on a warm compute box started owned-box setup, its attempt
 * was closed by `closure` `closedAgoMs` ago (default: past the exit deadline),
 * and (unless `keepHolder`) its holder is gone. Nothing settled the request. */
async function closedSetupAttempt(
  options: {
    closure?: Closure;
    keepHolder?: boolean;
    operation?: string;
    /** How long before reconciliation the attempt closed. */
    closedAgoMs?: number;
  } = {},
) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Crashed setup",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Crashed setup",
    subjectId: `subject-${suffix}`,
  });
  const access0 = access.workspaceGrants[0]!;
  const grant: Grant = {
    accountId: access0.accountId,
    workspaceId: access0.workspaceId!,
    subjectId: access0.subjectId,
  };
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "set up the repository",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const workflowId = `session-${session.id}`;
  const workflowRunId = crypto.randomUUID();
  const dispatchId = `dispatch-${crypto.randomUUID()}`;
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId,
    workflowRunId,
    attemptId,
    dispatchId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`fixture turn not claimed: ${claim.reason}`);
  const holderId = `turn-attempt:${attemptId}`;
  const instanceId = `compute-${crypto.randomUUID()}`;
  const [lease] = await shared.admin<{ id: string }[]>`
    insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch, resume_backend_id,
      resume_state, expires_at)
    values (${grant.accountId}, ${grant.workspaceId}, ${session.sandboxGroupId}, 'warm', 1, 1, 0,
      ${instanceId}, 'compute', 1, 'compute',
      ${JSON.stringify({ backendId: "compute", sessionState: { providerState: { sandboxId: instanceId } } })}::text::jsonb,
      now() + interval '10 minutes')
    returning id`;
  await shared.admin`insert into sandbox_lease_holders
    (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
    values (${grant.accountId}, ${lease!.id}, ${grant.workspaceId}, 'turn', ${holderId},
      ${session.id}, now())`;
  const setup = await advanceWorkspaceGeneration(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    executionGeneration: claim.turn.executionGeneration,
    attemptId,
    holderId,
    sandboxGroupId: session.sandboxGroupId,
    expectedEpoch: 1,
    expectedInstanceId: instanceId,
    operation: options.operation ?? "lazyOwnedSandboxSetup",
    routeKind: "home",
    routeTargetId: null,
    routeEpoch: 0,
  });

  const closure = options.closure ?? "worker_shutdown";
  if (closure === "pause" || closure === "steer" || closure === "cancel") {
    if (closure === "steer") await send(grant, session.id, "do this instead", "steer_now");
    else await controlSession(grant, session.id, closure);
    await settleSessionAttemptInterruptions(client.db, grant.workspaceId, session.id, attemptId);
  } else {
    const recovery = await requestSessionTurnRecovery(client.db, grant.workspaceId, {
      sessionId: session.id,
      turnId: claim.turn.id,
      triggerEventId: claim.turn.triggerEventId,
      attemptId,
      reason:
        closure === "setup_outcome_unknown"
          ? "sandbox_command_start_outcome_unknown"
          : closure === "deadline_rotation"
            ? "sandbox_deadline_rotation"
            : "worker_shutdown",
      ...(closure === "setup_outcome_unknown" ? { sandboxSetupOutcomeUnknown: true as const } : {}),
    });
    expect(recovery.action).toBe("recovering");
    // A terminal failure on the same closed shape.
    if (closure === "failed")
      await shared.admin`update session_turn_attempts set outcome = 'failed'
        where id = ${attemptId}`;
  }
  const closedAgoMs = options.closedAgoMs ?? EXIT_DEADLINE_MS + 5_000;
  await shared.admin`update session_turn_attempts
    set closed_at = now() - (${closedAgoMs}::integer * interval '1 millisecond')
    where id = ${attemptId}`;
  if (!options.keepHolder) {
    // The reaper removes a closed attempt's turn holder.
    await shared.admin`delete from sandbox_lease_holders
      where lease_id = ${lease!.id} and holder_id = ${holderId}`;
    await shared.admin`update sandbox_leases set refcount = 0, turn_holders = 0
      where id = ${lease!.id}`;
  }
  /** `exitDeadlineMs: null` omits the deadline input. */
  const reconcile = (activitySettled: boolean, exitDeadlineMs: number | null = EXIT_DEADLINE_MS) =>
    reconcileSessionAttemptQuiescence(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      attemptId,
      temporalWorkflowId: workflowId,
      temporalWorkflowRunId: workflowRunId,
      temporalActivityId: dispatchId,
      activitySettled,
      ...(exitDeadlineMs === null ? {} : { workerProcessExitDeadlineMs: exitDeadlineMs }),
    });
  return { grant, sessionId: session.id, attemptId, workflowId, setupId: setup.id, reconcile };
}

async function admission(id: string) {
  const [row] = await shared.admin<{ provider_outcome: string | null; settled: boolean }[]>`
    select provider_outcome, settled_at is not null as settled
    from sandbox_workspace_mutation_admissions where id = ${id}`;
  return row!;
}

async function quiesced(attemptId: string) {
  const [row] = await shared.admin<{ quiesced: boolean }[]>`
    select quiesced_at is not null as quiesced from session_turn_attempts where id = ${attemptId}`;
  return row!.quiesced;
}

async function expectPending(fixture: Awaited<ReturnType<typeof closedSetupAttempt>>) {
  expect(await fixture.reconcile(true)).toEqual({ action: "pending", events: [] });
  expect(await admission(fixture.setupId)).toEqual({ provider_outcome: null, settled: false });
  expect(await quiesced(fixture.attemptId)).toBe(false);
}

describe("owned-box setup left by a crashed worker", () => {
  test("is settled after a worker-shutdown closure's exit deadline, and the session claims its steer", async () => {
    const crashed = await closedSetupAttempt();
    const steer = await send(crashed.grant, crashed.sessionId, "check the build", "steer");

    // The production shape: every wake routes the attempt to quiescence.
    expect(await peekSessionWork(client.db, crashed.grant.workspaceId, crashed.sessionId)).toEqual({
      kind: "cancellation-wait",
      attemptId: crashed.attemptId,
    });
    // Without Temporal's proof nothing changes.
    expect(await crashed.reconcile(false)).toEqual({ action: "pending", events: [] });
    expect(await admission(crashed.setupId)).toEqual({ provider_outcome: null, settled: false });

    const recovered = await crashed.reconcile(true);
    expect(recovered.action).toBe("quiesced");
    expect(await admission(crashed.setupId)).toEqual({
      provider_outcome: "rejected",
      settled: true,
    });
    expect(await quiesced(crashed.attemptId)).toBe(true);
    expect(
      (await peekSessionWork(client.db, crashed.grant.workspaceId, crashed.sessionId)).kind,
    ).toBe("runnable");

    const next = await claimSessionWorkForAttempt(client.db, crashed.grant.workspaceId, {
      sessionId: crashed.sessionId,
      workflowId: crashed.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    expect(next.action).toBe("claimed");
    if (next.action !== "claimed") return;
    expect(next.turn.id).toBe(steer.turnId);
    expect(next.turn.status).toBe("running");
  });

  test("a worker-shutdown closure inside the exit deadline keeps its gate (the worker may still run)", async () => {
    await expectPending(await closedSetupAttempt({ closedAgoMs: 5_000 }));
  });

  test("without the exit deadline a worker-shutdown closure keeps its gate", async () => {
    const crashed = await closedSetupAttempt();
    expect(await crashed.reconcile(true, null)).toEqual({ action: "pending", events: [] });
    expect(await admission(crashed.setupId)).toEqual({ provider_outcome: null, settled: false });
  });

  test("a holder that still exists keeps the request open", async () => {
    await expectPending(await closedSetupAttempt({ keepHolder: true }));
  });

  test("the plain crashed-worker predicate for drains and containment is unchanged", async () => {
    const crashed = await closedSetupAttempt();
    const [row] = await withWorkspaceRls(client.db, crashed.grant.workspaceId, (db) =>
      db.execute<{ orphan: boolean }>(sql`
        select ${crashedWorkerOrphanAdmissionSql(sql`admission`)} as orphan
        from sandbox_workspace_mutation_admissions admission
        where admission.id = ${crashed.setupId}`),
    );
    expect(row).toEqual({ orphan: false });
  });

  for (const closure of ["pause", "steer", "cancel", "failed", "deadline_rotation"] as const) {
    test(`a ${closure} closure keeps today's protection`, async () => {
      await expectPending(await closedSetupAttempt({ closure }));
    });
  }

  test("a setup whose Start outcome is recorded unknown still waits for the box to be gone", async () => {
    await expectPending(await closedSetupAttempt({ closure: "setup_outcome_unknown" }));
  });

  test("a model command the crashed worker started is not settled on a live box", async () => {
    await expectPending(await closedSetupAttempt({ operation: "execCommand" }));
  });
});
