// Idle command containment: legacy retained background commands must not hold a
// Modal box warm until its provider deadline. Drives the real reaper activities
// (prepare sweep -> drain -> confirm cold) and the real lease/process/command
// ledger against PostgreSQL; only the provider snapshot + stop is spied.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  acquireLease,
  advanceWorkspaceGeneration,
  claimSessionWorkForAttempt,
  confirmDrainCold,
  createDb,
  createSession,
  enrollRetainedCommandContainment,
  reconcileSessionAttemptQuiescence,
  peekSessionWork,
  getRetainedProcess,
  initializeSessionStartAtomically,
  markWarmLeaseInstanceLost,
  readLease,
  reapStaleLeaseHoldersGlobal,
  releaseLeaseHolder,
  retainedProcessSettlementIdentity,
  retainWorkspaceMutationProcess,
  SandboxWorkspaceMutationFencedError,
  settleRetainedProcess,
  type CommandContainmentInspection,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { createProviderCommandRetainer } from "@opengeni/db/retained-provider-commands";
import { createObservability, type Observability } from "@opengeni/observability";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import { createSandboxLeaseActivities, type TerminateBoxFn } from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";
import { sandboxLeaseHolderIdForAttempt } from "../src/sandbox-resume";

const WINDOW_MS = 30 * 60_000;
const EPOCH = 12;
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
  sandboxViewerHolderTtlMs: 90_000,
  sandboxIdleGraceMs: 15 * 60_000,
  sandboxIdleCommandContainmentMs: WINDOW_MS,
  sandboxLeaseReaperPeriodMs: 30_000,
});

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-idle-command-containment");
  if (!shared) throw new Error("Real PostgreSQL required for idle command containment");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

function services(
  observability: Observability = createObservability(SETTINGS, { component: "worker-test" }),
): () => Promise<ActivityServices> {
  return async () => ({
    settings: SETTINGS,
    db,
    bus: null as never,
    runtime: null as never,
    objectStorage: null,
    documentServices: null as never,
    observability,
    wakeSessionWorkflow: null,
  });
}

function archiveDescriptor(archive: string) {
  const bytes = Buffer.from(archive, "base64");
  const archiveSha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return {
    version: 1 as const,
    revision: `wa1:1900000000000:${archiveSha256}`,
    archiveSha256,
    archiveBytes: bytes.length,
    capturedAt: new Date(1_900_000_000_000).toISOString(),
    workspace: {
      algorithm: "sha256" as const,
      sha256: archiveSha256,
      entryCount: 1,
      fileCount: 1,
      totalFileBytes: bytes.length,
    },
  };
}

/** Provider seam spy: verified capture through the real publication CAS, then
 * "stop". The order is the production one: persist before terminate. */
function terminateSpy() {
  const persisted: boolean[] = [];
  const fn: TerminateBoxFn = async (_settings, _lease, _observability, persistArchive) => {
    const archive = Buffer.from("IDLE_CONTAINMENT_ARCHIVE").toString("base64");
    const { wrote } = await persistArchive(archive, archiveDescriptor(archive));
    persisted.push(wrote);
    return wrote;
  };
  return { fn, persisted };
}

type Fixture = Awaited<ReturnType<typeof idleFixture>>;

