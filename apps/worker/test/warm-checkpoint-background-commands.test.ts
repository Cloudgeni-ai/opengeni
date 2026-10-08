// Regression: a background command that keeps running across the warm
// checkpoint interval must not starve workspace snapshots. Staging session
// 5040c525 kept 35 commands "running" for a whole day; every checkpoint was
// refused while any of them held the box, so the provider's 24h deadline lost
// about 10 hours of files. Drives the real warm-snapshot path
// (maybePersistWarmWorkspaceSnapshot -> claimWorkspaceArchiveCapture ->
// persistWarmSnapshot) and the real lease/process ledger against PostgreSQL;
// only the provider snapshot RPC is faked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  advanceWorkspaceGeneration,
  claimSessionWorkForAttempt,
  claimWorkspaceArchiveCapture,
  createDb,
  createSession,
  getRetainedProcess,
  initializeSessionStartAtomically,
  readLease,
  releaseLeaseHolder,
  replaceWorkspaceArchiveCaptureAfterProof,
  retainWorkspaceMutationProcess,
  settleRetainedProcess,
  type Database,
  type DbClient,
} from "@opengeni/db";
import type { RuntimeMetricsHooks, WorkspaceCaptureSkipReason } from "@opengeni/runtime";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import {
  maybePersistWarmWorkspaceSnapshot,
  sandboxLeaseHolderIdForAttempt,
} from "../src/sandbox-resume";

const EPOCH = 21;
const MODAL_PROVIDER_BINDING = {
  key: '{"version":1,"serverUrl":"https://modal.test","workspaceName":"opengeni-test","environment":"test"}',
  binding: {
    version: 1 as const,
    serverUrl: "https://modal.test",
    workspaceName: "opengeni-test",
    environment: "test",
  },
};
const SNAPSHOT_SETTINGS = testSettings({
  sandboxSnapshotIntervalMs: 1,
  sandboxSnapshotTimeoutMs: 5_000,
});

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-warm-checkpoint-background-commands");
  if (!shared) throw new Error("Real PostgreSQL required for warm checkpoint regressions");
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

/** A Modal native filesystem snapshot whose provider RPC only counts calls.
 * `during` runs while the provider is "reading" the paused box. */
function modalSession(during?: () => Promise<void>) {
  let calls = 0;
  const session = {
    state: { workspacePersistence: "snapshot_filesystem" },
    modal: {
      cpClient: {
        workspaceNameLookup: async () => ({ workspaceName: "opengeni-test", username: "" }),
      },
      profile: { serverUrl: "https://modal.test" },
      environmentName: () => "main",
    },
    persistWorkspace: async () => {
      calls += 1;
      await during?.();
      return new TextEncoder().encode(
        `MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-background-${crypto.randomUUID()}","workspace_persistence":"snapshot_filesystem"}`,
      );
    },
  };
  return { session, calls: () => calls };
}

async function exitCommand(fixture: Fixture) {
  const process = await getRetainedProcess(db, {
    workspaceId: fixture.workspaceId,
    sessionId: fixture.attempt.sessionId,
    processId: fixture.processId,
  });
  await settleRetainedProcess(db, {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.attempt.sessionId,
    processId: fixture.processId,
    expected: process!,
    outcome: "exited",
    exitCode: 0,
    reason: "provider_exit_banner",
    idleGraceMs: 0,
  });
}

/** One running turn on a warm Modal box that has already started a background
 * command (for example a dev server or a long benchmark). */
