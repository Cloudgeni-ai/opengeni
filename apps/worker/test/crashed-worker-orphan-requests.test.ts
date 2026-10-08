// OPE-743 regression: a request a crashed worker left behind must not pin a
// Modal box until the provider deadline kills it uncaptured. In staging
// session 5040c525 two exec requests of a lease-lost attempt stayed open (no
// retained process, provider outcome unknown, quiescence never written). Idle
// containment, the deadline backstop and the zero-holder drain all refused the
// box, so nothing was saved for a day. Drives the real reaper activities and
// lease/admission/process ledger against PostgreSQL; only the provider snapshot
// + stop and the readiness probe are faked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type Settings } from "@opengeni/config";
import {
  advanceWorkspaceGeneration,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  enrollRetainedCommandContainment,
  initializeSessionStartAtomically,
  readLease,
  retainWorkspaceMutationProcess,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import {
  acquireSharedTestDatabase,
  type SharedTestDatabase,
  testSettings,
} from "@opengeni/testing";
import { createSandboxLeaseActivities, type TerminateBoxFn } from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";
import {
  maybePersistWarmWorkspaceSnapshot,
  sandboxLeaseHolderIdForAttempt,
} from "../src/sandbox-resume";

const WINDOW_MS = 30 * 60_000;
const EPOCH = 31;
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
  shared = await acquireSharedTestDatabase("worker-crashed-worker-orphan-requests");
  if (!shared) throw new Error("Real PostgreSQL required for orphaned request regressions");
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
 * "stop", in production order. */
function terminateSpy() {
  const persisted: boolean[] = [];
  const fn: TerminateBoxFn = async (_settings, _lease, _observability, persistArchive) => {
    const archive = Buffer.from("ORPHAN_REQUEST_ARCHIVE").toString("base64");
    const { wrote } = await persistArchive(archive, archiveDescriptor(archive));
    persisted.push(wrote);
    return wrote;
  };
  return { fn, persisted };
}

/** A session whose turn attempt crashed on a warm Modal box: one exec request
 * was dispatched and never settled, the attempt was closed lease-lost without a
 * quiescence receipt, and its turn holder was reaped as dead. Optionally the
 * same attempt had already started a background command that keeps running. */
async function crashedAttemptFixture(
  options: {
    backgroundCommand?: boolean;
    outcome?: string;
    keepHolder?: boolean;
    /** Modal native snapshots image the paused box; tar reads it file by file. */
    persistence?: "snapshot_directory" | "tar";
  } = {},
) {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('orphan-request') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'orphan-request')
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
    dispatchId: `orphan-${crypto.randomUUID()}`,
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
      ${JSON.stringify({
        backendId: "modal",
        sessionState: {
          providerState: {
            sandboxId: instanceId,
            ...((options.persistence ?? "snapshot_directory") === "tar"
              ? {}
              : { workspacePersistence: options.persistence ?? "snapshot_directory" }),
          },
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
    await retainWorkspaceMutationProcess(db, {
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
    });
    await admin`update sandbox_retained_processes set
      last_reconcile_outcome = 'provider_running', reconcile_attempts = 3
      where id = ${processId}`;
  }
  // The exec the worker dispatched just before it died.
  const orphan = await admit("execCommand");
  // Worker death: the attempt is closed lease-lost with no quiescence receipt,
  // and the dead holder is reaped (turn holders are TTL-reaped as dead).
  await admin`update session_turn_attempts set state = 'closed',
    outcome = ${options.outcome ?? "lease_lost_recoverable"}, closed_at = now(), quiesced_at = null
    where id = ${attempt.attemptId}`;
  if (!options.keepHolder) {
    await admin`delete from sandbox_lease_holders where lease_id = ${lease!.id} and kind = 'turn'`;
    await admin`update sandbox_leases set
      refcount = refcount - 1, turn_holders = turn_holders - 1,
      liveness = case when refcount - 1 = 0 then 'draining' else liveness end,
      expires_at = case when refcount - 1 = 0 then now() - interval '1 second' else expires_at end
      where id = ${lease!.id}`;
  }
  // A later attempt of the same turn finished without touching the box.
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
    orphanId: orphan.id,
  };
}

type Fixture = Awaited<ReturnType<typeof crashedAttemptFixture>>;

/** Move every durable idleness fact of the fixture's group back in time. */
async function idleFor(fixture: Fixture, minutes: number) {
  const ago = `${minutes} minutes`;
  await admin`update session_turns set finished_at = now() - ${ago}::interval
    where workspace_id = ${fixture.workspaceId} and finished_at is not null`;
  await admin`update session_turn_attempts set closed_at = now() - ${ago}::interval,
    updated_at = now() - ${ago}::interval
    where workspace_id = ${fixture.workspaceId} and state = 'closed'`;
  await admin`update sandbox_workspace_mutation_admissions
    set admitted_at = now() - ${ago}::interval where lease_id = ${fixture.leaseId}`;
  await admin`update sandbox_leases set holders_changed_at = now() - ${ago}::interval
    where id = ${fixture.leaseId}`;
}

async function drain(fixture: Fixture) {
  const spy = terminateSpy();
  const probes: string[] = [];
  const activities = createSandboxLeaseActivities(services(), {
    terminateBox: spy.fn,
    // The provider is alive: only a capture may lead to termination.
    probeDrainableProvider: async () => {
      probes.push("alive");
      return "alive" as never;
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
    snapshotTimeoutMs: 60_000,
    captureTimeoutMs: 120_000,
    operationId: crypto.randomUUID(),
  });
  return { result, persisted: spy.persisted, probes };
}

async function orphanRow(fixture: Fixture) {
  const [row] = await admin<{ provider_outcome: string | null; settled_at: Date | null }[]>`
    select provider_outcome, settled_at from sandbox_workspace_mutation_admissions
    where id = ${fixture.orphanId}`;
  return row!;
}

async function ownerWake(fixture: Fixture) {
  const [row] = await admin<{ reason: string }[]>`
    select reason from session_workflow_wake_outbox where session_id = ${fixture.attempt.sessionId}`;
  return row?.reason ?? null;
}

describe("requests left by a crashed worker (OPE-743)", () => {
  test("an orphaned request alone no longer pins the zero-holder drain", async () => {
    const fixture = await crashedAttemptFixture();
    expect(await readLease(db, fixture.workspaceId, fixture.sandboxGroupId)).toMatchObject({
      liveness: "draining",
      refcount: 0,
    });
    const { result, persisted, probes } = await drain(fixture);
    // Before OPE-743: capture refused (mutation_in_progress), the probe saw a
    // live box, and the drain skipped on every sweep until the provider died.
    expect(probes).toEqual([]);
    expect(persisted).toEqual([true]);
    expect(result.status).toBe("terminated");
    const lease = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    expect(lease).toMatchObject({ liveness: "cold", archiveComplete: true });
    // The box is terminated, so nothing the request started can still run.
    const orphan = await orphanRow(fixture);
    expect(orphan.provider_outcome).toBe("rejected");
    expect(orphan.settled_at).not.toBeNull();
    // Its owner gets the durable wake that reconciles the quiescence receipt.
    expect(await ownerWake(fixture)).toBe("attempt_writer_provider_settled");
  }, 60_000);

  test("idle containment captures around an orphaned request next to a background command", async () => {
    const fixture = await crashedAttemptFixture({ backgroundCommand: true });
    await idleFor(fixture, 31);
    const scope = {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
      idleCommandContainmentMs: WINDOW_MS,
    };
    const enrolled = await enrollRetainedCommandContainment(db, scope);
    expect(enrolled?.mode).toBe("idle");
    const { result, persisted } = await drain(fixture);
    expect(persisted).toEqual([true]);
    expect(result.status).toBe("terminated");
    expect(await readLease(db, fixture.workspaceId, fixture.sandboxGroupId)).toMatchObject({
      liveness: "cold",
    });
    const [process] = await admin<{ state: string; settlement_reason: string }[]>`
      select state, settlement_reason from sandbox_retained_processes where id = ${fixture.processId}`;
    expect(process).toEqual({ state: "lost", settlement_reason: "idle_containment" });
    expect((await orphanRow(fixture)).provider_outcome).toBe("rejected");
  }, 60_000);

  test("the deadline backstop enrolls despite an orphaned request", async () => {
    const fixture = await crashedAttemptFixture({ backgroundCommand: true });
    await admin`update sandbox_leases set rotation_requested_at = now() - interval '3 minutes',
      rotation_reason = 'provider_deadline',
      provider_created_at = now() - interval '23 hours',
      provider_deadline_at = now() + interval '50 minutes'
      where id = ${fixture.leaseId}`;
    await admin`update sandbox_retained_processes set
      started_at = now() - interval '3 minutes',
      cancellation_requested_at = now() - interval '3 minutes',
      cancellation_reason = 'provider_deadline',
      deadline_cancellation_requested_at = now() - interval '3 minutes'
      where id = ${fixture.processId}`;
    await admin`update session_turn_attempts set closed_at = now() - interval '3 minutes',
      updated_at = now() - interval '3 minutes' where id = ${fixture.attempt.attemptId}`;
    const enrolled = await enrollRetainedCommandContainment(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sandboxGroupId: fixture.sandboxGroupId,
    });
    // Before OPE-743 this was null ("not_eligible") on every sweep.
    expect(enrolled?.mode).toBe("deadline");
    const { result, persisted } = await drain(fixture);
    expect(persisted).toEqual([true]);
    expect(result.status).toBe("terminated");
    const [process] = await admin<{ state: string; settlement_reason: string }[]>`
      select state, settlement_reason from sandbox_retained_processes where id = ${fixture.processId}`;
    expect(process).toEqual({ state: "lost", settlement_reason: "provider_deadline_containment" });
    expect((await orphanRow(fixture)).provider_outcome).toBe("rejected");
  }, 60_000);

  test("the next turn checkpoints around an orphaned request, never claiming it complete", async () => {
    const fixture = await crashedAttemptFixture({ keepHolder: false });
    // A sibling session of the same sandbox group starts a turn on the box.
    const sibling = await createSession(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      initialMessage: "keep going",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      sandboxGroupId: fixture.sandboxGroupId,
    });
    await initializeSessionStartAtomically(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: sibling.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(db, fixture.workspaceId, {
      sessionId: sibling.id,
      workflowId: `session-${sibling.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `orphan-sibling-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error(`sibling turn not claimed: ${claim.reason}`);
    const holderId = sandboxLeaseHolderIdForAttempt(attemptId);
    await admin`insert into sandbox_lease_holders
      (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
      values (${fixture.accountId}, ${fixture.leaseId}, ${fixture.workspaceId}, 'turn', ${holderId},
        ${sibling.id}, now())`;
    await admin`update sandbox_leases set liveness = 'warm', refcount = 1, turn_holders = 1,
      expires_at = now() + interval '10 minutes' where id = ${fixture.leaseId}`;
    let calls = 0;
    const provider = {
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
        return new TextEncoder().encode(
          'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-orphan-sibling","workspace_persistence":"snapshot_filesystem"}',
        );
      },
    };
    const persisted = await maybePersistWarmWorkspaceSnapshot(
      {
        db,
        settings: testSettings({ sandboxSnapshotIntervalMs: 1, sandboxSnapshotTimeoutMs: 5_000 }),
      },
      {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: sibling.id,
        turnId: claim.turn.id,
        attemptId,
        sandboxGroupId: fixture.sandboxGroupId,
      },
      provider,
      EPOCH,
    );
    expect(persisted).toBe(true);
    expect(calls).toBe(1);
    const lease = await readLease(db, fixture.workspaceId, fixture.sandboxGroupId);
    // The orphan may still be running a command on this box.
    expect(lease!.archiveGeneration).toBe(lease!.workspaceGeneration - 1);
    expect(lease!.archiveComplete).toBe(false);
    expect((await orphanRow(fixture)).settled_at).toBeNull();
  }, 60_000);

  test("a request of an attempt that failed after losing its worker is handled the same way", async () => {
    const fixture = await crashedAttemptFixture({ outcome: "failed" });
    const { result, persisted } = await drain(fixture);
    expect(persisted).toEqual([true]);
    expect(result.status).toBe("terminated");
    expect((await orphanRow(fixture)).provider_outcome).toBe("rejected");
  }, 60_000);

  test("a tar-style capture keeps an orphaned request as a blocker", async () => {
    // A file-by-file read of the running box could publish torn state as the
    // complete final archive; only point-in-time captures run around it.
    const fixture = await crashedAttemptFixture({ persistence: "tar" });
    const { result, persisted, probes } = await drain(fixture);
    expect(persisted).toEqual([]);
    expect(probes).toEqual(["alive"]);
    expect(result.status).toBe("skipped");
    expect((await orphanRow(fixture)).settled_at).toBeNull();
  }, 60_000);

  test("tar-style idle containment does not enroll around an orphan it could never drain", async () => {
    const fixture = await crashedAttemptFixture({ backgroundCommand: true, persistence: "tar" });
    await idleFor(fixture, 31);
    expect(
      await enrollRetainedCommandContainment(db, {
        accountId: fixture.accountId,
        workspaceId: fixture.workspaceId,
        sandboxGroupId: fixture.sandboxGroupId,
        idleCommandContainmentMs: WINDOW_MS,
      }),
    ).toBeNull();
    // The box stays warm and usable instead of being fenced behind a drain
    // that can never capture.
    expect(await readLease(db, fixture.workspaceId, fixture.sandboxGroupId)).toMatchObject({
      liveness: "warm",
      rotationRequestedAt: null,
    });
  }, 60_000);

  test("an orphan next to a request that may still finish keeps fencing the box", async () => {
    const fixture = await crashedAttemptFixture();
    // A sibling session's cancelled attempt left a request open on the same
    // box; Pause/Steer/cancel owners may still be draining it.
    const sibling = await createSession(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      initialMessage: "sibling",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      sandboxGroupId: fixture.sandboxGroupId,
    });
    await initializeSessionStartAtomically(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: sibling.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(db, fixture.workspaceId, {
      sessionId: sibling.id,
      workflowId: `session-${sibling.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `orphan-sibling-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error(`sibling turn not claimed: ${claim.reason}`);
    const holderId = sandboxLeaseHolderIdForAttempt(attemptId);
    await admin`update sandbox_leases set liveness = 'warm', refcount = 1, turn_holders = 1,
      expires_at = now() + interval '10 minutes' where id = ${fixture.leaseId}`;
    await admin`insert into sandbox_lease_holders
      (account_id, lease_id, workspace_id, kind, holder_id, subject_id, last_heartbeat_at)
      values (${fixture.accountId}, ${fixture.leaseId}, ${fixture.workspaceId}, 'turn', ${holderId},
        ${sibling.id}, now())`;
    await advanceWorkspaceGeneration(db, {
      accountId: fixture.accountId,
      workspaceId: fixture.workspaceId,
      sessionId: sibling.id,
      turnId: claim.turn.id,
      executionGeneration: claim.turn.executionGeneration,
      attemptId,
      holderId,
      sandboxGroupId: fixture.sandboxGroupId,
      expectedEpoch: EPOCH,
      expectedInstanceId: fixture.instanceId,
      operation: "execCommand",
      routeKind: "home",
      routeTargetId: null,
      routeEpoch: 0,
    });
    await admin`update session_turn_attempts set state = 'closed', outcome = 'cancelled',
      closed_at = now() where id = ${attemptId}`;
    await admin`delete from sandbox_lease_holders where lease_id = ${fixture.leaseId}`;
    await admin`update sandbox_leases set liveness = 'draining', refcount = 0, turn_holders = 0,
      expires_at = now() - interval '1 second' where id = ${fixture.leaseId}`;
    const { result, persisted } = await drain(fixture);
    expect(persisted).toEqual([]);
    expect(result.status).toBe("skipped");
    expect((await orphanRow(fixture)).settled_at).toBeNull();
  }, 60_000);

  test("a request whose owner may still be draining keeps fencing the box", async () => {
    // Pause/Steer may drop the turn holder eagerly while the live activity is
    // still draining its request: that attempt does not close lease-lost.
    const cancelled = await crashedAttemptFixture({ outcome: "cancelled" });
    const cancelledDrain = await drain(cancelled);
    expect(cancelledDrain.persisted).toEqual([]);
    expect(cancelledDrain.probes).toEqual(["alive"]);
    expect(cancelledDrain.result.status).toBe("skipped");
    expect((await orphanRow(cancelled)).settled_at).toBeNull();

    // A lease-lost attempt whose holder still exists keeps the box (the holder
    // itself also blocks; the predicate's holder clause is defence in depth).
    const held = await crashedAttemptFixture({ backgroundCommand: true, keepHolder: true });
    await idleFor(held, 31);
    expect(
      await enrollRetainedCommandContainment(db, {
        accountId: held.accountId,
        workspaceId: held.workspaceId,
        sandboxGroupId: held.sandboxGroupId,
        idleCommandContainmentMs: WINDOW_MS,
      }),
    ).toBeNull();
    expect((await orphanRow(held)).settled_at).toBeNull();
  }, 60_000);
});