async function startAttempt(
  ids: { accountId: string; workspaceId: string },
  sandboxGroupId: string | undefined,
  parentSessionId?: string,
) {
  const session = await createSession(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    initialMessage: "run the dev server",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    ...(sandboxGroupId ? { sandboxGroupId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
  });
  await initializeSessionStartAtomically(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
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
    dispatchId: `containment-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`fixture turn not claimed: ${claim.reason}`);
  return {
    sessionId: session.id,
    turnId: claim.turn.id,
    executionGeneration: claim.turn.executionGeneration,
    attemptId,
    sandboxGroupId: session.sandboxGroupId,
    holderId: sandboxLeaseHolderIdForAttempt(attemptId),
  };
}

async function insertTurnHolder(
  fixture: { accountId: string; workspaceId: string; leaseId: string },
  attempt: { holderId: string; sessionId: string },
) {
  await admin`insert into sandbox_lease_holders
    (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
    values (${fixture.accountId}, ${fixture.leaseId}, ${fixture.workspaceId}, 'turn',
      ${attempt.holderId}, ${attempt.sessionId}, now())`;
  await admin`update sandbox_leases set refcount = refcount + 1, turn_holders = turn_holders + 1
    where id = ${fixture.leaseId}`;
}

/** Ordinary turn settlement as the durable rows record it: attempt closed,
 * turn finished, session back to idle. */
async function finishTurn(
  attempt: { attemptId: string; turnId: string; sessionId: string },
  outcome: "completed" | "cancelled" = "completed",
) {
  await admin`update session_turn_attempts set state = 'closed', outcome = ${outcome},
    closed_at = now(),
    quiesced_at = case when ${outcome} = 'completed' then now() else null end
    where id = ${attempt.attemptId}`;
  await admin`update session_turns set status = ${outcome}, finished_at = now(),
    active_attempt_id = null where id = ${attempt.turnId}`;
  await admin`update sessions set status = 'idle', active_turn_id = null
    where id = ${attempt.sessionId} and active_turn_id = ${attempt.turnId}`;
}

/** One singleton sandbox group whose completed turn left a legacy background
 * command running (e.g. a dev server) under a non-expiring process holder. */
async function idleFixture(options: { outcome?: string; reconcileAttempts?: number } = {}) {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('containment') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'containment') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  const attempt = await startAttempt(ids, undefined);
  const instanceId = `box-${crypto.randomUUID()}`;
  const [lease] = await admin<{ id: string }[]>`
    insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch, resume_backend_id,
      resume_state, expires_at)
    values (${ids.accountId}, ${ids.workspaceId}, ${attempt.sandboxGroupId}, 'warm', 0, 0, 0,
      ${instanceId}, 'modal', ${EPOCH}, 'modal',
      ${JSON.stringify({ backendId: "modal", sessionState: { providerState: { sandboxId: instanceId } } })}::text::jsonb,
      now() + interval '10 minutes')
    returning id`;
  const fixture = {
    ...ids,
    attempt,
    leaseId: lease!.id,
    instanceId,
    sandboxGroupId: attempt.sandboxGroupId,
    processId: crypto.randomUUID(),
    command: "bun run dev --port 3000",
  };
  await insertTurnHolder(fixture, attempt);
  const admission = await advanceWorkspaceGeneration(db, {
    ...ids,
    ...attempt,
    expectedEpoch: EPOCH,
    expectedInstanceId: instanceId,
    operation: "exec_command",
    routeKind: "home",
    routeTargetId: null,
    routeEpoch: 0,
  });
  await retainWorkspaceMutationProcess(db, {
    ...ids,
    sessionId: attempt.sessionId,
    processId: fixture.processId,
    providerSessionId: 7,
    admissionId: admission.id,
    admittedWorkspaceGeneration: admission.workspaceGeneration,
    operation: "exec_command",
    providerBinding: MODAL_PROVIDER_BINDING,
    backgroundCommand: { commandId: fixture.processId, command: fixture.command },
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
  });
  // Healthy (or repeatedly erroring) observation; no stop intent anywhere.
  await admin`update sandbox_retained_processes set
    last_reconcile_outcome = ${options.outcome ?? "provider_running"},
    reconcile_attempts = ${options.reconcileAttempts ?? 3}
    where id = ${fixture.processId}`;
  // Ordinary turn finalization: writers quiesced, turn holder released, attempt
  // closed. The adopted command keeps its own process holder and parent
  // admission, so the box stays warm.
  await releaseLeaseHolder(db, {
    ...ids,
    sandboxGroupId: attempt.sandboxGroupId,
    kind: "turn",
    holderId: attempt.holderId,
    idleGraceMs: SETTINGS.sandboxIdleGraceMs,
    workspaceWritersQuiesced: true,
  });
  await finishTurn(attempt);
  return { ...fixture, admission };
}

/** Move every durable idleness fact of the fixture's group back in time. */
async function idleFor(fixture: Fixture, minutes: number) {
  const ago = `${minutes} minutes`;
  await admin`update session_turns set finished_at = now() - ${ago}::interval
    where workspace_id = ${fixture.workspaceId} and finished_at is not null`;
  await admin`update session_turn_attempts set closed_at = now() - ${ago}::interval,
    updated_at = now() - ${ago}::interval,
    quiesced_at = case when quiesced_at is null then null else now() - ${ago}::interval end
    where workspace_id = ${fixture.workspaceId} and state = 'closed'`;
  await admin`update sandbox_workspace_mutation_admissions
    set admitted_at = now() - ${ago}::interval,
      settled_at = case when settled_at is null then null else now() - ${ago}::interval end
    where lease_id = ${fixture.leaseId} and not exists (
      select 1 from sandbox_retained_processes supervised
      where supervised.parent_admission_id = sandbox_workspace_mutation_admissions.id
        and supervised.provider_command ? 'supervision')`;
  await admin`update sandbox_leases set holders_changed_at = now() - ${ago}::interval
    where id = ${fixture.leaseId}`;
}

function scope(fixture: Fixture) {
  return {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sandboxGroupId: fixture.sandboxGroupId,
    idleCommandContainmentMs: WINDOW_MS,
  };
}

async function commandTerminalRecord(fixture: Fixture) {
  const [command] = await admin<
    { state: string; exit_code: number | null; settlement_reason: string | null }[]
  >`select state, exit_code, settlement_reason from session_background_commands
    where id = ${fixture.processId}`;
  const finished = await admin<{ payload: Record<string, unknown> }[]>`
    select payload from session_events where session_id = ${fixture.attempt.sessionId}
      and type = 'session.command.finished'`;
  const updates = await admin<
    { summary: string; classification: string; payload: Record<string, unknown> }[]
  >`select summary, classification, payload from session_system_updates
    where session_id = ${fixture.attempt.sessionId} and kind = 'background_command_result'`;
  const pending = await admin<{ payload: Record<string, unknown> }[]>`
    select payload from session_events where session_id = ${fixture.attempt.sessionId}
      and type = 'system.update.pending'`;
  return { command, finished, updates, pending };
}

async function drain(fixture: Fixture, observability?: Observability) {
  const spy = terminateSpy();
  const activities = createSandboxLeaseActivities(services(observability), {
    terminateBox: spy.fn,
  });
  const result = await activities.drainSandboxLease({
    target: {
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
      instanceId: fixture.instanceId,
      leaseEpoch: EPOCH,
    },
    timeoutClass: "fast",
    snapshotTimeoutMs: 60_000,
    captureTimeoutMs: 120_000,
    operationId: crypto.randomUUID(),
  });
  return { result, persisted: spy.persisted };
}

async function recoveryFixture(adopted = false) {
  const fixture = await idleFixture({ outcome: "provider_error" });
  if (!adopted) await admin`delete from session_background_commands where id=${fixture.processId}`;
  await admin`update session_turn_attempts set quiesced_at=null,
    outcome='interrupted_recoverable' where id=${fixture.attempt.attemptId}`;
  const [dispatch] = await admin`select temporal_workflow_id, temporal_workflow_run_id,
    temporal_activity_id from session_turn_attempts where id=${fixture.attempt.attemptId}`;
  const settledOwner = {
    sessionId: fixture.attempt.sessionId,
    attemptId: fixture.attempt.attemptId,
    temporalWorkflowId: dispatch!.temporal_workflow_id as string,
    temporalWorkflowRunId: dispatch!.temporal_workflow_run_id as string,
    temporalActivityId: dispatch!.temporal_activity_id as string,
  };
  return { ...fixture, settledOwner };
}

describe("idle command containment", () => {
  test("settled recovery contains only its own legacy writers before opening admission", async () => {
    const fixture = await idleFixture({ outcome: "provider_error" });
    // This command has no independently adopted background lifetime.
    await admin`delete from session_background_commands where id=${fixture.processId}`;
    await admin`update session_turn_attempts set quiesced_at=null,
      outcome='interrupted_recoverable' where id=${fixture.attempt.attemptId}`;
    await admin`insert into session_events (account_id, workspace_id, session_id, turn_id,
      turn_attempt_id, sequence, type, payload)
      select attempt.account_id, attempt.workspace_id, attempt.session_id, attempt.turn_id,
        attempt.id, session.last_sequence+1,
        'turn.recovery.requested', '{}'::jsonb
      from session_turn_attempts attempt join sessions session on session.id=attempt.session_id
      where attempt.id=${fixture.attempt.attemptId}`;
    const [dispatch] = await admin`select temporal_workflow_id, temporal_workflow_run_id,
      temporal_activity_id from session_turn_attempts where id=${fixture.attempt.attemptId}`;
    const reconcile = (activitySettled: boolean, runId = dispatch!.temporal_workflow_run_id) =>
      reconcileSessionAttemptQuiescence(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.attempt.sessionId,
        attemptId: fixture.attempt.attemptId,
        temporalWorkflowId: dispatch!.temporal_workflow_id,
        temporalWorkflowRunId: runId,
        temporalActivityId: dispatch!.temporal_activity_id,
        activitySettled,
      });
    expect((await reconcile(false)).action).toBe("pending");
    expect(
      (await readLease(db, fixture.workspaceId, fixture.sandboxGroupId))
        ?.unobservableCommandDrainIds,
    ).toBeNull();
    expect((await reconcile(true, crypto.randomUUID())).action).toBe("stale");
    expect((await reconcile(true)).action).toBe("pending");
    expect(await peekSessionWork(db, fixture.workspaceId, fixture.attempt.sessionId)).toMatchObject(
      { kind: "cancellation-wait" },
    );
    const [enrollment] =
      await admin`select command_containment_reason from sandbox_leases where id=${fixture.leaseId}`;
    expect(enrollment?.command_containment_reason).toBe("quiescence_containment");
    expect(
      (
        await getRetainedProcess(db, {
          ...fixture,
          sessionId: fixture.attempt.sessionId,
          processId: fixture.processId,
        })
      )?.state,
    ).toBe("active");
    // A failed capture/termination never opens admission. The existing drain
    // harness captures before returning physical provider termination.
    expect((await drain(fixture)).result.status).toBe("terminated");
    expect(
      (
        await getRetainedProcess(db, {
          ...fixture,
          sessionId: fixture.attempt.sessionId,
          processId: fixture.processId,
        })
      )?.state,
    ).toBe("lost");
    const [wake] = await admin`select temporal_workflow_id, reason, wake_revision,
      delivered_revision from session_workflow_wake_outbox
      where session_id=${fixture.attempt.sessionId}`;
    expect(wake?.temporal_workflow_id).toBe(dispatch!.temporal_workflow_id);
    expect(wake?.reason).toBe("attempt_writer_provider_settled");
    expect(Number(wake?.wake_revision)).toBeGreaterThan(Number(wake?.delivered_revision));
    // Only the durable wake's next exact activity reconciliation opens admission.
    expect((await reconcile(true)).action).toBe("quiesced");
  }, 60_000);

  test("recovery enrollment refuses independent lifetimes and unsettled group work", async () => {
    const fixture = await recoveryFixture(true);
    const enroll = () =>
      enrollRetainedCommandContainment(db, {
        ...scope(fixture),
        settledOwner: fixture.settledOwner,
      });
    expect(await enroll()).toBeNull(); // adopted background command
    await admin`delete from session_background_commands where id=${fixture.processId}`;
    const viewer = `viewer-${crypto.randomUUID()}`;
    await acquireLease(db, {
      ...scope(fixture),
      kind: "viewer",
      holderId: viewer,
      backend: "modal",
      leaseTtlMs: 90000,
    });
    expect(await enroll()).toBeNull();
    await releaseLeaseHolder(db, {
      ...scope(fixture),
      kind: "viewer",
      holderId: viewer,
      idleGraceMs: SETTINGS.sandboxIdleGraceMs,
    });
    const sibling = await startAttempt(fixture, fixture.sandboxGroupId);
    expect(await enroll()).toBeNull(); // a live attempt, even without a holder
    await insertTurnHolder(fixture, sibling);
    const admission = await advanceWorkspaceGeneration(db, {
      ...fixture,
      ...sibling,
      expectedEpoch: EPOCH,
      expectedInstanceId: fixture.instanceId,
      operation: "apply_patch",
      routeKind: "home",
      routeTargetId: null,
      routeEpoch: 0,
    });
    await releaseLeaseHolder(db, {
      ...scope(fixture),
      kind: "turn",
      holderId: sibling.holderId,
      idleGraceMs: SETTINGS.sandboxIdleGraceMs,
      workspaceWritersQuiesced: true,
    });
    await finishTurn(sibling);
    await admin`update sandbox_workspace_mutation_admissions set provider_outcome=null,
      settled_at=null where id=${admission.id}`;
    expect(await enroll()).toBeNull(); // a separate unsettled admission
    await admin`update sandbox_workspace_mutation_admissions set provider_outcome='resolved',
      settled_at=now() where id=${admission.id}`;
    const [receipt] = await admin`insert into session_command_receipts (
      account_id, workspace_id, actor_type, actor_subject_id, action, target_session_id,
      target_turn_id, operation_key, canonical_request_hash) values (
      ${fixture.accountId}, ${fixture.workspaceId}, 'human', 'recovery-fixture',
      'session.queue.steer', ${fixture.attempt.sessionId}, ${fixture.attempt.turnId},
      ${crypto.randomUUID()}, 'recovery-fixture') returning id`;
    const [interruption] = await admin`insert into session_attempt_interruptions (
      account_id, workspace_id, session_id, operation_id, attempt_id, kind, control_revision, state)
      values (${fixture.accountId}, ${fixture.workspaceId}, ${fixture.attempt.sessionId},
        ${receipt!.id}, ${fixture.attempt.attemptId}, 'steer', 1, 'pending') returning id`;
    expect(await enroll()).toBeNull();
    await admin`update session_attempt_interruptions set state='settled', settled_at=now()
      where id=${interruption!.id}`;
    expect((await enroll())?.mode).toBe("quiescence");
  }, 60000);

  test("failed capture or provider termination leaves recovery fenced", async () => {
    for (const captured of [false, true]) {
      const fixture = await recoveryFixture();
      expect(
        (
          await enrollRetainedCommandContainment(db, {
            ...scope(fixture),
            settledOwner: fixture.settledOwner,
          })
        )?.mode,
      ).toBe("quiescence");
      const activities = createSandboxLeaseActivities(services(), {
        terminateBox: async (_settings, _lease, _observability, persistArchive) => {
          if (captured) {
            const archive = Buffer.from("RECOVERY_CHECKPOINT").toString("base64");
            expect((await persistArchive(archive, archiveDescriptor(archive))).wrote).toBe(true);
          }
          return false;
        },
      });
      const result = await activities.drainSandboxLease({
        target: {
          workspaceId: fixture.workspaceId,
          sandboxGroupId: fixture.sandboxGroupId,
          instanceId: fixture.instanceId,
          leaseEpoch: EPOCH,
        },
        timeoutClass: "fast",
        snapshotTimeoutMs: 60000,
        captureTimeoutMs: 120000,
        operationId: crypto.randomUUID(),
      });
      expect(result.status).not.toBe("terminated");
      expect(
        (
          await getRetainedProcess(db, {
            ...fixture,
            sessionId: fixture.attempt.sessionId,
            processId: fixture.processId,
          })
        )?.state,
      ).toBe("active");
      expect(
        (
          await reconcileSessionAttemptQuiescence(db, {
            ...scope(fixture),
            ...fixture.settledOwner,
            activitySettled: true,
          })
        ).action,
      ).toBe("pending");
      const [wake] = await admin`select reason from session_workflow_wake_outbox
        where session_id=${fixture.attempt.sessionId}`;
      expect(wake?.reason).not.toBe("attempt_writer_provider_settled");
    }
  }, 60000);
  for (const [label, outcome, reconcileAttempts] of [
    ["a healthy provider_running", "provider_running", 3],
    ["a repeatedly provider_error (no stop intent)", "provider_error", 9],
  ] as const) {
    test(`${label} command in an idle singleton group is contained after the window`, async () => {
      const fixture = await idleFixture({ outcome, reconcileAttempts });
      const observability = createObservability(SETTINGS, { component: "worker-test" });
      const activities = createSandboxLeaseActivities(services(observability));
      const sweep = async () =>
        (await activities.prepareSandboxLeaseSweep()).drainable.find(
          (row) => row.sandboxGroupId === fixture.sandboxGroupId,
        );

      // Idle, but not yet for the whole window: nothing changes.
      await idleFor(fixture, 29);
      expect(await sweep()).toBeUndefined();
      expect((await readLease(db, fixture.workspaceId, fixture.sandboxGroupId))?.liveness).toBe(
        "warm",
      );
      expect(
        await enrollRetainedCommandContainment(db, {
          ...scope(fixture),
          idleCommandContainmentMs: WINDOW_MS,
        }),
      ).toBeNull();

      await idleFor(fixture, 31);
      const target = await sweep();
      expect(target).toEqual({
        workspaceId: fixture.workspaceId,
        sandboxGroupId: fixture.sandboxGroupId,
        instanceId: fixture.instanceId,
        leaseEpoch: EPOCH,
      });
      const enrolled = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
      expect(enrolled?.liveness).toBe("draining");
      expect(enrolled?.unobservableCommandDrainIds).toEqual([fixture.processId]);
      // Enrollment is intent, not proof: the command, holder and parent stay.
      expect(
        (
          await getRetainedProcess(db, {
            ...fixture,
            sessionId: fixture.attempt.sessionId,
            processId: fixture.processId,
          })
        )?.state,
      ).toBe("active");

      const { result, persisted } = await drain(fixture, observability);
      expect(result.status).toBe("terminated");
      expect(persisted).toEqual([true]);

      const lease = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
      expect(lease?.liveness).toBe("cold");
      expect(lease?.leaseEpoch).toBe(EPOCH + 1);
      // The capture excluded exactly the enrolled writer and still covered the
      // current generation: the archive is the final, complete state.
      expect(lease?.archiveGeneration).toBe(fixture.admission.workspaceGeneration);
      expect(lease?.workspaceGeneration).toBe(fixture.admission.workspaceGeneration);
      expect(lease?.recovery.archive.status).toBe("available");
      expect(lease?.recovery.restore.status).toBe("pending");

      const [process] = await admin<
        { state: string; exit_code: number | null; settlement_reason: string }[]
      >`select state, exit_code, settlement_reason from sandbox_retained_processes
        where id = ${fixture.processId}`;
      expect(process).toEqual({
        state: "lost",
        exit_code: null,
        settlement_reason: "idle_containment",
      });
      const [parent] = await admin<{ provider_outcome: string; settled: boolean }[]>`
        select provider_outcome, settled_at is not null as settled
        from sandbox_workspace_mutation_admissions where id = ${fixture.admission.id}`;
      expect(parent).toEqual({ provider_outcome: "rejected", settled: true });
      const [holders] = await admin<{ n: number }[]>`select count(*)::int as n
        from sandbox_lease_holders where lease_id = ${fixture.leaseId}`;
      expect(holders?.n).toBe(0);

      const record = await commandTerminalRecord(fixture);
      expect(record.command).toEqual({
        state: "lost",
        exit_code: null,
        settlement_reason: "idle_containment",
      });
      expect(record.finished).toHaveLength(1);
      expect(record.finished[0]?.payload).toMatchObject({
        commandId: fixture.processId,
        state: "lost",
        exitCode: null,
        reason: "idle_containment",
      });
      expect(record.updates).toHaveLength(1);
      expect(record.updates[0]).toMatchObject({
        classification: "failure",
        summary:
          "`bun run dev --port 3000` was stopped because nobody used this session for 30 minutes " +
          "and nothing was waiting on it; the workspace was saved. Restart it if you still need it.",
        payload: { commandId: fixture.processId, state: "lost", reason: "idle_containment" },
      });
      expect(record.pending.map((event) => event.payload.kind)).toContain(
        "background_command_result",
      );

      const metrics = await observability.prometheusMetrics();
      expect(metrics).toMatch(
        /opengeni_sandbox_command_containment_total\{[^}]*outcome="idle_enrolled"[^}]*\} 1/,
      );
      expect(metrics).toMatch(
        /opengeni_sandbox_command_containment_total\{[^}]*outcome="contained"[^}]*\} 1/,
      );
      await observability.flush();
    }, 180_000);
  }

  test("no enrollment while any group member is open, viewed, writing, or supervised", async () => {
    // An open turn attempt in another session of the same group.
    {
      const fixture = await idleFixture();
      await idleFor(fixture, 31);
      const sibling = await startAttempt(fixture, fixture.sandboxGroupId);
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      await finishTurn(sibling);
      // Its close is fresh activity: the whole group must be idle again.
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      await idleFor(fixture, 31);
      expect((await enrollRetainedCommandContainment(db, scope(fixture)))?.mode).toBe("idle");
    }
    // A viewer holder, and its release restarting the idle clock.
    {
      const fixture = await idleFixture();
      await idleFor(fixture, 31);
      const viewerId = `viewer-${crypto.randomUUID()}`;
      const viewer = await acquireLease(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sandboxGroupId: fixture.sandboxGroupId,
        kind: "viewer",
        holderId: viewerId,
        backend: "modal",
        leaseTtlMs: 90_000,
      });
      expect(viewer.role).not.toBe("fenced");
      await idleFor(fixture, 31);
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      await releaseLeaseHolder(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sandboxGroupId: fixture.sandboxGroupId,
        kind: "viewer",
        holderId: viewerId,
        idleGraceMs: SETTINGS.sandboxIdleGraceMs,
      });
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      const [stamped] = await admin<{ fresh: boolean }[]>`
        select holders_changed_at > now() - interval '1 minute' as fresh
        from sandbox_leases where id = ${fixture.leaseId}`;
      expect(stamped?.fresh).toBe(true);
    }
    // A child session in the same group with an unsettled admission.
    {
      const fixture = await idleFixture();
      const child = await startAttempt(fixture, fixture.sandboxGroupId, fixture.attempt.sessionId);
      await insertTurnHolder(fixture, child);
      const childAdmission = await advanceWorkspaceGeneration(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        ...child,
        expectedEpoch: EPOCH,
        expectedInstanceId: fixture.instanceId,
        operation: "apply_patch",
        routeKind: "home",
        routeTargetId: null,
        routeEpoch: 0,
      });
      await admin`delete from sandbox_lease_holders where lease_id = ${fixture.leaseId}
        and holder_id = ${child.holderId}`;
      await admin`update sandbox_leases set refcount = 1, turn_holders = 0
        where id = ${fixture.leaseId}`;
      await finishTurn(child);
      await idleFor(fixture, 31);
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      await admin`update sandbox_workspace_mutation_admissions set provider_outcome = 'resolved',
        settled_at = now() - interval '31 minutes' where id = ${childAdmission.id}`;
      expect((await enrollRetainedCommandContainment(db, scope(fixture)))?.mode).toBe("idle");
    }
    // A supervised process on the same lease keeps its own proof gate.
    {
      const fixture = await idleFixture();
      const holder = await startAttempt(fixture, fixture.sandboxGroupId);
      await insertTurnHolder(fixture, holder);
      const admission = await advanceWorkspaceGeneration(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        ...holder,
        expectedEpoch: EPOCH,
        expectedInstanceId: fixture.instanceId,
        operation: "supervised",
        routeKind: "home",
        routeTargetId: null,
        routeEpoch: 0,
      });
      const supervisedId = crypto.randomUUID();
      await createProviderCommandRetainer(retainWorkspaceMutationProcess, () => null)(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: holder.sessionId,
        processId: supervisedId,
        providerSessionId: 8,
        admissionId: admission.id,
        admittedWorkspaceGeneration: admission.workspaceGeneration,
        operation: "supervised",
        providerBinding: MODAL_PROVIDER_BINDING,
        backgroundCommand: { commandId: supervisedId, command: "supervised server" },
        owner: {
          kind: "turn",
          ...holder,
          expectedEpoch: EPOCH,
          expectedInstanceId: fixture.instanceId,
          routeKind: "home",
          routeTargetId: null,
          routeEpoch: 0,
        },
        providerCommand: {
          kind: "modal-router-v1",
          sandboxId: fixture.instanceId,
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
      });
      await admin`delete from sandbox_lease_holders where lease_id = ${fixture.leaseId}
        and kind = 'turn'`;
      await admin`update sandbox_leases set refcount = 2, turn_holders = 0
        where id = ${fixture.leaseId}`;
      await finishTurn(holder);
      await idleFor(fixture, 31);
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      const candidates = await admin<{ sandbox_group_id: string }[]>`
        select sandbox_group_id
        from opengeni_private.list_command_containment_candidates(100, ${WINDOW_MS}::bigint)`;
      expect(candidates.map((row) => row.sandbox_group_id)).not.toContain(fixture.sandboxGroupId);
    }
  }, 180_000);

  test("a holder racing enrollment either wins or is fenced", async () => {
    // An arrival already inside its lease transaction wins: enrollment waits on
    // the lease row and then sees the new holder.
    {
      const fixture = await idleFixture();
      await idleFor(fixture, 31);
      let enrollment: Promise<unknown> | null = null;
      let settled = false;
      await admin.begin(async (tx) => {
        await tx`select id from sandbox_leases where id = ${fixture.leaseId} for update`;
        enrollment = enrollRetainedCommandContainment(db, scope(fixture)).finally(() => {
          settled = true;
        });
        await Bun.sleep(300);
        expect(settled).toBe(false);
        await tx`insert into sandbox_lease_holders
          (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
          values (${fixture.accountId}, ${fixture.leaseId}, ${fixture.workspaceId}, 'viewer',
            ${`viewer-${crypto.randomUUID()}`}, ${fixture.attempt.sessionId}, now())`;
        await tx`update sandbox_leases set refcount = refcount + 1, viewer_holders = 1
          where id = ${fixture.leaseId}`;
      });
      expect(await enrollment).toBeNull();
      expect((await readLease(db, fixture.workspaceId, fixture.sandboxGroupId))?.liveness).toBe(
        "warm",
      );
    }
    // Enrollment that committed first fences every later holder and writer.
    {
      const fixture = await idleFixture();
      await idleFor(fixture, 31);
      expect((await enrollRetainedCommandContainment(db, scope(fixture)))?.mode).toBe("idle");
      const arrival = await acquireLease(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sandboxGroupId: fixture.sandboxGroupId,
        kind: "viewer",
        holderId: `viewer-${crypto.randomUUID()}`,
        backend: "modal",
        leaseTtlMs: 90_000,
      });
      expect(arrival).toMatchObject({ role: "fenced", reason: "rotation_in_progress" });
      const next = await startAttempt(fixture, fixture.sandboxGroupId);
      await expect(
        advanceWorkspaceGeneration(db, {
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          ...next,
          expectedEpoch: EPOCH,
          expectedInstanceId: fixture.instanceId,
          operation: "late_write",
          routeKind: "home",
          routeTargetId: null,
          routeEpoch: 0,
        }),
      ).rejects.toBeInstanceOf(SandboxWorkspaceMutationFencedError);
      const lease = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
      expect(lease?.unobservableCommandDrainIds).toEqual([fixture.processId]);
      expect(lease?.refcount).toBe(1);
    }
    // Truly concurrent: exactly one side wins, never both.
    for (let round = 0; round < 3; round += 1) {
      const fixture = await idleFixture();
      await idleFor(fixture, 31);
      const [enrolled, arrival] = await Promise.all([
        enrollRetainedCommandContainment(db, scope(fixture)),
        acquireLease(db, {
          accountId: fixture.accountId,
          workspaceId: fixture.workspaceId,
          sandboxGroupId: fixture.sandboxGroupId,
          kind: "viewer",
          holderId: `viewer-${crypto.randomUUID()}`,
          backend: "modal",
          leaseTtlMs: 90_000,
        }),
      ]);
      if (enrolled) expect(arrival.role).toBe("fenced");
      else expect(arrival.role).not.toBe("fenced");
    }
  }, 180_000);

  test("an exit observed before the window settles normally without containment", async () => {
    const fixture = await idleFixture();
    await idleFor(fixture, 10);
    expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
    const processScope = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.attempt.sessionId,
      processId: fixture.processId,
    };
    const process = await getRetainedProcess(db, processScope);
    const settled = await settleRetainedProcess(db, {
      ...processScope,
      expected: retainedProcessSettlementIdentity(process!),
      outcome: "exited",
      exitCode: 0,
      reason: "provider_exit_banner",
      idleGraceMs: SETTINGS.sandboxIdleGraceMs,
    });
    expect(settled.settled).toBe(true);
    const record = await commandTerminalRecord(fixture);
    expect(record.command).toEqual({
      state: "exited",
      exit_code: 0,
      settlement_reason: "provider_exit_banner",
    });
    expect(record.updates).toEqual([
      expect.objectContaining({
        classification: "success",
        summary: "bun run dev --port 3000: completed successfully.",
      }),
    ]);
    // Nothing left to contain: the ordinary zero-holder idle drain owns the box.
    const lease = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    expect(lease?.liveness).toBe("draining");
    expect(lease?.unobservableCommandDrainIds ?? null).toBeNull();
    await idleFor(fixture, 31);
    expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
  }, 180_000);

  test("provider-deadline rotation keeps its two-minute grace and says why it stopped", async () => {
    const fixture = await idleFixture();
    await admin`update sandbox_leases set rotation_requested_at = now() - interval '3 minutes',
      rotation_reason = 'provider_deadline', provider_created_at = now() - interval '23 hours',
      provider_deadline_at = now() + interval '57 minutes' where id = ${fixture.leaseId}`;
    await admin`update sandbox_retained_processes set reconcile_attempts = 1,
      started_at = now() - interval '3 minutes',
      cancellation_requested_at = now() - interval '3 minutes', cancellation_reason = 'provider_deadline',
      deadline_cancellation_requested_at = now() - interval '1 minute'
      where id = ${fixture.processId}`;
    await admin`update session_turn_attempts set closed_at = now() - interval '3 minutes',
      quiesced_at = now() - interval '3 minutes' where id = ${fixture.attempt.attemptId}`;
    // Far inside the idle window, and still inside the command stop grace.
    expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
    await admin`update sandbox_retained_processes set
      deadline_cancellation_requested_at = now() - interval '3 minutes'
      where id = ${fixture.processId}`;
    expect((await enrollRetainedCommandContainment(db, scope(fixture)))?.mode).toBe("deadline");
    const { result } = await drain(fixture);
    expect(result.status).toBe("terminated");
    const record = await commandTerminalRecord(fixture);
    expect(record.command?.settlement_reason).toBe("provider_deadline_containment");
    expect(record.finished).toHaveLength(1);
    expect(record.updates[0]?.summary).toBe(
      "`bun run dev --port 3000` was stopped because the sandbox reached its maximum lifetime; " +
        "the workspace was saved. Restart it if you still need it.",
    );
  }, 180_000);

  test("an enrolled box lost before capture settles honestly as provider loss", async () => {
    const fixture = await idleFixture();
    await idleFor(fixture, 31);
    expect((await enrollRetainedCommandContainment(db, scope(fixture)))?.mode).toBe("idle");
    const confirmed = await confirmDrainCold(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
      expectedEpoch: EPOCH,
      providerMissingBeforeCapture: true,
      idleCommandContainmentMs: WINDOW_MS,
    });
    expect(confirmed.wentCold).toBe(true);
    expect(confirmed.backgroundCommandEvents?.map((event) => event.type)).toContain(
      "session.command.finished",
    );
    const record = await commandTerminalRecord(fixture);
    expect(record.command).toEqual({
      state: "lost",
      exit_code: null,
      settlement_reason: "provider_instance_lost",
    });
    expect(record.finished).toHaveLength(1);
    // No capture happened, so the notice must not claim a saved workspace.
    expect(record.updates[0]?.summary).toBe(
      "bun run dev --port 3000: result unavailable. Its exit status could not be confirmed.",
    );
  }, 180_000);

  test("a held input wait or a pending human request keeps the command running", async () => {
    // The agent registered wait_for_input for its background build and ended
    // its turn: the command is awaited, not abandoned.
    {
      const fixture = await idleFixture();
      await admin`update sessions set input_wait_turn_id = ${fixture.attempt.turnId},
        input_wait_until = now() + interval '3 hours', input_wait_reason = 'waiting for the build',
        input_wait_set_at = now() - interval '31 minutes' where id = ${fixture.attempt.sessionId}`;
      await idleFor(fixture, 45);
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      expect(
        (
          await reapStaleLeaseHoldersGlobal(db, {
            viewerHolderTtlMs: 90_000,
            idleGraceMs: SETTINGS.sandboxIdleGraceMs,
            idleCommandContainmentMs: WINDOW_MS,
          })
        ).some((row) => row.sandboxGroupId === fixture.sandboxGroupId),
      ).toBe(false);
      expect((await readLease(db, fixture.workspaceId, fixture.sandboxGroupId))?.liveness).toBe(
        "warm",
      );
      // Just past its deadline the wait still blocks: the idle window runs from
      // the wait's end, not from the last turn.
      await admin`update sessions set input_wait_until = now() - interval '1 second'
        where id = ${fixture.attempt.sessionId}`;
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      // Once that settlement retired the wait and the group then went unused,
      // nothing is waiting on the command any more.
      await admin`update sessions set input_wait_turn_id = null, input_wait_until = null,
        input_wait_reason = null, input_wait_set_at = null where id = ${fixture.attempt.sessionId}`;
      await idleFor(fixture, 31);
      expect((await enrollRetainedCommandContainment(db, scope(fixture)))?.mode).toBe("idle");
    }
    // Unclaimed machine input that will start a turn (here an agent message).
    {
      const fixture = await idleFixture();
      const [update] = await admin<{ id: string }[]>`insert into session_system_updates (
          account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary, payload
        ) values (${fixture.accountId}, ${fixture.workspaceId}, ${fixture.attempt.sessionId},
          'agent_message', ${crypto.randomUUID()}, ${`containment-${crypto.randomUUID()}`},
          'please keep the server up', ${admin.json({ type: "agent_message" })})
        returning id`;
      await idleFor(fixture, 45);
      expect(
        await admin<{ sandbox_group_id: string }[]>`select sandbox_group_id
          from opengeni_private.list_command_containment_candidates(100, ${WINDOW_MS}::bigint)`,
      ).not.toContainEqual({ sandbox_group_id: fixture.sandboxGroupId });
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      await admin`update session_system_updates set state = 'superseded' where id = ${update!.id}`;
      expect((await enrollRetainedCommandContainment(db, scope(fixture)))?.mode).toBe("idle");
    }
    // A paused session can never deliver its pending input or settle its
    // expired wait: both are idle-clock facts, not permanent blockers.
    {
      const fixture = await idleFixture();
      await admin`update sessions set direct_control_state = 'paused',
        direct_pause_revision = control_version,
        input_wait_turn_id = ${fixture.attempt.turnId}, input_wait_until = now() - interval '1 minute',
        input_wait_reason = 'waiting for the build', input_wait_set_at = now() - interval '2 hours'
        where id = ${fixture.attempt.sessionId}`;
      await admin`insert into session_system_updates (
          account_id, workspace_id, session_id, kind, source_id, dedupe_key, summary, payload
        ) values (${fixture.accountId}, ${fixture.workspaceId}, ${fixture.attempt.sessionId},
          'agent_message', ${crypto.randomUUID()}, ${`paused-${crypto.randomUUID()}`},
          'queued while paused', ${admin.json({ type: "agent_message" })})`;
      await idleFor(fixture, 45);
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      // Both facts age past the window while the session stays paused.
      await admin`update sessions set input_wait_until = now() - interval '31 minutes'
        where id = ${fixture.attempt.sessionId}`;
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      await admin`update session_system_updates set created_at = now() - interval '31 minutes'
        where session_id = ${fixture.attempt.sessionId} and state = 'pending'`;
      expect((await enrollRetainedCommandContainment(db, scope(fixture)))?.mode).toBe("idle");
    }
    // A pending approval or structured human input in any group session.
    {
      const fixture = await idleFixture();
      const asking = await startAttempt(fixture, fixture.sandboxGroupId);
      await admin`update session_turn_attempts set state = 'closed', outcome = 'requires_action',
        closed_at = now() where id = ${asking.attemptId}`;
      await admin`update session_turns set status = 'requires_action', active_attempt_id = null
        where id = ${asking.turnId}`;
      await admin`update sessions set status = 'requires_action' where id = ${asking.sessionId}`;
      await idleFor(fixture, 45);
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      // The person answered and that turn finished; the group then went unused.
      await admin`update session_turns set status = 'completed', finished_at = now()
        where id = ${asking.turnId}`;
      await admin`update sessions set status = 'idle', active_turn_id = null
        where id = ${asking.sessionId}`;
      expect(await enrollRetainedCommandContainment(db, scope(fixture))).toBeNull();
      await idleFor(fixture, 31);
      expect((await enrollRetainedCommandContainment(db, scope(fixture)))?.mode).toBe("idle");
    }
  }, 180_000);

  test("the deadline backstop captures behind a cancelled owner without a quiescence receipt", async () => {
    const fixture = await idleFixture();
    // The owner turn was cancelled: closed, no quiesced_at receipt, no pending
    // writer. Another turn in the group ran ten minutes ago.
    await admin`update session_turn_attempts set outcome = 'cancelled', quiesced_at = null,
      closed_at = now() - interval '50 minutes' where id = ${fixture.attempt.attemptId}`;
    await admin`update session_turns set status = 'cancelled' where id = ${fixture.attempt.turnId}`;
    const recent = await startAttempt(fixture, fixture.sandboxGroupId);
    await insertTurnHolder(fixture, recent);
    await releaseLeaseHolder(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
      kind: "turn",
      holderId: recent.holderId,
      idleGraceMs: SETTINGS.sandboxIdleGraceMs,
      workspaceWritersQuiesced: true,
    });
    await finishTurn(recent);
    await admin`update session_turn_attempts set closed_at = now() - interval '10 minutes',
      quiesced_at = now() - interval '10 minutes' where id = ${recent.attemptId}`;
    await admin`update sandbox_leases set rotation_requested_at = now() - interval '61 minutes',
      rotation_reason = 'provider_deadline', provider_created_at = now() - interval '23 hours',
      provider_deadline_at = now() - interval '1 minute' + interval '1 hour'
      where id = ${fixture.leaseId}`;
    await admin`update sandbox_retained_processes set reconcile_attempts = 260,
      started_at = now() - interval '2 hours',
      cancellation_requested_at = now() - interval '60 minutes', cancellation_reason = 'provider_deadline',
      deadline_cancellation_requested_at = now() - interval '60 minutes'
      where id = ${fixture.processId}`;
    // The group is far from idle for the window, but the backstop must act.
    expect((await enrollRetainedCommandContainment(db, scope(fixture)))?.mode).toBe("deadline");
    const { result, persisted } = await drain(fixture);
    expect(result.status).toBe("terminated");
    expect(persisted).toEqual([true]);
    const lease = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    expect(lease?.liveness).toBe("cold");
    expect(lease?.archiveGeneration).toBe(lease?.workspaceGeneration);
    expect((await commandTerminalRecord(fixture)).command?.settlement_reason).toBe(
      "provider_deadline_containment",
    );
  }, 180_000);

  test("provider loss seen by routing settles linked commands with their notice", async () => {
    const fixture = await idleFixture();
    const marked = await markWarmLeaseInstanceLost(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
      expectedEpoch: EPOCH,
      expectedInstanceId: fixture.instanceId,
      expectedBackend: "modal",
      diagnostic: "provider_not_found_during_routed_operation",
    });
    expect(marked.status).toBe("marked");
    if (marked.status !== "marked") throw new Error("loss was not marked");
    expect(marked.settlement.processesLost).toBe(1);
    expect(marked.backgroundCommandEvents?.map((event) => event.type)).toEqual([
      "session.command.finished",
      "system.update.pending",
    ]);
    const record = await commandTerminalRecord(fixture);
    expect(record.command).toEqual({
      state: "lost",
      exit_code: null,
      settlement_reason: "provider_instance_lost",
    });
    expect(record.finished).toHaveLength(1);
    expect(record.updates[0]?.summary).toBe(
      "bun run dev --port 3000: result unavailable. Its exit status could not be confirmed.",
    );
  }, 180_000);

  test("a drain enrolled without a recorded reason settles with neutral loss wording", async () => {
    // A pre-0547 worker enrolled this lease: drain ids but no containment reason.
    const fixture = await idleFixture();
    await admin`update sandbox_leases set unobservable_command_drain_ids = array[${fixture.processId}::uuid],
      liveness = 'draining', rotation_requested_at = now(), rotation_reason = 'operator',
      expires_at = now() where id = ${fixture.leaseId}`;
    const { result } = await drain(fixture);
    expect(result.status).toBe("terminated");
    const record = await commandTerminalRecord(fixture);
    expect(record.command?.settlement_reason).toBe("provider_instance_lost");
    expect(record.updates[0]?.summary).toBe(
      "bun run dev --port 3000: result unavailable. Its exit status could not be confirmed.",
    );
  }, 180_000);

  test("the reaper sweep reports each inspection outcome", async () => {
    const fixture = await idleFixture();
    const outcomes: CommandContainmentInspection[] = [];
    const sweep = () =>
      reapStaleLeaseHoldersGlobal(db, {
        viewerHolderTtlMs: 90_000,
        idleGraceMs: SETTINGS.sandboxIdleGraceMs,
        idleCommandContainmentMs: WINDOW_MS,
        onCommandContainment: (outcome) => outcomes.push(outcome),
      });
    const inventory = async () =>
      (
        await admin<{ sandbox_group_id: string }[]>`select sandbox_group_id
          from opengeni_private.list_command_containment_candidates(100, ${WINDOW_MS}::bigint)`
      ).map((row) => row.sandbox_group_id);
    // A group used five minutes ago is not even an inventory candidate, so it
    // never costs the exclusive workspace-control fence.
    await idleFor(fixture, 5);
    expect(await inventory()).not.toContain(fixture.sandboxGroupId);
    // Pending quiescence (a settled interruption without a receipt) passes the
    // coarse inventory, not exact enrollment.
    await admin`update session_turn_attempts set quiesced_at = null
      where id = ${fixture.attempt.attemptId}`;
    const [receipt] = await admin<{ id: string }[]>`insert into session_command_receipts (
      account_id, workspace_id, actor_type, actor_subject_id, action, target_session_id,
      target_turn_id, operation_key, canonical_request_hash) values (
      ${fixture.accountId}, ${fixture.workspaceId}, 'human', 'containment-fixture',
      'session.queue.steer', ${fixture.attempt.sessionId}, ${fixture.attempt.turnId},
      ${crypto.randomUUID()}, 'containment-fixture') returning id`;
    const [interruption] = await admin<{ id: string }[]>`insert into session_attempt_interruptions (
      account_id, workspace_id, session_id, operation_id, attempt_id, kind, control_revision, state)
      values (${fixture.accountId}, ${fixture.workspaceId}, ${fixture.attempt.sessionId},
        ${receipt!.id}, ${fixture.attempt.attemptId}, 'steer', 1, 'settled') returning id`;
    await idleFor(fixture, 31);
    expect(await inventory()).toContain(fixture.sandboxGroupId);
    await sweep();
    expect(outcomes).toContain("not_eligible");
    await admin`delete from session_attempt_interruptions where id = ${interruption!.id}`;
    outcomes.length = 0;
    expect((await sweep()).some((row) => row.sandboxGroupId === fixture.sandboxGroupId)).toBe(true);
    expect(outcomes).toContain("idle_enrolled");
    outcomes.length = 0;
    await sweep();
    expect(outcomes).toContain("resumed_enrolled");
  }, 180_000);
});