async function runningTurnWithBackgroundCommand() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('warm-checkpoint') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'warm-checkpoint')
    returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const ids = { accountId: account!.id, workspaceId: workspace!.id };
  const session = await createSession(db, {
    ...ids,
    initialMessage: "start the benchmark and keep working",
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
    dispatchId: `warm-checkpoint-${crypto.randomUUID()}`,
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
      ${instanceId}, 'modal', ${EPOCH}, 'modal',
      ${JSON.stringify({ backendId: "modal", sessionState: { providerState: { sandboxId: instanceId } } })}::text::jsonb,
      now() + interval '10 minutes')
    returning id`;
  await admin`insert into sandbox_lease_holders
    (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
    values (${ids.accountId}, ${lease!.id}, ${ids.workspaceId}, 'turn', ${attempt.holderId},
      ${attempt.sessionId}, now())`;
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
  const processId = crypto.randomUUID();
  await retainWorkspaceMutationProcess(db, {
    ...ids,
    sessionId: attempt.sessionId,
    processId,
    providerSessionId: 9,
    admissionId: admission.id,
    admittedWorkspaceGeneration: admission.workspaceGeneration,
    operation: "exec_command",
    providerBinding: MODAL_PROVIDER_BINDING,
    backgroundCommand: { commandId: processId, command: "bun run bench --watch" },
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
  return { ...ids, attempt, instanceId, leaseId: lease!.id, processId };
}

type Fixture = Awaited<ReturnType<typeof runningTurnWithBackgroundCommand>>;

function skipRecorder() {
  const skipped: WorkspaceCaptureSkipReason[] = [];
  const metrics: RuntimeMetricsHooks = {
    onWorkspaceCaptureSkipped: ({ reason }) => skipped.push(reason),
  };
  return { skipped, metrics };
}

async function checkpoint(
  fixture: Fixture,
  session: unknown,
  metrics?: RuntimeMetricsHooks,
): Promise<boolean> {
  // The periodic interval is 1 ms; make sure it has elapsed between calls.
  await Bun.sleep(5);
  const result = maybePersistWarmWorkspaceSnapshot(
    { db, settings: SNAPSHOT_SETTINGS, ...(metrics ? { sandboxMetrics: metrics } : {}) },
    {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.attempt.sessionId,
      turnId: fixture.attempt.turnId,
      attemptId: fixture.attempt.attemptId,
      sandboxGroupId: fixture.attempt.sandboxGroupId,
    },
    session,
    EPOCH,
  );
  const persisted = await result;
  await result.settled;
  return persisted;
}

function captureScope(fixture: Fixture) {
  return {
    accountId: fixture.accountId,
    workspaceId: fixture.workspaceId,
    sandboxGroupId: fixture.attempt.sandboxGroupId,
    expectedEpoch: EPOCH,
    expectedInstanceId: fixture.instanceId,
  };
}

describe("warm checkpoints while background commands run", () => {
  test("a command running across the snapshot interval is checkpointed around, never starving capture", async () => {
    const fixture = await runningTurnWithBackgroundCommand();
    const provider = modalSession();
    const { skipped, metrics } = skipRecorder();

    // Previously this returned false (holder_in_progress) for as long as the
    // command ran, which in the incident was the box's whole 24h lifetime.
    expect(await checkpoint(fixture, provider.session, metrics)).toBe(true);
    expect(provider.calls()).toBe(1);
    expect(skipped).toEqual([]);
    const afterFirst = await readLease(db, fixture.workspaceId, fixture.attempt.sandboxGroupId);
    expect(afterFirst).toMatchObject({ liveness: "warm", archiveCapture: null });
    expect(afterFirst?.currentCheckpointArtifactId).not.toBeNull();
    // The command may write after the provider read the box, so the checkpoint is
    // a real recovery point but never claims to cover the newest generation.
    expect(afterFirst!.archiveGeneration).toBe(afterFirst!.workspaceGeneration - 1);
    expect(afterFirst!.archiveComplete).toBe(false);

    // The command is still running and the interval elapsed: capture again.
    expect(await checkpoint(fixture, provider.session, metrics)).toBe(true);
    expect(provider.calls()).toBe(2);
    const afterSecond = await readLease(db, fixture.workspaceId, fixture.attempt.sandboxGroupId);
    expect(afterSecond!.archiveGeneration).toBe(afterFirst!.workspaceGeneration);
    expect(afterSecond!.archiveComplete).toBe(false);

    // The command keeps its process holder and admission throughout; capture
    // neither settles nor releases it.
    const process = await getRetainedProcess(db, {
      workspaceId: fixture.workspaceId,
      sessionId: fixture.attempt.sessionId,
      processId: fixture.processId,
    });
    expect(process).toMatchObject({ state: "active" });
    const [holders] = await admin<{ count: number }[]>`
      select count(*)::integer as count from sandbox_lease_holders
      where lease_id = ${fixture.leaseId} and kind = 'process'`;
    expect(holders!.count).toBe(1);

    // Once the command has exited before a capture starts, the next checkpoint
    // covers the exact generation and later calls stop before the provider.
    await settleRetainedProcess(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: fixture.attempt.sessionId,
      processId: fixture.processId,
      expected: process!,
      outcome: "exited",
      exitCode: 0,
      reason: "provider_exit_banner",
      idleGraceMs: 60_000,
    });
    expect(await checkpoint(fixture, provider.session, metrics)).toBe(true);
    expect(provider.calls()).toBe(3);
    const settled = await readLease(db, fixture.workspaceId, fixture.attempt.sandboxGroupId);
    expect(settled!.archiveComplete).toBe(true);
    expect(await checkpoint(fixture, provider.session, metrics)).toBe(false);
    expect(provider.calls()).toBe(3);
    expect(skipped).toEqual([]);
  }, 60_000);

  test("an in-flight request still fences capture and the skip is counted", async () => {
    const fixture = await runningTurnWithBackgroundCommand();
    const provider = modalSession();
    const { skipped, metrics } = skipRecorder();
    // A second exec the turn has dispatched but not yet settled: a genuinely
    // in-flight writer, unlike the long-lived background command admission.
    const inFlight = await advanceWorkspaceGeneration(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      ...fixture.attempt,
      expectedEpoch: EPOCH,
      expectedInstanceId: fixture.instanceId,
      operation: "exec_command",
      routeKind: "home",
      routeTargetId: null,
      routeEpoch: 0,
    });
    expect(await checkpoint(fixture, provider.session, metrics)).toBe(false);
    expect(provider.calls()).toBe(0);
    expect(skipped).toEqual(["mutation_in_progress"]);

    await admin`update sandbox_workspace_mutation_admissions
      set settled_at = now(), provider_outcome = 'resolved' where id = ${inFlight.id}`;
    expect(await checkpoint(fixture, provider.session, metrics)).toBe(true);
    expect(provider.calls()).toBe(1);
  }, 60_000);

  test("a command that exits during the capture still leaves the archive one generation behind", async () => {
    const fixture = await runningTurnWithBackgroundCommand();
    const provider = modalSession(() => exitCommand(fixture));
    expect(await checkpoint(fixture, provider.session)).toBe(true);
    const lease = await readLease(db, fixture.workspaceId, fixture.attempt.sandboxGroupId);
    expect(lease).toMatchObject({ liveness: "warm", archiveCapture: null });
    expect(lease!.archiveGeneration).toBe(lease!.workspaceGeneration - 1);
    expect(lease!.archiveComplete).toBe(false);
  }, 60_000);

  test("a capture that ran around a command can never publish the final drain archive", async () => {
    const fixture = await runningTurnWithBackgroundCommand();
    // While the provider reads the box, the turn releases its holder and the
    // command exits, so the lease drains before the capture lands.
    const provider = modalSession(async () => {
      await releaseLeaseHolder(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sandboxGroupId: fixture.attempt.sandboxGroupId,
        kind: "turn",
        holderId: fixture.attempt.holderId,
        idleGraceMs: 0,
      });
      await exitCommand(fixture);
    });
    expect(await checkpoint(fixture, provider.session)).toBe(false);
    const lease = await readLease(db, fixture.workspaceId, fixture.attempt.sandboxGroupId);
    // Not published as the complete final workspace, and the claim is
    // released so the drain recaptures the now-quiet box.
    expect(lease).toMatchObject({ liveness: "draining", archiveCapture: null });
    expect(lease!.archiveComplete).toBe(false);
    expect(lease!.archiveGeneration).toBeNull();
  }, 60_000);

  test("a drain takeover of a claim that ran around commands requests a fresh snapshot", async () => {
    const fixture = await runningTurnWithBackgroundCommand();
    const captureId = crypto.randomUUID();
    const claimed = await claimWorkspaceArchiveCapture(db, {
      ...captureScope(fixture),
      captureId,
      liveness: "warm",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
      providerReplaySafe: true,
      takeoverSafe: true,
      pointInTimeCapture: true,
      warmAttempt: {
        sessionId: fixture.attempt.sessionId,
        turnId: fixture.attempt.turnId,
        attemptId: fixture.attempt.attemptId,
        holderId: fixture.attempt.holderId,
      },
    });
    if (claimed.status !== "claimed") throw new Error(`warm claim refused: ${claimed.status}`);
    // The warm worker dies mid-capture; its holder is reaped and the command
    // exits, so the box drains with the old claim still installed.
    await admin`delete from sandbox_lease_holders where lease_id = ${fixture.leaseId} and kind = 'turn'`;
    await exitCommand(fixture);
    await admin`update sandbox_leases set liveness = 'draining', refcount = 0, turn_holders = 0
      where id = ${fixture.leaseId}`;
    const replacement = await replaceWorkspaceArchiveCaptureAfterProof(db, {
      ...captureScope(fixture),
      priorCaptureId: captureId,
      captureId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      attempt: 1,
      captureTimeoutMs: 60_000,
    });
    expect(replacement).not.toBeNull();
    // Replaying the original request would return the warm-time image.
    expect(replacement!.providerRequestId).not.toBe(claimed.claim.providerRequestId);
  }, 60_000);

  test("a pre-0649 takeover that keeps the request id still gets a fresh snapshot", async () => {
    const fixture = await runningTurnWithBackgroundCommand();
    const captureId = crypto.randomUUID();
    const claimed = await claimWorkspaceArchiveCapture(db, {
      ...captureScope(fixture),
      captureId,
      liveness: "warm",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
      providerReplaySafe: true,
      takeoverSafe: true,
      pointInTimeCapture: true,
      warmAttempt: {
        sessionId: fixture.attempt.sessionId,
        turnId: fixture.attempt.turnId,
        attemptId: fixture.attempt.attemptId,
        holderId: fixture.attempt.holderId,
      },
    });
    if (claimed.status !== "claimed") throw new Error(`warm claim refused: ${claimed.status}`);
    // An older worker's takeover replaces only the claim id and keeps the
    // provider request id and the marker column untouched.
    const replacementId = crypto.randomUUID();
    await admin`update sandbox_leases set archive_capture_id = ${replacementId}::uuid
      where id = ${fixture.leaseId}`;
    const [row] = await admin<
      { provider_request_id: string; marker: string | null }[]
    >`select archive_capture_provider_request_id as provider_request_id,
        archive_capture_concurrent_capture_id as marker
      from sandbox_leases where id = ${fixture.leaseId}`;
    expect(row!.provider_request_id).not.toBe(claimed.claim.providerRequestId);
    expect(row!.marker).toBeNull();
  }, 60_000);

  test("tar-style captures keep every running command as a blocker", async () => {
    const fixture = await runningTurnWithBackgroundCommand();
    expect(
      await claimWorkspaceArchiveCapture(db, {
        ...captureScope(fixture),
        captureId: crypto.randomUUID(),
        liveness: "warm",
        captureTimeoutMs: 60_000,
        minIntervalMs: 0,
        warmAttempt: {
          sessionId: fixture.attempt.sessionId,
          turnId: fixture.attempt.turnId,
          attemptId: fixture.attempt.attemptId,
          holderId: fixture.attempt.holderId,
        },
      }),
    ).toEqual({ status: "holder_in_progress" });
  }, 60_000);

  test("a viewer or a sibling turn still holds capture off", async () => {
    const fixture = await runningTurnWithBackgroundCommand();
    const provider = modalSession();
    const { skipped, metrics } = skipRecorder();
    await admin`insert into sandbox_lease_holders
      (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
      values (${fixture.accountId}, ${fixture.leaseId}, ${fixture.workspaceId}, 'viewer',
        ${`viewer:${crypto.randomUUID()}`}, ${fixture.attempt.sessionId}, now())`;
    expect(await checkpoint(fixture, provider.session, metrics)).toBe(false);
    expect(provider.calls()).toBe(0);
    expect(skipped).toEqual(["holder_in_progress"]);
  }, 60_000);
});
