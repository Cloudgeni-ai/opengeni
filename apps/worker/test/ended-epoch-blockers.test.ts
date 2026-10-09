// Regression: a request left open on a box whose lease epoch has ended pinned
// its attempt's quiescence, and with it the session, forever. The box was
// gone, but the cold commit that retired its epoch settled only some blockers,
// and nothing settled rows once the lease had moved on (legacy losses before
// exact loss settlement, or a drain-cold that left them). Lease succession is
// not proof the old box is gone, so settlement needs a terminal observation of
// the exact historical sandbox. Drives
// the real lease/admission/process ledger and the session work claim against
// PostgreSQL.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type Settings } from "@opengeni/config";
import {
  advanceWorkspaceGeneration,
  claimSessionWorkForAttempt,
  confirmDrainCold,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  peekSessionWork,
  readLease,
  reconcileSessionAttemptQuiescence,
  retainWorkspaceMutationProcess,
  listEndedEpochWorkspaceBlockers,
  settleEndedEpochWorkspaceBlockers,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { createProviderCommandRetainer } from "@opengeni/db/retained-provider-commands";
import { createObservability } from "@opengeni/observability";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import {
  createSandboxLeaseActivities,
  type HistoricalModalSandboxLifecycleProbeFn,
} from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";
import { sandboxLeaseHolderIdForAttempt } from "../src/sandbox-resume";

const EPOCH = 41;
const MODAL_PROVIDER_BINDING = {
  key: '{"version":1,"serverUrl":"https://modal.test","workspaceName":"opengeni-test","environment":"test"}',
  binding: {
    version: 1 as const,
    serverUrl: "https://modal.test",
    workspaceName: "opengeni-test",
    environment: "test",
  },
};
const SETTINGS = testSettings({
  sandboxBackend: "modal",
  webSearchEnabled: false,
  sandboxOwnershipEnabled: true,
  sandboxLeaseReaperPeriodMs: 30_000,
});

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-ended-epoch-blockers");
  if (!shared) throw new Error("Real PostgreSQL required for ended-epoch blocker regressions");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function services(settings: Settings = SETTINGS): () => Promise<ActivityServices> {
  return async () => ({
    settings,
    db,
    bus: null as never,
    runtime: null as never,
    objectStorage: null,
    documentServices: null as never,
    observability: createObservability(settings, { component: "worker-test" }),
    wakeSessionWorkflow: null,
  });
}

/** A turn attempt whose worker died on a warm box: one request (and optionally
 * a background command) was left open, the attempt closed without a quiescence
 * receipt and its turn holder was reaped. */
async function deadAttemptFixture(
  options: {
    backend?: "modal" | "selfhosted";
    outcome?: string;
    backgroundCommand?: boolean;
    supervised?: boolean;
  } = {},
) {
  const backend = options.backend ?? "modal";
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('ended-epoch') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ended-epoch')
    returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  const session = await createSession(db, {
    ...ids,
    initialMessage: "run the benchmark",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    ...ids,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, ids.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `ended-epoch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`fixture turn not claimed: ${claim.reason}`);
  const attempt = {
    sessionId: session.id,
    turnId: claim.turn.id,
    executionGeneration: claim.turn.executionGeneration,
    attemptId,
    sandboxGroupId: session.sandboxGroupId,
    holderId: sandboxLeaseHolderIdForAttempt(attemptId),
  };
  const instanceId = `box-${crypto.randomUUID()}`;
  const [lease] = await admin<{ id: string }[]>`
    insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch, resume_backend_id,
      resume_state, expires_at)
    values (${ids.accountId}, ${ids.workspaceId}, ${attempt.sandboxGroupId}, 'warm', 1, 1, 0,
      ${instanceId}, ${backend}, ${EPOCH}, ${backend},
      ${JSON.stringify({
        backendId: backend,
        sessionState: {
          providerState: { sandboxId: instanceId, workspacePersistence: "snapshot_directory" },
        },
      })}::text::jsonb,
      now() + interval '10 minutes')
    returning id`;
  await admin`insert into sandbox_lease_holders
    (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
    values (${ids.accountId}, ${lease!.id}, ${ids.workspaceId}, 'turn', ${attempt.holderId},
      ${attempt.sessionId}, now())`;
  const admit = (operation: string) =>
    advanceWorkspaceGeneration(db, {
      ...ids,
      ...attempt,
      expectedEpoch: EPOCH,
      expectedInstanceId: instanceId,
      operation,
      routeKind: "home",
      routeTargetId: null,
      routeEpoch: 0,
    });
  const processId = crypto.randomUUID();
  if (options.backgroundCommand) {
    const admission = await admit("execCommand");
    const retain = options.supervised
      ? createProviderCommandRetainer(retainWorkspaceMutationProcess, () => null)
      : retainWorkspaceMutationProcess;
    await retain(db, {
      ...ids,
      sessionId: attempt.sessionId,
      processId,
      providerSessionId: 5,
      admissionId: admission.id,
      admittedWorkspaceGeneration: admission.workspaceGeneration,
      operation: "execCommand",
      providerBinding: MODAL_PROVIDER_BINDING,
      backgroundCommand: { commandId: processId, command: "python bench.py" },
      owner: {
        kind: "turn",
        turnId: attempt.turnId,
        executionGeneration: attempt.executionGeneration,
        attemptId: attempt.attemptId,
        holderId: attempt.holderId,
        sandboxGroupId: attempt.sandboxGroupId,
        expectedEpoch: EPOCH,
        expectedInstanceId: instanceId,
        routeKind: "home",
        routeTargetId: null,
        routeEpoch: 0,
      },
      ...(options.supervised
        ? {
            providerCommand: {
              kind: "modal-router-v1",
              sandboxId: instanceId,
              taskId: "task",
              execId: crypto.randomUUID(),
              supervision: {
                protocol: "native-subreaper-v1",
                invocationId: crypto.randomUUID(),
                nonce: "b".repeat(64),
                controlPath: `/tmp/opengeni-supervision/${crypto.randomUUID()}.sock`,
              },
              streams: {
                stdout: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
                stderr: { byteOffset: 0, utf8Remainder: "", eof: false, exitCode: null },
              },
            },
          }
        : {}),
    });
  }
  const request = await admit("execCommand");
  await admin`update session_turn_attempts set state = 'closed',
    outcome = ${options.outcome ?? "lease_lost_recoverable"}, closed_at = now(), quiesced_at = null
    where id = ${attempt.attemptId}`;
  await admin`delete from sandbox_lease_holders where lease_id = ${lease!.id} and kind = 'turn'`;
  await admin`update sandbox_leases set refcount = refcount - 1, turn_holders = 0
    where id = ${lease!.id}`;
  await admin`update session_turns set status = 'completed', finished_at = now(),
    active_attempt_id = null where id = ${attempt.turnId}`;
  await admin`update sessions set status = 'idle', active_turn_id = null
    where id = ${attempt.sessionId}`;
  return {
    ...ids,
    attempt,
    instanceId,
    leaseId: lease!.id,
    sandboxGroupId: attempt.sandboxGroupId,
    processId,
    requestId: request.id,
  };
}

type Fixture = Awaited<ReturnType<typeof deadAttemptFixture>>;

/** The box was lost or stopped and its epoch retired without settling the
 * request (a pre-exact-settlement loss), then the lease re-warmed on a new box. */
async function retireEpochUnsettled(fixture: Fixture) {
  await admin`update sandbox_leases set liveness = 'warm', lease_epoch = ${EPOCH + 2},
    instance_id = ${`box-${crypto.randomUUID()}`}, expires_at = now() + interval '10 minutes'
    where id = ${fixture.leaseId}`;
}

async function requestRow(fixture: Fixture) {
  const [row] = await admin<{ provider_outcome: string | null; settled_at: Date | null }[]>`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where id = ${fixture.requestId}`;
  return row!;
}

async function reconcile(fixture: Fixture) {
  const [dispatch] = await admin<
    {
      temporal_workflow_id: string;
      temporal_workflow_run_id: string;
      temporal_activity_id: string;
    }[]
  >`select temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id
    from session_turn_attempts where id = ${fixture.attempt.attemptId}`;
  return await reconcileSessionAttemptQuiescence(db, {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.attempt.sessionId,
    attemptId: fixture.attempt.attemptId,
    temporalWorkflowId: dispatch!.temporal_workflow_id,
    temporalWorkflowRunId: dispatch!.temporal_workflow_run_id,
    temporalActivityId: dispatch!.temporal_activity_id,
    activitySettled: true,
  });
}

async function ownerWake(fixture: Fixture) {
  const [row] = await admin<{ reason: string }[]>`
    select reason from session_workflow_wake_outbox where session_id = ${fixture.attempt.sessionId}`;
  return row?.reason ?? null;
}

type HistoricalStatus = "terminated" | "running" | "not_found";

function historicalProbe(status: HistoricalStatus, probed: string[] = []) {
  return (async (_settings: Settings, sandboxId: string) => {
    probed.push(sandboxId);
    if (status === "not_found") return { status: "not_found" };
    return {
      status,
      ...(status === "terminated" ? { exitCode: 137 } : {}),
      providerBindingKey: MODAL_PROVIDER_BINDING.key,
      providerBinding: MODAL_PROVIDER_BINDING.binding,
    };
  }) as unknown as HistoricalModalSandboxLifecycleProbeFn;
}

async function runReaper(status: HistoricalStatus, probed: string[] = []) {
  const activities = createSandboxLeaseActivities(services(), {
    sweepModalOrphans: async () => 0,
    inspectOpenSandboxKubernetesInventory: async () => null as never,
    inspectHistoricalModalSandbox: historicalProbe(status, probed),
  });
  await activities.maintainSandboxLeaseSweep({
    examined: 0,
    started: 0,
    alreadyRunning: 0,
    startFailed: 0,
    rotationsRequested: 0,
  });
}

async function listedFor(fixture: Fixture) {
  return (await listEndedEpochWorkspaceBlockers(db)).filter(
    (tuple) => tuple.workspaceId === fixture.workspaceId,
  );
}

describe("blockers on an ended lease epoch", () => {
  test("a request left on a box observed terminated no longer wedges its session", async () => {
    const fixture = await deadAttemptFixture({ outcome: "interrupted_recoverable" });
    await retireEpochUnsettled(fixture);
    // Before: the session waited on this attempt's quiescence forever.
    expect((await reconcile(fixture)).action).toBe("pending");
    expect(await peekSessionWork(db, fixture.workspaceId, fixture.attempt.sessionId)).toMatchObject(
      { kind: "cancellation-wait" },
    );

    const listed = await listedFor(fixture);
    expect(listed).toEqual([
      expect.objectContaining({
        leaseId: fixture.leaseId,
        lostEpoch: EPOCH,
        lostBackend: "modal",
        lostInstanceId: fixture.instanceId,
      }),
    ]);
    expect(await settleEndedEpochWorkspaceBlockers(db, listed[0]!)).toMatchObject({
      admissionsRejected: 1,
      processesLost: 0,
    });
    expect(await requestRow(fixture)).toMatchObject({ provider_outcome: "rejected" });
    expect(await ownerWake(fixture)).toBe("attempt_writer_provider_settled");
    expect((await reconcile(fixture)).action).not.toBe("pending");
    expect(
      await peekSessionWork(db, fixture.workspaceId, fixture.attempt.sessionId),
    ).not.toMatchObject({ kind: "cancellation-wait" });
    expect(await listedFor(fixture)).toEqual([]);
  }, 60_000);

  test("the reaper settles them only after observing the old box terminated", async () => {
    const fixture = await deadAttemptFixture({ outcome: "failed" });
    await retireEpochUnsettled(fixture);
    // Running, or NotFound (deletion or a rotated credential workspace), is
    // no proof the box is gone: the request stays open.
    for (const status of ["running", "not_found"] as const) {
      const probed: string[] = [];
      await runReaper(status, probed);
      expect(probed).toContain(fixture.instanceId);
      expect((await requestRow(fixture)).settled_at).toBeNull();
    }
    await runReaper("terminated");
    expect(await requestRow(fixture)).toMatchObject({ provider_outcome: "rejected" });
    expect(await ownerWake(fixture)).toBe("attempt_writer_provider_settled");
  }, 60_000);

  test("a command left on a retired box stays with retained-process reconciliation", async () => {
    const fixture = await deadAttemptFixture({ backgroundCommand: true });
    await retireEpochUnsettled(fixture);
    expect(await listedFor(fixture)).toEqual([]);
    const listedTuple = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      leaseId: fixture.leaseId,
      sandboxGroupId: fixture.sandboxGroupId,
      lostEpoch: EPOCH,
      lostBackend: "modal",
      lostInstanceId: fixture.instanceId,
    };
    // Even a stale listing is refused under the locks.
    expect(await settleEndedEpochWorkspaceBlockers(db, listedTuple)).toBeNull();
    const [process] = await admin<{ state: string }[]>`
      select state from sandbox_retained_processes where id = ${fixture.processId}`;
    expect(process!.state).toBe("active");
    expect((await requestRow(fixture)).settled_at).toBeNull();
  }, 60_000);

  test("current-epoch and selfhosted blockers are never listed", async () => {
    const current = await deadAttemptFixture();
    const selfhosted = await deadAttemptFixture({ backend: "selfhosted" });
    await retireEpochUnsettled(selfhosted);
    expect(await listedFor(current)).toEqual([]);
    expect(await listedFor(selfhosted)).toEqual([]);
    expect(
      await settleEndedEpochWorkspaceBlockers(db, {
        accountId: current.accountId,
        workspaceId: current.workspaceId,
        leaseId: current.leaseId,
        sandboxGroupId: current.sandboxGroupId,
        lostEpoch: EPOCH,
        lostBackend: "modal",
        lostInstanceId: current.instanceId,
      }),
    ).toBeNull();
    await runReaper("terminated");
    expect((await requestRow(current)).settled_at).toBeNull();
    expect((await requestRow(selfhosted)).settled_at).toBeNull();
  }, 60_000);
});

describe("the drain's cold commit", () => {
  /** Drained around a request the capture gate let through (here a turn
   * request the gate does not classify as a crashed worker's orphan). */
  async function drainingAround(fixture: Fixture) {
    await admin`update sandbox_leases set liveness = 'draining',
      expires_at = now() - interval '1 second' where id = ${fixture.leaseId}`;
    expect(await readLease(db, fixture.workspaceId, fixture.sandboxGroupId)).toMatchObject({
      liveness: "draining",
      refcount: 0,
    });
  }

  test("a stopped box settles every open request it leaves, not only orphans", async () => {
    const fixture = await deadAttemptFixture({ outcome: "interrupted_recoverable" });
    await drainingAround(fixture);
    const cold = await confirmDrainCold(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
      expectedEpoch: EPOCH,
      providerStopped: true,
    });
    expect(cold.wentCold).toBe(true);
    // Before: the epoch was retired with the request still open.
    expect(await requestRow(fixture)).toMatchObject({ provider_outcome: "rejected" });
    expect(await ownerWake(fixture)).toBe("attempt_writer_provider_settled");
    expect((await reconcile(fixture)).action).not.toBe("pending");
  }, 60_000);

  test("a box that was not stopped keeps its requests", async () => {
    const fixture = await deadAttemptFixture({ outcome: "interrupted_recoverable" });
    await drainingAround(fixture);
    const cold = await confirmDrainCold(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
      expectedEpoch: EPOCH,
      providerStopped: false,
    });
    expect(cold.wentCold).toBe(true);
    expect((await requestRow(fixture)).settled_at).toBeNull();
  }, 60_000);
});
