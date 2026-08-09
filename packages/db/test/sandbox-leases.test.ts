import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createHash } from "node:crypto";
import postgres from "postgres";
import {
  acquireLease,
  acquireSandboxLeaseReaperHold,
  advanceWorkspaceGenerationForDirectRequest,
  adoptLegacyModalCheckpointArtifact,
  beginSandboxRematerialization,
  claimTemporalScheduleCleanups,
  claimWorkspaceArchiveCapture,
  commitWarmingToWarm,
  confirmDrainCold,
  createDb,
  deleteWorkspaceIfQuiescent,
  failSandboxRematerialization,
  failWarmingToCold,
  getMaterializedSandboxFileResources,
  heartbeatLeaseHolder,
  markSandboxFileResourcesMaterialized,
  markSandboxCheckpointArtifactDeletePending,
  markSandboxRestoreVerifying,
  markWarmLeaseInstanceLost,
  claimSandboxCheckpointArtifactsForGc,
  persistDrainSnapshot as persistDrainSnapshotRaw,
  readLease,
  readWorkspaceArchiveCapturePreflight,
  recordWarmingSandboxCreated,
  registerSandboxCheckpointArtifact,
  releaseSandboxLeaseReaperHold,
  reapStaleLeaseHolders,
  reapStaleLeaseHoldersGlobal,
  reArmDrainingLease,
  releaseWorkspaceArchiveCapture,
  releaseLeaseHolder,
  replaceWorkspaceArchiveCaptureAfterProof,
  requestDueSandboxRotationsGlobal,
  touchLeaseHolder,
  workspaceArchiveCaptureDeadlineElapsed,
  SandboxCheckpointArtifactRegistrationConflictError,
  SandboxImageConflictError,
  SandboxRigConflictError,
  settleTemporalScheduleCleanup,
  type Database,
  type DbClient,
} from "../src/index";

// The 0017 lease state machine driven through the REAL packages/db query fns
// (acquireLease/commit/release/heartbeat/reap) against a THROWAWAY postgres,
// ported from the proven spikes/lease-epoch harness. Mirrors the spike's
// assertions but exercises withWorkspaceRls/withRlsContext + real RLS:
//
//   (1) singleton under N=50 concurrency — exactly ONE spawner, refcount=50.
//   (1c) the SKIP-LOCKED counterfactual — proves plain FOR UPDATE is load-bearing
//        (a concurrent arrival under skip-locked is SKIPPED, not serialized).
//   (2) epoch fence on the HEARTBEAT path — a stale-epoch owner self-evicts and
//        does NOT refresh expires_at (the real split-brain bug, C1b).
//   (3) refcount->0 -> warm->draining (guarded turn_holders=0) -> reaper drains.
//   (4) a stale VIEWER holder is TTL-reaped while a same-age TURN holder survives.
//   (5) the SECURITY-DEFINER cross-workspace sweep selects the right rows across
//        workspaces in one pass.
//   (6) RLS isolation — opengeni_app cannot see another workspace's lease.
//
// The package fns connect as opengeni_app (a NON-superuser so FORCE RLS actually
// applies); accounts/workspaces/sessions are seeded as the postgres superuser
// (which bypasses RLS, and whose reads of the un-RLS'd workspaces/managed_accounts
// tables let rlsContextForWorkspace resolve the account). pgvector/pgvector:pg16
// because 0000_initial does CREATE EXTENSION vector. Container torn down in
// afterAll regardless of outcome.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

function archiveDescriptor(archive: string, capturedAtMs: number) {
  const bytes = Buffer.from(archive, "base64");
  const archiveSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    version: 1 as const,
    revision: `wa1:${capturedAtMs}:${archiveSha256}`,
    archiveSha256,
    archiveBytes: bytes.length,
    capturedAt: new Date(capturedAtMs).toISOString(),
    workspace: {
      algorithm: "sha256" as const,
      sha256: archiveSha256,
      entryCount: 1,
      fileCount: 1,
      totalFileBytes: bytes.length,
    },
  };
}

async function persistDrainSnapshot(
  _db: Database,
  input: Omit<Parameters<typeof persistDrainSnapshotRaw>[1], "captureId">,
): ReturnType<typeof persistDrainSnapshotRaw> {
  const captureId = crypto.randomUUID();
  const claimed = await claimWorkspaceArchiveCapture(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxGroupId,
    captureId,
    expectedEpoch: input.expectedEpoch,
    expectedInstanceId: input.expectedInstanceId,
    liveness: "draining",
    captureTimeoutMs: 60_000,
    minIntervalMs: 0,
  });
  if (claimed.status !== "claimed") {
    throw new Error(`Drain capture fixture was not admitted: ${claimed.status}`);
  }
  try {
    return await persistDrainSnapshotRaw(db, { ...input, captureId } as Parameters<
      typeof persistDrainSnapshotRaw
    >[1]);
  } finally {
    await releaseWorkspaceArchiveCapture(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sandboxGroupId: input.sandboxGroupId,
      captureId,
      expectedEpoch: input.expectedEpoch,
      expectedInstanceId: input.expectedInstanceId,
    });
  }
}

// Seed a fresh (account, workspace) as the superuser (bypasses RLS) and return
// their ids. A "session" is just a uuid here — the lease is group-keyed and the
// sandbox_group_id is a bare uuid (NOT an FK), so we don't even need a sessions
// row for the lease tables. We DO seed account + workspace because
// rlsContextForWorkspace reads workspaces.account_id.
async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
  groupId: string;
}> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id, groupId: crypto.randomUUID() };
}

// Read the raw lease row as the superuser (bypasses RLS) for assertions.
async function readRow(workspaceId: string, groupId: string) {
  const [r] = await admin`
    select liveness, refcount, turn_holders, viewer_holders, lease_epoch,
           pg_typeof(lease_epoch) as epoch_type, expires_at, instance_id
    from sandbox_leases
    where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
  return r as
    | {
        liveness: string;
        refcount: number;
        turn_holders: number;
        viewer_holders: number;
        lease_epoch: number;
        epoch_type: string;
        expires_at: Date;
        instance_id: string | null;
      }
    | undefined;
}

async function assertExpiredDrainFence(
  ids: {
    accountId: string;
    workspaceId: string;
    groupId: string;
  },
  oldEpoch: number,
  oldInstanceId: string,
  suffix: string,
): Promise<void> {
  // The successor races after the reaper has converted the attributed warming
  // row to immediately-expired draining. It must not re-arm the old provider.
  const successor = await acquireLease(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    kind: "turn",
    holderId: `successor-${suffix}`,
    backend: "modal",
    leaseTtlMs: 45_000,
  });
  expect(successor.role).toBe("fenced");
  if (successor.role === "fenced") {
    expect(successor.reason).toBe("provider_recovery_in_progress");
  }
  const [successorHolder] = await admin<{ n: number }[]>`
    select count(*)::int as n
    from sandbox_lease_holders h
    join sandbox_leases l on l.id = h.lease_id
    where l.workspace_id = ${ids.workspaceId}
      and l.sandbox_group_id = ${ids.groupId}
      and h.holder_id = ${`successor-${suffix}`}`;
  expect(successorHolder?.n).toBe(0);

  // The standalone re-arm seam honors the same attributed-drain fence.
  const explicitRearm = await reArmDrainingLease(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    leaseTtlMs: 45_000,
  });
  expect(explicitRearm.rearmed).toBe(false);

  // Late old-creator callbacks cannot commit or retire the attributed provider.
  const lateCommit = await commitWarmingToWarm(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    expectedEpoch: oldEpoch,
    instanceId: oldInstanceId,
    leaseTtlMs: 45_000,
  });
  expect(lateCommit.committed).toBe(false);
  const lateCleanup = await markWarmLeaseInstanceLost(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    expectedEpoch: oldEpoch + 1,
    expectedInstanceId: oldInstanceId,
  });
  expect(lateCleanup.status).toBe("stale");

  // Once the reaper's provider teardown settles the row, the next arrival can
  // create a new provider. A late cleanup for X remains fenced and cannot clear Y.
  const cold = await confirmDrainCold(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    expectedEpoch: oldEpoch + 1,
  });
  expect(cold.wentCold).toBe(true);
  await releaseLeaseHolder(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    kind: "turn",
    holderId: `old-${suffix}`,
    idleGraceMs: 45_000,
  });

  const next = await acquireLease(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    kind: "turn",
    holderId: `successor-after-${suffix}`,
    backend: "modal",
    leaseTtlMs: 45_000,
  });
  expect(next.role).toBe("spawner");
  // Expiry attribution fences the old creator with the first bump; confirmed
  // provider teardown/cold settlement owns the second bump before re-election.
  expect(next.lease.leaseEpoch).toBe(oldEpoch + 2);
  const nextCommit = await commitWarmingToWarm(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    expectedEpoch: next.lease.leaseEpoch,
    instanceId: "successor-provider",
    leaseTtlMs: 45_000,
  });
  expect(nextCommit.committed).toBe(true);
  // Publishing the successor warming lease is the third and final bump: after
  // expiry attribution and confirmed provider teardown, it fences any stale
  // warming callbacks from the now-live replacement.
  expect(nextCommit.lease?.leaseEpoch).toBe(oldEpoch + 3);
  const lateCleanupAfterSuccessor = await markWarmLeaseInstanceLost(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    expectedEpoch: oldEpoch + 1,
    expectedInstanceId: oldInstanceId,
  });
  expect(lateCleanupAfterSuccessor.status).toBe("stale");
  const final = await readRow(ids.workspaceId, ids.groupId);
  expect(final?.liveness).toBe("warm");
  expect(final?.lease_epoch).toBe(oldEpoch + 3);
  expect(final?.instance_id).toBe("successor-provider");
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("sandbox-leases");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[sandbox-leases] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

describe("0017 sandbox lease state machine (real packages/db + RLS)", () => {
  test("(0-delete) workspace deletion atomically refuses live leases and returns durable schedule cleanup ids", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const [{ id: siblingWorkspaceId } = { id: "" }] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${accountId}, 'sibling')
      returning id`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${siblingWorkspaceId}, ${accountId})`;
    const temporalScheduleId = `workspace-delete-${crypto.randomUUID()}`;
    await admin`
      insert into scheduled_tasks (
        account_id, workspace_id, name, schedule, temporal_schedule_id, agent_config
      ) values (
        ${accountId}, ${workspaceId}, 'delete fixture',
        ${admin.json({ type: "interval", everySeconds: 60 })},
        ${temporalScheduleId},
        ${admin.json({ prompt: "fixture", resources: [], tools: [], metadata: {} })}
      )`;

    const warming = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "workspace-delete-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(warming.role).toBe("spawner");
    expect(await deleteWorkspaceIfQuiescent(db, { accountId, workspaceId })).toEqual({
      status: "live_sandboxes",
    });

    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "workspace-delete-owner",
      idleGraceMs: 0,
    });
    await failWarmingToCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: warming.lease.leaseEpoch,
    });

    // These are nonterminal execution states too. Deletion must not erase the
    // recoverable turn merely because it is between worker attempts or waiting
    // for provider capacity.
    const recoveringSessionId = crypto.randomUUID();
    await admin`
      insert into sessions (
        id, account_id, workspace_id, status, initial_message, model,
        sandbox_backend, sandbox_group_id, temporal_workflow_id, tool_policy
      ) values (
        ${recoveringSessionId}, ${accountId}, ${workspaceId}, 'recovering',
        'workspace deletion fixture', 'test-model', 'modal', ${recoveringSessionId},
        ${`session-${recoveringSessionId}`},
        jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
      )`;
    expect(await deleteWorkspaceIfQuiescent(db, { accountId, workspaceId })).toEqual({
      status: "active_sessions",
    });
    await admin`
      update sessions set status = 'waiting_capacity' where id = ${recoveringSessionId}`;
    expect(await deleteWorkspaceIfQuiescent(db, { accountId, workspaceId })).toEqual({
      status: "active_sessions",
    });
    await admin`update sessions set status = 'idle' where id = ${recoveringSessionId}`;

    // Aggregate counters are projections. A raw ownership receipt must still
    // fence deletion even if those counters are corrupt/stale at zero.
    const rawHolderId = crypto.randomUUID();
    await admin`
      insert into sandbox_lease_holders (
        account_id, workspace_id, lease_id, kind, holder_id
      ) values (
        ${accountId}, ${workspaceId}, ${warming.lease.id}, 'direct', ${rawHolderId}
      )`;
    expect(await deleteWorkspaceIfQuiescent(db, { accountId, workspaceId })).toEqual({
      status: "live_sandboxes",
    });
    await admin`
      delete from sandbox_lease_holders
      where lease_id = ${warming.lease.id} and holder_id = ${rawHolderId}`;

    // A provider/admission transaction can already own the lease while waiting
    // for this workspace's FK parent. Deletion must refuse immediately instead
    // of creating a parent->child / child->parent deadlock.
    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const acquiredLock = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const releaseHeldLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = admin.begin(async (tx) => {
      await tx`select id from sandbox_leases where id = ${warming.lease.id} for update`;
      lockAcquired();
      await releaseHeldLock;
    });
    await acquiredLock;
    try {
      const startedAt = Date.now();
      expect(await deleteWorkspaceIfQuiescent(db, { accountId, workspaceId })).toEqual({
        status: "live_sandboxes",
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      releaseLock();
      await blocker;
    }

    const deleted = await deleteWorkspaceIfQuiescent(db, { accountId, workspaceId });
    expect(deleted.status).toBe("deleted");
    if (deleted.status !== "deleted") throw new Error("workspace deletion did not commit");
    const cleanup = deleted.temporalScheduleCleanups[0];
    if (!cleanup) throw new Error("workspace deletion omitted its Temporal cleanup receipt");
    expect(cleanup).toEqual({
      id: cleanup.id,
      accountId,
      workspaceId,
      temporalScheduleId,
      claimId: cleanup.claimId,
      attemptCount: 1,
    });
    expect(cleanup.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(cleanup.claimId).toMatch(/^[0-9a-f-]{36}$/);
    const [workspaceCount] = await admin<{ count: number }[]>`
      select count(*)::int as count from workspaces where id = ${workspaceId}`;
    const [scheduleCount] = await admin<{ count: number }[]>`
      select count(*)::int as count from scheduled_tasks where workspace_id = ${workspaceId}`;
    expect(workspaceCount?.count).toBe(0);
    expect(scheduleCount?.count).toBe(0);

    // The receipt intentionally survives the workspace FK cascade. A stale
    // process cannot settle it; a failed exact owner releases it, and another
    // replica can immediately reclaim the same external schedule.
    const [cleanupCount] = await admin<{ count: number }[]>`
      select count(*)::int as count
      from temporal_schedule_cleanup_outbox where id = ${cleanup.id}`;
    expect(cleanupCount?.count).toBe(1);
    expect(
      await settleTemporalScheduleCleanup(db, {
        id: cleanup.id,
        claimId: crypto.randomUUID(),
      }),
    ).toBe(false);
    expect(
      await settleTemporalScheduleCleanup(db, {
        id: cleanup.id,
        claimId: cleanup.claimId,
        error: "simulated Temporal outage",
      }),
    ).toBe(true);
    await admin`
      update temporal_schedule_cleanup_outbox
      set next_attempt_at = now() - interval '1 second'
      where id = ${cleanup.id}`;
    const successorClaimId = crypto.randomUUID();
    const reclaimed = await claimTemporalScheduleCleanups(db, {
      claimId: successorClaimId,
      limit: 1,
      claimSeconds: 15,
    });
    expect(reclaimed).toEqual([
      {
        id: cleanup.id,
        accountId,
        workspaceId,
        temporalScheduleId,
        claimId: successorClaimId,
        attemptCount: 2,
      },
    ]);
    expect(
      await settleTemporalScheduleCleanup(db, {
        id: cleanup.id,
        claimId: successorClaimId,
      }),
    ).toBe(true);
  }, 60_000);

  test("(0) lease_epoch is an integer column returning a JS number (the spike C1a fix)", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "t0",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    const row = await readRow(workspaceId, groupId);
    expect(row?.epoch_type).toBe("integer");
    expect(typeof row?.lease_epoch).toBe("number");
  }, 60_000);

  test("(0-constraint) archive capture receipts cannot be partially populated through SQL NULL semantics", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "partial-capture-constraint",
      backend: "modal",
      leaseTtlMs: 45_000,
    });

    const captureId = crypto.randomUUID();
    await admin`
      update sandbox_leases set
        archive_capture_id = ${captureId}::uuid,
        archive_capture_generation = workspace_generation,
        archive_capture_started_at = now(),
        archive_capture_deadline_at = now() + interval '1 minute'
      where workspace_id = ${workspaceId}
        and sandbox_group_id = ${groupId}`;

    const corruptions = [
      () => admin`
        update sandbox_leases set archive_capture_operation_id = null
        where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`,
      () => admin`
        update sandbox_leases set archive_capture_provider_request_id = null
        where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`,
      () => admin`
        update sandbox_leases set archive_capture_attempt = null
        where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`,
      () => admin`
        update sandbox_leases set archive_capture_generation = null
        where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`,
      () => admin`
        update sandbox_leases set archive_capture_started_at = null
        where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`,
      () => admin`
        update sandbox_leases set archive_capture_deadline_at = null
        where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`,
    ];
    for (const corrupt of corruptions) {
      let failure: unknown;
      try {
        await corrupt();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "23514" });
    }

    await admin`
      update sandbox_leases set
        archive_capture_id = null,
        archive_capture_generation = null,
        archive_capture_started_at = null,
        archive_capture_deadline_at = null
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;

    let rotationFailure: unknown;
    try {
      await admin`
        update sandbox_leases set rotation_requested_at = now(), rotation_reason = null
        where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    } catch (error) {
      rotationFailure = error;
    }
    expect(rotationFailure).toMatchObject({ code: "23514" });

    const [lease] = await admin<
      Array<{ archive_capture_id: string | null; rotation_requested_at: Date | null }>
    >`
      select archive_capture_id, rotation_requested_at from sandbox_leases
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(lease?.archive_capture_id).toBeNull();
    expect(lease?.rotation_requested_at).toBeNull();
  }, 60_000);

  test("(0a) maintenance fence rejects markerless legacy transitions and acquisition inserts", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await admin`
      insert into sandbox_leases
        (account_id, workspace_id, sandbox_group_id, liveness, backend, expires_at)
      values
        (${accountId}, ${workspaceId}, ${groupId}, 'cold', 'modal', now() + interval '60 seconds')
    `;
    const legacy = postgres(shared!.appUrl, { max: 1 });
    try {
      await expect(
        legacy.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
          await tx`
            update sandbox_leases
            set liveness = 'warming'
            where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}
          `;
        }),
      ).rejects.toMatchObject({ code: "55000" });

      // Exact origin/main acquireLease shape: PostgreSQL runs BEFORE INSERT
      // triggers before ON CONFLICT resolution, so an old pod cannot even
      // acquire an existing row after maintenance activation.
      await expect(
        legacy.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
          await tx`
            insert into sandbox_leases
              (account_id, workspace_id, sandbox_group_id, liveness, backend, expires_at)
            values
              (${accountId}, ${workspaceId}, ${groupId}, 'cold', 'modal', now() + interval '60 seconds')
            on conflict (workspace_id, sandbox_group_id) do nothing
          `;
        }),
      ).rejects.toMatchObject({ code: "55000" });

      await expect(
        legacy.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
          await tx`
            insert into sandbox_leases
              (account_id, workspace_id, sandbox_group_id, liveness, backend, expires_at)
            values
              (${accountId}, ${workspaceId}, ${crypto.randomUUID()}, 'cold', 'modal', now() + interval '60 seconds')
          `;
        }),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await legacy.end();
    }

    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "protocol-v1-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
  }, 60_000);

  test("(1) N=50 concurrent cold acquires -> exactly ONE spawner, 49 attached, refcount=50, warming", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        acquireLease(db, {
          accountId,
          workspaceId,
          sandboxGroupId: groupId,
          kind: "viewer",
          holderId: `v-${i}`,
          backend: "modal",
          leaseTtlMs: 45_000,
        }),
      ),
    );
    const spawners = results.filter((r) => r.role === "spawner").length;
    const attached = results.filter((r) => r.role === "attached").length;
    expect(spawners).toBe(1);
    expect(attached).toBe(N - 1);
    const row = await readRow(workspaceId, groupId);
    expect(row?.refcount).toBe(N);
    expect(row?.liveness).toBe("warming");
  }, 60_000);

  test("(1b) cold->warming stamps the warming budget, so slow creates are not 90s-reaped", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "slow-spawner",
      backend: "modal",
      leaseTtlMs: 90_000,
      warmingLeaseTtlMs: 600_000,
    });
    expect(acquired.role).toBe("spawner");

    const stamped = await readRow(workspaceId, groupId);
    expect(stamped?.liveness).toBe("warming");
    expect(stamped?.expires_at.getTime()).toBeGreaterThan(Date.now() + 300_000);

    // Simulate a spawner that has already spent longer than the normal 90s
    // holder TTL but is still inside the 600s warming budget. The warming-death
    // reaper must leave it warming instead of resetting it to cold.
    await admin`
      update sandbox_leases
      set expires_at = now() + interval '300 seconds'
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}
    `;
    const reap = await reapStaleLeaseHolders(db, {
      workspaceId,
      viewerHolderTtlMs: 90_000,
      idleGraceMs: 45_000,
    });
    expect(reap.warmingReset).toBe(0);
    const after = await readRow(workspaceId, groupId);
    expect(after?.liveness).toBe("warming");
    expect(after?.instance_id).toBeNull();
  }, 60_000);

  test("(1b-2) pre-create timeout advances epoch, preserves the selected archive, and fences late callbacks", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const archive = Buffer.from("pre-create-timeout-archive").toString("base64");
    const archiveHash = "d".repeat(64);
    const descriptor = {
      version: 1 as const,
      revision: `wa1:1900000001000:${archiveHash}`,
      archiveSha256: archiveHash,
      archiveBytes: Buffer.from(archive, "base64").length,
      capturedAt: "2030-03-17T17:46:41.000Z",
      workspace: {
        algorithm: "sha256" as const,
        sha256: "e".repeat(64),
        entryCount: 2,
        fileCount: 1,
        totalFileBytes: 31,
      },
    };
    const first = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "expired-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(first.role).toBe("spawner");
    const firstAttempt = crypto.randomUUID();
    const begun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      rematerializationId: firstAttempt,
      archiveSource: {
        backendId: "modal",
        sessionState: { workspaceArchive: archive, workspaceArchiveMeta: descriptor },
      },
    });
    expect(begun.status).toBe("started");
    if (begun.status === "started") {
      expect(begun.lease.archiveComplete).toBe(true);
      expect(begun.lease.archiveGeneration).toBe(begun.lease.workspaceGeneration);
    }
    await admin`
      update sandbox_leases
      set expires_at = now() - interval '1 second'
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}
    `;

    await reapStaleLeaseHoldersGlobal(db, {
      viewerHolderTtlMs: 90_000,
      turnHolderTtlMs: 0,
      idleGraceMs: 45_000,
    });
    const reset = await readLease(db, workspaceId, groupId);
    expect(reset).toMatchObject({
      liveness: "cold",
      leaseEpoch: 1,
      instanceId: null,
      recovery: {
        archive: { status: "available", current: { revision: descriptor.revision } },
        restore: { status: "pending", rematerializationId: null },
        workspace: { status: "not_ready" },
      },
    });
    expect(
      (reset?.resumeState?.sessionState as Record<string, unknown> | undefined)?.workspaceArchive,
    ).toBe(archive);

    const successor = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "successor-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(successor.role).toBe("spawner");
    expect(successor.lease.leaseEpoch).toBe(1);
    const successorAttempt = crypto.randomUUID();
    const successorBegun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 1,
      rematerializationId: successorAttempt,
    });
    expect(successorBegun.status).toBe("started");

    const staleEpoch = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      rematerializationId: firstAttempt,
      instanceId: "late-old-box",
      leaseTtlMs: 45_000,
    });
    expect(staleEpoch.recorded).toBe(false);
    const wrongAttempt = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 1,
      rematerializationId: firstAttempt,
      instanceId: "wrong-attempt-box",
      leaseTtlMs: 45_000,
    });
    expect(wrongAttempt.recorded).toBe(false);
    const attributed = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 1,
      rematerializationId: successorAttempt,
      instanceId: "successor-box",
      resumeBackendId: "modal",
      resumeState: { backendId: "modal" },
      leaseTtlMs: 45_000,
    });
    expect(attributed.recorded).toBe(true);
    expect(attributed.lease?.instanceId).toBe("successor-box");
    expect(attributed.lease?.recovery.archive.current?.revision).toBe(descriptor.revision);
  }, 60_000);

  test("(1b-3) workspace-scoped warming reset preserves the same archive/epoch invariant", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const archive = Buffer.from("scoped-timeout-archive").toString("base64");
    const archiveHash = "f".repeat(64);
    const descriptor = {
      version: 1 as const,
      revision: `wa1:1900000002000:${archiveHash}`,
      archiveSha256: archiveHash,
      archiveBytes: Buffer.from(archive, "base64").length,
      capturedAt: "2030-03-17T17:46:42.000Z",
      workspace: {
        algorithm: "sha256" as const,
        sha256: "1".repeat(64),
        entryCount: 1,
        fileCount: 1,
        totalFileBytes: 29,
      },
    };
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "scoped-expired-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    const attempt = crypto.randomUUID();
    const begun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      rematerializationId: attempt,
      archiveSource: {
        backendId: "modal",
        sessionState: { workspaceArchive: archive, workspaceArchiveMeta: descriptor },
      },
    });
    expect(begun.status).toBe("started");
    if (begun.status === "started") {
      expect(begun.lease.archiveComplete).toBe(true);
      expect(begun.lease.archiveGeneration).toBe(begun.lease.workspaceGeneration);
    }
    await admin`
      update sandbox_leases
      set expires_at = now() - interval '1 second'
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}
    `;
    const reaped = await reapStaleLeaseHolders(db, {
      workspaceId,
      viewerHolderTtlMs: 90_000,
      turnHolderTtlMs: 0,
      idleGraceMs: 45_000,
    });
    expect(reaped.warmingReset).toBe(1);
    const reset = await readLease(db, workspaceId, groupId);
    expect(reset).toMatchObject({
      liveness: "cold",
      leaseEpoch: 1,
      recovery: {
        archive: { status: "available", current: { revision: descriptor.revision } },
        restore: { status: "pending", rematerializationId: null },
      },
    });
    expect(
      (reset?.resumeState?.sessionState as Record<string, unknown> | undefined)?.workspaceArchive,
    ).toBe(archive);
    const late = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      rematerializationId: attempt,
      instanceId: "late-scoped-box",
      leaseTtlMs: 45_000,
    });
    expect(late.recorded).toBe(false);
  }, 60_000);

  test("(1b-4) a retryable degraded restore can elect one new rematerialization attempt", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const archive = Buffer.from("retryable-restore-archive").toString("base64");
    const archiveHash = "a".repeat(64);
    const descriptor = {
      version: 1 as const,
      revision: `wa1:1900000003000:${archiveHash}`,
      archiveSha256: archiveHash,
      archiveBytes: Buffer.from(archive, "base64").length,
      capturedAt: "2030-03-17T17:46:43.000Z",
      workspace: {
        algorithm: "sha256" as const,
        sha256: "b".repeat(64),
        entryCount: 3,
        fileCount: 2,
        totalFileBytes: 41,
      },
    };
    const first = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "first-restore",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(first.role).toBe("spawner");
    const firstAttempt = crypto.randomUUID();
    const begun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: first.lease.leaseEpoch,
      rematerializationId: firstAttempt,
      archiveSource: {
        backendId: "modal",
        sessionState: { workspaceArchive: archive, workspaceArchiveMeta: descriptor },
      },
    });
    expect(begun.status).toBe("started");

    const failed = await failSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: first.lease.leaseEpoch,
      rematerializationId: firstAttempt,
      failureCode: "workspace_fingerprint_unavailable",
      retryable: true,
    });
    expect(failed.failed).toBe(true);
    expect(failed.lease).toMatchObject({
      liveness: "cold",
      recovery: {
        archive: { status: "available", current: { revision: descriptor.revision } },
        restore: {
          status: "degraded",
          failureCode: "workspace_fingerprint_unavailable",
          retryable: true,
        },
      },
    });

    const successor = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "second-restore",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(successor.role).toBe("spawner");
    expect(successor.lease.leaseEpoch).toBe(first.lease.leaseEpoch + 1);

    const successorAttempt = crypto.randomUUID();
    const successorBegun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: successor.lease.leaseEpoch,
      rematerializationId: successorAttempt,
    });
    expect(successorBegun.status).toBe("started");
    if (successorBegun.status === "started") {
      expect(successorBegun.lease.recovery.restore).toMatchObject({
        status: "restoring",
        rematerializationId: successorAttempt,
        selectedRevision: descriptor.revision,
      });
      expect(successorBegun.lease.archiveComplete).toBe(true);
    }
  }, 60_000);

  test("(1d) invalidated warming epochs fence a late create and its cleanup from a successor", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();

    const old = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "old-create",
      backend: "modal",
      leaseTtlMs: 45_000,
      warmingLeaseTtlMs: 600_000,
    });
    expect(old.role).toBe("spawner");
    expect(old.lease.leaseEpoch).toBe(0);

    // The provider create is still unresolved. Rollback closes epoch 0 before
    // the next acquisition is allowed to spawn.
    await failWarmingToCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: old.lease.leaseEpoch,
    });
    const afterRollback = await readRow(workspaceId, groupId);
    expect(afterRollback?.liveness).toBe("cold");
    expect(afterRollback?.lease_epoch).toBe(1);

    const successor = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "successor-create",
      backend: "modal",
      leaseTtlMs: 45_000,
      warmingLeaseTtlMs: 600_000,
    });
    expect(successor.role).toBe("spawner");
    expect(successor.lease.leaseEpoch).toBe(1);

    // Late old callbacks all carry epoch 0. None may attribute the old provider,
    // commit it, roll back the successor, or clear the successor's provider.
    const lateRecord = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "old-provider",
      resumeBackendId: "modal",
      leaseTtlMs: 45_000,
    });
    expect(lateRecord.recorded).toBe(false);
    const lateCommit = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "old-provider",
      leaseTtlMs: 45_000,
    });
    expect(lateCommit.committed).toBe(false);
    await failWarmingToCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
    });

    const successorCommit = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: successor.lease.leaseEpoch,
      instanceId: "successor-provider",
      leaseTtlMs: 45_000,
    });
    expect(successorCommit.committed).toBe(true);

    // This mirrors the old verifier's cleanup pair: mark the old instance at
    // oldEpoch+1 and fail oldEpoch. Both remain fenced after successor commit.
    const lateCleanup = await markWarmLeaseInstanceLost(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 1,
      expectedInstanceId: "old-provider",
    });
    expect(lateCleanup.status).toBe("stale");
    const final = await readRow(workspaceId, groupId);
    expect(final?.liveness).toBe("warm");
    expect(final?.lease_epoch).toBe(2);
    expect(final?.instance_id).toBe("successor-provider");
  }, 60_000);

  test("(1e) the global warming-death reaper advances the epoch before retry", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const old = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "expired-create",
      backend: "modal",
      leaseTtlMs: 45_000,
      warmingLeaseTtlMs: 600_000,
    });
    expect(old.role).toBe("spawner");
    await admin`
      update sandbox_leases
      set expires_at = now() - interval '1 second'
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;

    const drained = await reapStaleLeaseHoldersGlobal(db, {
      viewerHolderTtlMs: 90_000,
      turnHolderTtlMs: 0,
      idleGraceMs: 45_000,
    });
    expect(drained.some((row) => row.sandboxGroupId === groupId)).toBe(false);
    const reset = await readRow(workspaceId, groupId);
    expect(reset?.liveness).toBe("cold");
    expect(reset?.lease_epoch).toBe(old.lease.leaseEpoch + 1);

    const successor = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "retry-create",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(successor.role).toBe("spawner");
    expect(successor.lease.leaseEpoch).toBe(old.lease.leaseEpoch + 1);
    const lateRecord = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: old.lease.leaseEpoch,
      instanceId: "late-expired-provider",
      leaseTtlMs: 45_000,
    });
    expect(lateRecord.recorded).toBe(false);
  }, 60_000);

  test("(1f) local post-create expiry fences a successor re-arm and late cleanup", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    const old = await acquireLease(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      kind: "turn",
      holderId: "old-local",
      backend: "modal",
      leaseTtlMs: 45_000,
      warmingLeaseTtlMs: 600_000,
    });
    expect(old.role).toBe("spawner");
    const recorded = await recordWarmingSandboxCreated(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      expectedEpoch: old.lease.leaseEpoch,
      instanceId: "old-provider-local",
      resumeBackendId: "modal",
      leaseTtlMs: 45_000,
      warmingLeaseTtlMs: 600_000,
    });
    expect(recorded.recorded).toBe(true);
    await admin`
      update sandbox_leases set expires_at = now() - interval '1 second'
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.groupId}`;

    const reaped = await reapStaleLeaseHolders(db, {
      workspaceId: ids.workspaceId,
      viewerHolderTtlMs: 90_000,
      idleGraceMs: 45_000,
    });
    expect(reaped.drained).toEqual([
      expect.objectContaining({
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.groupId,
        instanceId: "old-provider-local",
        leaseEpoch: old.lease.leaseEpoch + 1,
      }),
    ]);
    const draining = await readRow(ids.workspaceId, ids.groupId);
    expect(draining?.liveness).toBe("draining");
    expect(draining?.instance_id).toBe("old-provider-local");
    expect(draining?.lease_epoch).toBe(old.lease.leaseEpoch + 1);
    await assertExpiredDrainFence(ids, old.lease.leaseEpoch, "old-provider-local", "local");
  }, 60_000);

  test("(1g) global post-create expiry fences a successor re-arm and late cleanup", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    const old = await acquireLease(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      kind: "turn",
      holderId: "old-global",
      backend: "modal",
      leaseTtlMs: 45_000,
      warmingLeaseTtlMs: 600_000,
    });
    expect(old.role).toBe("spawner");
    const recorded = await recordWarmingSandboxCreated(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      expectedEpoch: old.lease.leaseEpoch,
      instanceId: "old-provider-global",
      resumeBackendId: "modal",
      leaseTtlMs: 45_000,
      warmingLeaseTtlMs: 600_000,
    });
    expect(recorded.recorded).toBe(true);
    await admin`
      update sandbox_leases set expires_at = now() - interval '1 second'
      where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.groupId}`;

    const drained = await reapStaleLeaseHoldersGlobal(db, {
      viewerHolderTtlMs: 90_000,
      turnHolderTtlMs: 0,
      idleGraceMs: 45_000,
    });
    expect(
      drained.some(
        (row) =>
          row.workspaceId === ids.workspaceId &&
          row.sandboxGroupId === ids.groupId &&
          row.instanceId === "old-provider-global" &&
          row.leaseEpoch === old.lease.leaseEpoch + 1,
      ),
    ).toBe(true);
    const draining = await readRow(ids.workspaceId, ids.groupId);
    expect(draining?.liveness).toBe("draining");
    expect(draining?.instance_id).toBe("old-provider-global");
    expect(draining?.lease_epoch).toBe(old.lease.leaseEpoch + 1);
    await assertExpiredDrainFence(ids, old.lease.leaseEpoch, "old-provider-global", "global");
  }, 60_000);

  test("(1c) SKIP-LOCKED counterfactual: a concurrent arrival is SKIPPED (no row), proving plain FOR UPDATE is load-bearing", async () => {
    if (!available) return;
    // Pre-create + COMMIT a cold lease row (as the superuser), then contend on it
    // with FOR UPDATE SKIP LOCKED. One txn holds the row lock through a sleep; the
    // sibling's skip-locked select returns ZERO rows (it neither serializes nor
    // attaches). This is exactly what plain FOR UPDATE (the production path)
    // PREVENTS — there the sibling blocks and then attaches. Same harness, one
    // query word changed, opposite outcome.
    const { workspaceId, groupId, accountId } = await freshWorkspace();
    await admin`
      insert into sandbox_leases (account_id, workspace_id, sandbox_group_id, liveness, backend, expires_at)
      values (${accountId}, ${workspaceId}, ${groupId}, 'cold', 'modal', now() + interval '60s')`;

    async function skipLockedAcquire(): Promise<"spawner" | "skipped-no-row" | "attached"> {
      return (await admin.begin(async (tx) => {
        const rows = await tx`
          select * from sandbox_leases
          where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}
          for update skip locked`;
        await tx`select pg_sleep(0.25)`;
        if (rows.length === 0) return "skipped-no-row";
        const row = rows[0] as { id: string; liveness: string };
        if (row.liveness === "cold") {
          await tx`update sandbox_leases set liveness='warming' where id=${row.id} and liveness='cold'`;
          return "spawner";
        }
        return "attached";
      })) as "spawner" | "skipped-no-row" | "attached";
    }

    const [a, b] = await Promise.all([skipLockedAcquire(), skipLockedAcquire()]);
    const outcomes = [a, b];
    // One wins the lock; the other is SKIPPED (gets no row) — the load-bearing
    // failure plain FOR UPDATE avoids.
    expect(outcomes).toContain("skipped-no-row");
    expect(outcomes.filter((o) => o === "spawner").length).toBe(1);

    // And the production path (plain FOR UPDATE via acquireLease) on a FRESH group
    // never skips: two concurrent arrivals -> 1 spawner + 1 attached, both on one row.
    const fresh = await freshWorkspace();
    const [r1, r2] = await Promise.all([
      acquireLease(db, {
        accountId: fresh.accountId,
        workspaceId: fresh.workspaceId,
        sandboxGroupId: fresh.groupId,
        kind: "turn",
        holderId: "A",
        backend: "modal",
        leaseTtlMs: 45_000,
      }),
      acquireLease(db, {
        accountId: fresh.accountId,
        workspaceId: fresh.workspaceId,
        sandboxGroupId: fresh.groupId,
        kind: "turn",
        holderId: "B",
        backend: "modal",
        leaseTtlMs: 45_000,
      }),
    ]);
    const roles = [r1.role, r2.role].sort();
    expect(roles).toEqual(["attached", "spawner"]);
    const row = await readRow(fresh.workspaceId, fresh.groupId);
    expect(row?.refcount).toBe(2);
  }, 60_000);

  test("(2) epoch fence on the HEARTBEAT path: a stale-epoch owner self-evicts and does NOT refresh expires_at", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    // S1 acquires (spawner) then commits warming->warm at expectedEpoch 0 -> epoch 1.
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "turn-1",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    const c1 = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "box-s1",
      leaseTtlMs: 45_000,
    });
    expect(c1.committed).toBe(true);
    const s1Epoch = c1.lease!.leaseEpoch;
    expect(s1Epoch).toBe(1);

    // Baseline: S1 heartbeat at its OWN epoch succeeds.
    const ok = await heartbeatLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "turn-1",
      leaseTtlMs: 45_000,
      expectedEpoch: s1Epoch,
    });
    expect(ok).toBe(true);

    // Re-election: force back to warming and re-commit -> epoch 2 (S2 owns it).
    await admin`update sandbox_leases set liveness='warming'
                where workspace_id=${workspaceId} and sandbox_group_id=${groupId}`;
    const c2 = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: s1Epoch,
      instanceId: "box-s2",
      leaseTtlMs: 45_000,
    });
    const s2Epoch = c2.lease!.leaseEpoch;
    expect(s2Epoch).toBe(s1Epoch + 1);

    // THE SPLIT-BRAIN TEST: stale owner S1 heartbeats with its OLD epoch.
    const beforeExp = (
      await admin`select expires_at from sandbox_leases where workspace_id=${workspaceId} and sandbox_group_id=${groupId}`
    )[0] as { expires_at: Date };
    const staleAccepted = await heartbeatLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "turn-1",
      leaseTtlMs: 999_000,
      expectedEpoch: s1Epoch,
    });
    const afterExp = (
      await admin`select expires_at, lease_epoch from sandbox_leases where workspace_id=${workspaceId} and sandbox_group_id=${groupId}`
    )[0] as { expires_at: Date; lease_epoch: number };
    expect(staleAccepted).toBe(false); // rejected -> S1 self-evicts
    expect(new Date(afterExp.expires_at).getTime()).toBe(new Date(beforeExp.expires_at).getTime()); // NOT refreshed
    expect(afterExp.lease_epoch).toBe(s2Epoch); // epoch unchanged by stale HB

    // The CURRENT owner S2 can heartbeat at the live epoch.
    const freshAccepted = await heartbeatLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "turn-1",
      leaseTtlMs: 45_000,
      expectedEpoch: s2Epoch,
    });
    expect(freshAccepted).toBe(true);
  }, 60_000);

  test("(2a) a rotation-fenced heartbeat preserves its live holder without extending the lease", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "turn-rotating",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "box-rotating",
      leaseTtlMs: 45_000,
    });
    const epoch = committed.lease!.leaseEpoch;
    await admin.begin(async (tx) => {
      await tx`
        update sandbox_leases set
          rotation_requested_at = now(),
          rotation_reason = 'operator'
        where workspace_id = ${workspaceId}
          and sandbox_group_id = ${groupId}`;
      await tx`
        update sandbox_lease_holders set
          last_heartbeat_at = now() - interval '1 hour'
        where workspace_id = ${workspaceId}
          and lease_id = ${committed.lease!.id}
          and kind = 'turn'
          and holder_id = 'turn-rotating'`;
    });
    const [before] = await admin<Array<{ expires_at: Date; last_heartbeat_at: Date }>>`
      select lease.expires_at, holder.last_heartbeat_at
      from sandbox_leases lease
      join sandbox_lease_holders holder on holder.lease_id = lease.id
      where lease.workspace_id = ${workspaceId}
        and lease.sandbox_group_id = ${groupId}
        and holder.kind = 'turn'
        and holder.holder_id = 'turn-rotating'`;

    expect(
      await heartbeatLeaseHolder(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        kind: "turn",
        holderId: "turn-rotating",
        leaseTtlMs: 999_000,
        expectedEpoch: epoch,
      }),
    ).toBe(false);

    const [after] = await admin<Array<{ expires_at: Date; last_heartbeat_at: Date }>>`
      select lease.expires_at, holder.last_heartbeat_at
      from sandbox_leases lease
      join sandbox_lease_holders holder on holder.lease_id = lease.id
      where lease.workspace_id = ${workspaceId}
        and lease.sandbox_group_id = ${groupId}
        and holder.kind = 'turn'
        and holder.holder_id = 'turn-rotating'`;
    expect(after?.last_heartbeat_at.getTime()).toBeGreaterThan(
      before?.last_heartbeat_at.getTime() ?? 0,
    );
    expect(after?.expires_at.getTime()).toBe(before?.expires_at.getTime());
  }, 60_000);

  test("(2b) canonical turn heartbeats stop when the exact attempt ownership closes", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const sessionId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const holderId = `turn-attempt:${attemptId}`;

    await admin`
      insert into sessions (
        id, account_id, workspace_id, status, initial_message, model,
        sandbox_backend, sandbox_group_id, temporal_workflow_id, tool_policy
      ) values (
        ${sessionId}, ${accountId}, ${workspaceId}, 'running',
        'lease heartbeat fixture', 'test-model', 'modal', ${groupId},
        ${`session-${sessionId}`},
        jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
      )`;
    await admin`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, source, position, prompt, resources,
        tools, model, reasoning_effort, sandbox_backend, metadata, lineage,
        execution_generation
      ) values (
        ${turnId}, ${accountId}, ${workspaceId}, ${sessionId},
        ${crypto.randomUUID()}, ${`session-${sessionId}`}, 'running', 'user',
        1, 'lease heartbeat fixture', '[]'::jsonb, '[]'::jsonb,
        'test-model', 'low', 'modal', '{}'::jsonb, '{}'::jsonb, 1
      )`;
    await admin`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id,
        execution_generation, state, temporal_workflow_id,
        temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${accountId}, ${workspaceId}, ${sessionId}, ${turnId},
        1, 'running', ${`session-${sessionId}`}, ${crypto.randomUUID()}, '2',
        0, '{}'::jsonb
      )`;
    await admin`
      update session_turns set active_attempt_id = ${attemptId}
      where workspace_id = ${workspaceId} and id = ${turnId}`;

    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId,
      subjectId: sessionId,
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "box-exact-attempt",
      leaseTtlMs: 45_000,
    });
    const epoch = committed.lease!.leaseEpoch;
    expect(
      await heartbeatLeaseHolder(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        kind: "turn",
        holderId,
        leaseTtlMs: 45_000,
        expectedEpoch: epoch,
      }),
    ).toBe(true);

    await admin.begin(async (tx) => {
      await tx`
        update session_turn_attempts set
          state = 'closed', outcome = 'interrupted_recoverable',
          closed_at = now(), quiesced_at = now(), updated_at = now()
        where id = ${attemptId}`;
      await tx`
        update session_turns set
          status = 'recovering', active_attempt_id = null, updated_at = now()
        where workspace_id = ${workspaceId} and id = ${turnId}`;
      await tx`
        update sandbox_lease_holders set
          last_heartbeat_at = now() - interval '1 hour'
        where holder_id = ${holderId}`;
    });
    const [before] = await admin<{ heartbeat: Date }[]>`
      select last_heartbeat_at as heartbeat
      from sandbox_lease_holders where holder_id = ${holderId}`;

    expect(
      await touchLeaseHolder(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        kind: "turn",
        holderId,
      }),
    ).toBe(false);
    expect(
      await heartbeatLeaseHolder(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        kind: "turn",
        holderId,
        leaseTtlMs: 45_000,
        expectedEpoch: epoch,
      }),
    ).toBe(false);
    const [after] = await admin<{ heartbeat: Date }[]>`
      select last_heartbeat_at as heartbeat
      from sandbox_lease_holders where holder_id = ${holderId}`;
    expect(after?.heartbeat.getTime()).toBe(before?.heartbeat.getTime());
  }, 60_000);

  test("(2c) file materialization markers are keyed by warm box instance and epoch", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "turn-files",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "box-files-1",
      leaseTtlMs: 45_000,
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "box-files-1" } },
      },
    });
    const epoch = committed.lease!.leaseEpoch;

    expect(
      await getMaterializedSandboxFileResources(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        instanceId: "box-files-1",
      }),
    ).toEqual(new Set());

    expect(
      await markSandboxFileResourcesMaterialized(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        instanceId: "box-files-1",
        fileIds: ["file-a", "file-b", "file-a"],
      }),
    ).toEqual({ wrote: true });
    expect(
      await markSandboxFileResourcesMaterialized(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        instanceId: "box-files-1",
        fileIds: ["file-c"],
      }),
    ).toEqual({ wrote: true });

    expect(
      await getMaterializedSandboxFileResources(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        instanceId: "box-files-1",
      }),
    ).toEqual(new Set(["file-a", "file-b", "file-c"]));
    expect(
      await markSandboxFileResourcesMaterialized(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch - 1,
        instanceId: "box-files-1",
        fileIds: ["stale-epoch"],
      }),
    ).toEqual({ wrote: false });
    expect(
      await getMaterializedSandboxFileResources(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        instanceId: "box-files-2",
      }),
    ).toEqual(new Set());
  }, 60_000);

  test("(3) refcount->0 drives warm->draining (turn_holders=0 guard) then the reaper surfaces it", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "turn-x",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "box",
      leaseTtlMs: 45_000,
    });
    const warm = await readRow(workspaceId, groupId);
    expect(warm?.liveness).toBe("warm");
    expect(warm?.refcount).toBe(1);

    // Release the last holder with 0ms grace so the drain deadline is already past.
    const rel = await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "turn-x",
      idleGraceMs: 0,
    });
    expect(rel?.liveness).toBe("draining");
    expect(rel?.refcount).toBe(0);
    const drainRow = await readRow(workspaceId, groupId);
    expect(drainRow?.turn_holders).toBe(0);

    // Reaper sees the draining lease whose grace (0ms) elapsed -> drainable.
    const reap = await reapStaleLeaseHolders(db, {
      workspaceId,
      viewerHolderTtlMs: 90_000,
      idleGraceMs: 45_000,
    });
    expect(reap.drained.map((d) => d.sandboxGroupId)).toContain(groupId);
    expect(reap.drained.find((d) => d.sandboxGroupId === groupId)?.instanceId).toBe("box");
  }, 60_000);

  test("(3-availability) an expired resumable drain re-arms until teardown is durably claimed", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "availability-owner",
      backend: "runloop",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "devbox-availability",
      resumeBackendId: "runloop",
      resumeState: {
        backendId: "runloop",
        sessionState: { providerState: { devboxId: "devbox-availability" } },
      },
      leaseTtlMs: 45_000,
    });
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "availability-owner",
      idleGraceMs: 0,
    });
    await admin`
      update sandbox_leases set expires_at = now() - interval '1 second'
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;

    const resumed = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "availability-successor",
      backend: "runloop",
      leaseTtlMs: 45_000,
    });

    expect(resumed.role).toBe("rearmed");
    expect(resumed.lease.liveness).toBe("warm");
    expect(resumed.lease.instanceId).toBe("devbox-availability");
    expect(resumed.lease.refcount).toBe(1);
  }, 60_000);

  test("(3-availability) the stable provider identity re-arms opaque provider state", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "stable-identity-owner",
      backend: "runloop",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "future-provider-instance",
      resumeBackendId: "runloop",
      resumeState: {
        backendId: "runloop",
        opengeniProviderInstanceId: "future-provider-instance",
        sessionState: { providerState: { privateProviderAddress: "opaque" } },
      },
      leaseTtlMs: 45_000,
    });
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "stable-identity-owner",
      idleGraceMs: 0,
    });

    expect(
      await reArmDrainingLease(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        leaseTtlMs: 45_000,
      }),
    ).toEqual({ rearmed: true });
    expect((await readLease(db, workspaceId, groupId))?.liveness).toBe("warm");
  }, 60_000);

  test("(3-availability) arbitrary provider config is not mistaken for a resumable identity", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "invalid-identity-owner",
      backend: "runloop",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "unaddressable-provider-instance",
      resumeBackendId: "runloop",
      resumeState: {
        backendId: "runloop",
        sessionState: {
          providerState: {
            blueprintName: "config-is-not-identity",
            id: "unaddressable-provider-instance",
          },
        },
      },
      leaseTtlMs: 45_000,
    });
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "invalid-identity-owner",
      idleGraceMs: 0,
    });

    const admission = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "invalid-identity-successor",
      backend: "runloop",
      leaseTtlMs: 45_000,
    });
    expect(admission.role).toBe("fenced");
    if (admission.role === "fenced") {
      expect(admission.reason).toBe("provider_recovery_in_progress");
    }
    expect(
      await reArmDrainingLease(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        leaseTtlMs: 45_000,
      }),
    ).toEqual({ rearmed: false });

    await admin`
      update sandbox_leases set resume_state = ${admin.json({
        backendId: "runloop",
        opengeniProviderInstanceId: "unaddressable-provider-instance",
        sessionState: { providerState: { devboxId: "devbox-stale" } },
      })}
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    const reverseMismatch = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "reverse-mismatched-identity-successor",
      backend: "runloop",
      leaseTtlMs: 45_000,
    });
    expect(reverseMismatch).toMatchObject({
      role: "fenced",
      reason: "provider_recovery_in_progress",
    });
    expect(
      await reArmDrainingLease(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        leaseTtlMs: 45_000,
      }),
    ).toEqual({ rearmed: false });
  }, 60_000);

  test("(3-availability) a stale envelope identity cannot re-arm another attributed instance", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "mismatched-identity-owner",
      backend: "runloop",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "devbox-authoritative",
      resumeBackendId: "runloop",
      resumeState: {
        backendId: "runloop",
        opengeniProviderInstanceId: "devbox-stale",
        sessionState: { providerState: { devboxId: "devbox-authoritative" } },
      },
      leaseTtlMs: 45_000,
    });
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "mismatched-identity-owner",
      idleGraceMs: 0,
    });

    const admission = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "mismatched-identity-successor",
      backend: "runloop",
      leaseTtlMs: 45_000,
    });
    expect(admission.role).toBe("fenced");
    if (admission.role === "fenced") {
      expect(admission.reason).toBe("provider_recovery_in_progress");
    }
    expect(
      await reArmDrainingLease(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        leaseTtlMs: 45_000,
      }),
    ).toEqual({ rearmed: false });
  }, 60_000);

  test("(3-availability) persisted provider identity without authoritative instance fails closed", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await admin`
      insert into sandbox_leases (
        account_id, workspace_id, sandbox_group_id, liveness, backend,
        instance_id, resume_backend_id, resume_state, expires_at
      ) values (
        ${accountId}, ${workspaceId}, ${groupId}, 'draining', 'runloop',
        null, 'runloop', ${admin.json({
          backendId: "runloop",
          opengeniProviderInstanceId: "devbox-unattributed",
          sessionState: { providerState: { devboxId: "devbox-unattributed" } },
        })}, now() - interval '1 second'
      )`;

    const admission = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "missing-authoritative-instance-successor",
      backend: "runloop",
      leaseTtlMs: 45_000,
    });
    expect(admission).toMatchObject({
      role: "fenced",
      reason: "provider_recovery_in_progress",
    });
    expect(
      await reArmDrainingLease(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        leaseTtlMs: 45_000,
      }),
    ).toEqual({ rearmed: false });
  }, 60_000);

  test("(3-availability) the providerless backend can re-arm without an instance identity", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await admin`
      insert into sandbox_leases (
        account_id, workspace_id, sandbox_group_id, liveness, backend, expires_at
      ) values (
        ${accountId}, ${workspaceId}, ${groupId}, 'draining', 'none',
        now() - interval '1 second'
      )`;

    const admission = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "providerless-successor",
      backend: "none",
      leaseTtlMs: 45_000,
    });
    expect(admission).toMatchObject({ role: "rearmed", lease: { liveness: "warm" } });
  }, 60_000);

  test("(3-claim) acquisition waits behind the exact teardown claim, then re-arms without an error", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "claim-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-claim-wait",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "sb-claim-wait" } },
      },
      leaseTtlMs: 45_000,
    });
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "claim-owner",
      idleGraceMs: 0,
    });
    const draining = await readLease(db, workspaceId, groupId);
    const captureId = crypto.randomUUID();
    const claimed = await claimWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId,
      expectedEpoch: draining!.leaseEpoch,
      expectedInstanceId: "sb-claim-wait",
      liveness: "draining",
      captureTimeoutMs: 1_000,
      minIntervalMs: 0,
    });
    expect(claimed.status).toBe("claimed");
    if (claimed.status !== "claimed") throw new Error("expected teardown capture claim");
    expect(claimed.lease.rotationReason).toBe("teardown_claim");

    let settled = false;
    const waiting = acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "claim-successor",
      backend: "modal",
      leaseTtlMs: 45_000,
      captureWaitMs: 1_000,
    }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    const [holderBeforeRelease] = await admin<{ count: number }[]>`
      select count(*)::int as count from sandbox_lease_holders h
      join sandbox_leases l on l.id = h.lease_id
      where l.workspace_id = ${workspaceId}
        and l.sandbox_group_id = ${groupId}
        and h.holder_id = 'claim-successor'`;
    expect(holderBeforeRelease?.count).toBe(0);

    expect(
      await releaseWorkspaceArchiveCapture(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        captureId,
        expectedEpoch: draining!.leaseEpoch,
        expectedInstanceId: "sb-claim-wait",
      }),
    ).toBe(true);
    const acquired = await waiting;
    expect(acquired.role).toBe("rearmed");
    expect(acquired.lease.instanceId).toBe("sb-claim-wait");
    expect(acquired.lease.rotationReason).toBeNull();
  }, 60_000);

  test("(3-hold) an exact bounded operator hold blocks every reaper ownership point but not re-attach", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "hold-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-held",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "sb-held" } },
      },
      leaseTtlMs: 45_000,
    });
    expect(
      await acquireSandboxLeaseReaperHold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: 0,
        expectedInstanceId: "sb-held",
        holdId: crypto.randomUUID(),
        ttlMs: 60_000,
        providerDeadlineHeadroomMs: 60_000,
        reason: "warming is not a stable preservation point",
      }),
    ).toMatchObject({ status: "not_live" });
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-held",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "sb-held" } },
      },
      leaseTtlMs: 45_000,
    });
    const epoch = committed.lease!.leaseEpoch;
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "hold-owner",
      idleGraceMs: 0,
    });

    const holdId = crypto.randomUUID();
    const held = await acquireSandboxLeaseReaperHold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: epoch,
      expectedInstanceId: "sb-held",
      holdId,
      ttlMs: 60_000,
      providerDeadlineHeadroomMs: 60_000,
      reason: "exact operator preservation",
    });
    expect(held.status).toBe("held");
    if (held.status !== "held") throw new Error("expected exact reaper hold");
    expect(held.renewed).toBe(false);
    expect(held.lease.reaperHold).toMatchObject({
      id: holdId,
      reason: "exact operator preservation",
    });
    expect(
      await acquireSandboxLeaseReaperHold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        expectedInstanceId: "sb-held",
        holdId,
        ttlMs: 120_000,
        providerDeadlineHeadroomMs: 60_000,
        reason: "exact operator preservation",
      }),
    ).toMatchObject({ status: "held", renewed: true });
    expect(
      await acquireSandboxLeaseReaperHold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        expectedInstanceId: "sb-held",
        holdId: crypto.randomUUID(),
        ttlMs: 60_000,
        providerDeadlineHeadroomMs: 60_000,
        reason: "competing operator",
      }),
    ).toMatchObject({ status: "held_by_other" });

    const globalSweep = await reapStaleLeaseHoldersGlobal(db, {
      viewerHolderTtlMs: 1,
      turnHolderTtlMs: 1,
      idleGraceMs: 0,
    });
    expect(
      globalSweep.some(
        (target) => target.workspaceId === workspaceId && target.sandboxGroupId === groupId,
      ),
    ).toBe(false);
    const scopedSweep = await reapStaleLeaseHolders(db, {
      workspaceId,
      viewerHolderTtlMs: 1,
      turnHolderTtlMs: 1,
      idleGraceMs: 0,
    });
    expect(scopedSweep.drained.some((target) => target.sandboxGroupId === groupId)).toBe(false);

    const blockedClaim = await claimWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId: crypto.randomUUID(),
      expectedEpoch: epoch,
      expectedInstanceId: "sb-held",
      liveness: "draining",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
    });
    expect(blockedClaim.status).toBe("reaper_held");
    expect(
      await confirmDrainCold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
      }),
    ).toEqual({ wentCold: false });

    // Migration trigger protection is the rolling-deploy backstop for old
    // workers that do not know the hold columns.
    const oldCaptureId = crypto.randomUUID();
    let oldCaptureError: unknown;
    try {
      await admin`
        update sandbox_leases set
          archive_capture_id = ${oldCaptureId}::uuid,
          archive_capture_generation = workspace_generation,
          archive_capture_started_at = now(),
          archive_capture_deadline_at = now() + interval '1 minute'
        where workspace_id = ${workspaceId}
          and sandbox_group_id = ${groupId}`;
    } catch (error) {
      oldCaptureError = error;
    }
    expect(oldCaptureError).toMatchObject({ code: "55000" });
    let oldColdCommitError: unknown;
    try {
      await admin`
        update sandbox_leases set liveness = 'cold'
        where workspace_id = ${workspaceId}
          and sandbox_group_id = ${groupId}`;
    } catch (error) {
      oldColdCommitError = error;
    }
    expect(oldColdCommitError).toMatchObject({ code: "55000" });

    expect(
      await releaseSandboxLeaseReaperHold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        expectedInstanceId: "sb-held",
        holdId: crypto.randomUUID(),
      }),
    ).toBe(false);

    // A holder arrival wins availability without waiting for hold expiry.
    const rearmed = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "hold-successor",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(rearmed.role).toBe("rearmed");
    expect(rearmed.lease.instanceId).toBe("sb-held");
    expect(rearmed.lease.reaperHold?.id).toBe(holdId);
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "hold-successor",
      idleGraceMs: 0,
    });

    expect(
      await releaseSandboxLeaseReaperHold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        expectedInstanceId: "sb-held",
        holdId,
      }),
    ).toBe(true);
    const captureId = crypto.randomUUID();
    const claimed = await claimWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId,
      expectedEpoch: epoch,
      expectedInstanceId: "sb-held",
      liveness: "draining",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
    });
    expect(claimed.status).toBe("claimed");
    expect(
      await acquireSandboxLeaseReaperHold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        expectedInstanceId: "sb-held",
        holdId: crypto.randomUUID(),
        ttlMs: 60_000,
        providerDeadlineHeadroomMs: 60_000,
        reason: "too late",
      }),
    ).toMatchObject({ status: "teardown_in_progress" });
    await releaseWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId,
      expectedEpoch: epoch,
      expectedInstanceId: "sb-held",
    });

    const expiringHoldId = crypto.randomUUID();
    expect(
      await acquireSandboxLeaseReaperHold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        expectedInstanceId: "sb-held",
        holdId: expiringHoldId,
        ttlMs: 60_000,
        providerDeadlineHeadroomMs: 60_000,
        reason: "bounded expiry proof",
      }),
    ).toMatchObject({ status: "held" });
    await admin`
      update sandbox_leases set reaper_hold_until = now() - interval '1 millisecond'
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    const afterExpiry = await claimWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId: crypto.randomUUID(),
      expectedEpoch: epoch,
      expectedInstanceId: "sb-held",
      liveness: "draining",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
    });
    expect(afterExpiry.status).toBe("claimed");
    if (afterExpiry.status !== "claimed") throw new Error("expected capture after hold expiry");
    expect(
      await confirmDrainCold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        expectedCaptureId: afterExpiry.claim.id,
      }),
    ).toEqual({ wentCold: true });
    expect((await readLease(db, workspaceId, groupId))?.reaperHold).toBeNull();
  }, 60_000);

  test("(3-hold-rotation) an admitted provider-deadline rotation cannot be cancelled by a late hold", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "rotation-hold-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-held-rotation",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "sb-held-rotation" } },
      },
      leaseTtlMs: 45_000,
    });
    const epoch = committed.lease!.leaseEpoch;
    await admin`
      update sandbox_leases set
        provider_created_at = now() - interval '23 hours',
        provider_deadline_at = now() + interval '1 minute'
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(
      await acquireSandboxLeaseReaperHold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        expectedInstanceId: "sb-held-rotation",
        holdId: crypto.randomUUID(),
        ttlMs: 30_000,
        providerDeadlineHeadroomMs: 60_000,
        reason: "would consume provider-deadline headroom",
      }),
    ).toMatchObject({ status: "provider_deadline_conflict" });
    await requestDueSandboxRotationsGlobal(db, 60 * 60_000, 500);
    expect((await readLease(db, workspaceId, groupId))?.rotationReason).toBe("provider_deadline");

    expect(
      await acquireSandboxLeaseReaperHold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        expectedInstanceId: "sb-held-rotation",
        holdId: crypto.randomUUID(),
        ttlMs: 60_000,
        providerDeadlineHeadroomMs: 60_000,
        reason: "deadline inspection",
      }),
    ).toMatchObject({ status: "rotation_in_progress" });
    expect((await readLease(db, workspaceId, groupId))?.rotationReason).toBe("provider_deadline");
  }, 60_000);

  test("(3-rolling) an old writer clearing the capture cannot reopen provider admission", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await admin`
      insert into sandbox_leases (
        account_id, workspace_id, sandbox_group_id, liveness, refcount,
        instance_id, backend, lease_epoch, resume_backend_id, resume_state, expires_at
      ) values (
        ${accountId}, ${workspaceId}, ${groupId}, 'draining', 0,
        'sb-rolling-fence', 'modal', 8, 'modal',
        jsonb_build_object(
          'backendId', 'modal',
          'opengeniProviderInstanceId', 'sb-rolling-fence'
        ),
        now() - interval '1 second'
      )`;
    const captureId = crypto.randomUUID();
    const claim = await claimWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId,
      expectedEpoch: 8,
      expectedInstanceId: "sb-rolling-fence",
      liveness: "draining",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
    });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("expected teardown capture claim");
    expect(claim.lease.rotationReason).toBe("teardown_claim");

    // Exact pre-fix publication behavior: the old statement clears only the
    // archive gate before its provider terminate call. The migration marker
    // must survive because old code does not know how to clear it.
    await admin`
      update sandbox_leases set
        archive_capture_id = null,
        archive_capture_generation = null,
        archive_capture_started_at = null,
        archive_capture_deadline_at = null
      where workspace_id = ${workspaceId}
        and sandbox_group_id = ${groupId}
        and archive_capture_id = ${captureId}::uuid`;

    const fenced = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "rolling-successor",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(fenced.role).toBe("fenced");
    if (fenced.role === "fenced") {
      expect(fenced.reason).toBe("rotation_in_progress");
      expect(fenced.lease.rotationReason).toBe("teardown_claim");
    }
    const [holder] = await admin<{ count: number }[]>`
      select count(*)::int as count from sandbox_lease_holders h
      join sandbox_leases l on l.id = h.lease_id
      where l.workspace_id = ${workspaceId}
        and l.sandbox_group_id = ${groupId}
        and h.holder_id = 'rolling-successor'`;
    expect(holder?.count).toBe(0);

    expect(
      await confirmDrainCold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: 8,
      }),
    ).toMatchObject({ wentCold: true });
  }, 60_000);

  test("(3-claim-cancel) cancelling a transition wait registers no holder", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await admin`
      insert into sandbox_leases (
        account_id, workspace_id, sandbox_group_id, liveness, refcount,
        instance_id, backend, lease_epoch, resume_backend_id, resume_state, expires_at
      ) values (
        ${accountId}, ${workspaceId}, ${groupId}, 'draining', 0,
        'sb-cancel-wait', 'modal', 4, 'modal',
        jsonb_build_object(
          'backendId', 'modal',
          'sessionState', jsonb_build_object(
            'providerState', jsonb_build_object('sandboxId', 'sb-cancel-wait')
          )
        ),
        now() - interval '1 second'
      )`;
    const captureId = crypto.randomUUID();
    const claim = await claimWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId,
      expectedEpoch: 4,
      expectedInstanceId: "sb-cancel-wait",
      liveness: "draining",
      captureTimeoutMs: 1_000,
      minIntervalMs: 0,
    });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("expected teardown capture claim");
    expect(claim.lease.rotationReason).toBe("teardown_claim");
    const controller = new AbortController();
    const waiting = acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "cancelled-successor",
      backend: "modal",
      leaseTtlMs: 45_000,
      captureWaitMs: 1_000,
      waitSignal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("operator cancelled transition")), 25);
    await expect(waiting).rejects.toThrow("operator cancelled transition");
    const [holder] = await admin<{ count: number }[]>`
      select count(*)::int as count from sandbox_lease_holders h
      join sandbox_leases l on l.id = h.lease_id
      where l.workspace_id = ${workspaceId}
        and l.sandbox_group_id = ${groupId}
        and h.holder_id = 'cancelled-successor'`;
    expect(holder?.count).toBe(0);
    await releaseWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId,
      expectedEpoch: 4,
      expectedInstanceId: "sb-cancel-wait",
    });
  }, 60_000);

  test("(3-claim-cas) snapshot publication retains teardown ownership and stale claimants cannot cold it", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "claim-cas-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-claim-cas",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "sb-claim-cas" } },
      },
      leaseTtlMs: 45_000,
    });
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "claim-cas-owner",
      idleGraceMs: 0,
    });
    const draining = await readLease(db, workspaceId, groupId);
    const captureId = crypto.randomUUID();
    const claim = await claimWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId,
      expectedEpoch: draining!.leaseEpoch,
      expectedInstanceId: "sb-claim-cas",
      liveness: "draining",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
    });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("expected teardown capture claim");
    expect(claim.lease.rotationReason).toBe("teardown_claim");
    const archive = Buffer.from("CLAIM_RETENTION_ARCHIVE").toString("base64");
    const persisted = await persistDrainSnapshotRaw(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: draining!.leaseEpoch,
      expectedInstanceId: "sb-claim-cas",
      expectedWorkspaceGeneration: 0,
      captureId,
      workspaceArchive: archive,
      workspaceArchiveMeta: archiveDescriptor(archive, 1_900_000_000_000),
    });
    expect(persisted.wrote).toBe(true);
    const publishedLease = await readLease(db, workspaceId, groupId);
    expect(publishedLease?.archiveCapture?.id).toBe(captureId);
    expect(publishedLease?.archiveCapture?.publishedAt).toBeInstanceOf(Date);
    // Publication makes the teardown claim irreversible. A generic release can
    // no longer reopen admission after the workspace is safely archived.
    expect(
      await releaseWorkspaceArchiveCapture(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        captureId,
        expectedEpoch: draining!.leaseEpoch,
        expectedInstanceId: "sb-claim-cas",
      }),
    ).toBe(false);

    const unowned = await confirmDrainCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: draining!.leaseEpoch,
    });
    expect(unowned.wentCold).toBe(false);
    expect((await readLease(db, workspaceId, groupId))?.archiveCapture?.id).toBe(captureId);

    const stale = await confirmDrainCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: draining!.leaseEpoch,
      expectedCaptureId: crypto.randomUUID(),
    });
    expect(stale.wentCold).toBe(false);
    expect((await readLease(db, workspaceId, groupId))?.liveness).toBe("draining");

    const exact = await confirmDrainCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: draining!.leaseEpoch,
      expectedCaptureId: captureId,
    });
    expect(exact.wentCold).toBe(true);
    const cold = await readLease(db, workspaceId, groupId);
    expect(cold?.liveness).toBe("cold");
    expect(cold?.archiveCapture).toBeNull();
    expect(cold?.rotationReason).toBeNull();
  }, 60_000);

  test("(3-rolling-claim) a legacy cold commit cannot erase a newer drain claim", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "rolling-claim-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-rolling-claim",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "sb-rolling-claim" } },
      },
      leaseTtlMs: 45_000,
    });
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "rolling-claim-owner",
      idleGraceMs: 0,
    });
    const draining = await readLease(db, workspaceId, groupId);
    const captureId = crypto.randomUUID();
    expect(
      await claimWorkspaceArchiveCapture(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        captureId,
        expectedEpoch: draining!.leaseEpoch,
        expectedInstanceId: "sb-rolling-claim",
        liveness: "draining",
        captureTimeoutMs: 60_000,
        minIntervalMs: 0,
      }),
    ).toMatchObject({ status: "claimed" });

    const legacy = postgres(shared!.appUrl, { max: 1 });
    try {
      await expect(
        legacy.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
          await tx`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
          await tx`
            update sandbox_leases set
              liveness = 'cold', instance_id = null, lease_epoch = lease_epoch + 1,
              archive_capture_id = null, archive_capture_generation = null,
              archive_capture_started_at = null, archive_capture_deadline_at = null
            where workspace_id = ${workspaceId}
              and sandbox_group_id = ${groupId}
          `;
        }),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await legacy.end();
    }
    expect((await readLease(db, workspaceId, groupId))?.archiveCapture?.id).toBe(captureId);
    expect(
      await confirmDrainCold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: draining!.leaseEpoch,
        expectedCaptureId: captureId,
      }),
    ).toEqual({ wentCold: true });
  }, 60_000);

  test("(3-claim-retry) generic captures wait for their deadline and preserve late-result lineage", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "claim-retry-owner",
      backend: "runloop",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-claim-retry",
      resumeBackendId: "runloop",
      resumeState: {
        backendId: "runloop",
        sessionState: { providerState: { devboxId: "sb-claim-retry" } },
      },
      leaseTtlMs: 45_000,
    });
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "claim-retry-owner",
      idleGraceMs: 0,
    });
    const draining = await readLease(db, workspaceId, groupId);
    const operationId = crypto.randomUUID();
    const firstCaptureId = operationId;
    const first = await claimWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId: firstCaptureId,
      operationId,
      attempt: 1,
      expectedEpoch: draining!.leaseEpoch,
      expectedInstanceId: "sb-claim-retry",
      liveness: "draining",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
    });
    expect(first.status).toBe("claimed");
    if (first.status !== "claimed") throw new Error("generic capture was not claimed");
    expect(first.claim.providerReplaySafe).toBe(false);
    expect(
      await workspaceArchiveCaptureDeadlineElapsed(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        captureId: firstCaptureId,
        expectedEpoch: draining!.leaseEpoch,
        expectedInstanceId: "sb-claim-retry",
      }),
    ).toBe(false);

    // A different operation has no proof that the unexpired owner is terminal.
    expect(
      await replaceWorkspaceArchiveCaptureAfterProof(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        priorCaptureId: firstCaptureId,
        captureId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        attempt: 1,
        expectedEpoch: draining!.leaseEpoch,
        expectedInstanceId: "sb-claim-retry",
        captureTimeoutMs: 60_000,
      }),
    ).toBeNull();

    // Even the right operation cannot replay the same attempt as a successor.
    expect(
      await replaceWorkspaceArchiveCaptureAfterProof(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        priorCaptureId: firstCaptureId,
        captureId: crypto.randomUUID(),
        operationId,
        attempt: 1,
        expectedEpoch: draining!.leaseEpoch,
        expectedInstanceId: "sb-claim-retry",
        captureTimeoutMs: 60_000,
      }),
    ).toBeNull();

    const secondCaptureId = crypto.randomUUID();
    expect(
      await replaceWorkspaceArchiveCaptureAfterProof(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        priorCaptureId: firstCaptureId,
        captureId: secondCaptureId,
        operationId,
        attempt: 2,
        expectedEpoch: draining!.leaseEpoch,
        expectedInstanceId: "sb-claim-retry",
        captureTimeoutMs: 60_000,
      }),
    ).toBeNull();

    await admin`
      update sandbox_leases
      set archive_capture_started_at = now() - interval '2 minutes',
          archive_capture_deadline_at = now() - interval '1 minute'
      where workspace_id = ${workspaceId}
        and sandbox_group_id = ${groupId}`;
    expect(
      await workspaceArchiveCaptureDeadlineElapsed(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        captureId: firstCaptureId,
        expectedEpoch: draining!.leaseEpoch,
        expectedInstanceId: "sb-claim-retry",
      }),
    ).toBe(true);

    // Expiry does not let the same logical operation replay an equal/older
    // attempt under a new physical request identity.
    expect(
      await replaceWorkspaceArchiveCaptureAfterProof(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        priorCaptureId: firstCaptureId,
        captureId: crypto.randomUUID(),
        operationId,
        attempt: 1,
        expectedEpoch: draining!.leaseEpoch,
        expectedInstanceId: "sb-claim-retry",
        captureTimeoutMs: 60_000,
      }),
    ).toBeNull();

    const second = await replaceWorkspaceArchiveCaptureAfterProof(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      priorCaptureId: firstCaptureId,
      captureId: secondCaptureId,
      operationId,
      attempt: 2,
      expectedEpoch: draining!.leaseEpoch,
      expectedInstanceId: "sb-claim-retry",
      captureTimeoutMs: 60_000,
    });
    expect(second).toMatchObject({
      id: secondCaptureId,
      operationId,
      providerRequestId: first.claim.providerRequestId,
      providerReplaySafe: false,
      attempt: 2,
      leaseEpoch: draining!.leaseEpoch,
    });

    const archive = Buffer.from("SUCCESSOR_CAPTURE_ARCHIVE").toString("base64");
    const stalePublication = await persistDrainSnapshotRaw(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: draining!.leaseEpoch,
      expectedInstanceId: "sb-claim-retry",
      expectedWorkspaceGeneration: 0,
      captureId: firstCaptureId,
      workspaceArchive: archive,
      workspaceArchiveMeta: archiveDescriptor(archive, 1_900_000_000_001),
    });
    expect(stalePublication.wrote).toBe(false);
    expect(
      await releaseWorkspaceArchiveCapture(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        captureId: firstCaptureId,
        expectedEpoch: draining!.leaseEpoch,
        expectedInstanceId: "sb-claim-retry",
      }),
    ).toBe(false);

    // The old callback is accepted only through the stable provider-operation
    // lineage. This repairs a lost callback without replaying a generic
    // provider request and settles the currently owning successor receipt.
    const latePublication = await persistDrainSnapshotRaw(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: draining!.leaseEpoch,
      expectedInstanceId: "sb-claim-retry",
      expectedWorkspaceGeneration: 0,
      captureId: firstCaptureId,
      providerRequestId: first.claim.providerRequestId,
      workspaceArchive: archive,
      workspaceArchiveMeta: archiveDescriptor(archive, 1_900_000_000_001),
    });
    expect(latePublication.wrote).toBe(true);
    expect(
      await confirmDrainCold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: draining!.leaseEpoch,
        expectedCaptureId: firstCaptureId,
      }),
    ).toMatchObject({ wentCold: false });
    expect(
      await confirmDrainCold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: draining!.leaseEpoch,
        expectedCaptureId: secondCaptureId,
      }),
    ).toMatchObject({ wentCold: true });
  }, 60_000);

  test("(3a) releasing a completed direct request settles its abandoned null-outcome admission", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const sessionId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const holderId = `direct:${requestId}`;
    await admin`
      insert into sessions (
        id, account_id, workspace_id, status, initial_message, model,
        sandbox_backend, sandbox_group_id, temporal_workflow_id, tool_policy
      ) values (
        ${sessionId}, ${accountId}, ${workspaceId}, 'idle',
        'direct release fixture', 'test-model', 'modal', ${groupId},
        ${`session-${sessionId}`},
        jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
      )`;
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "direct",
      holderId,
      subjectId: sessionId,
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "box-direct-release",
      leaseTtlMs: 45_000,
    });
    const epoch = committed.lease!.leaseEpoch;
    const admission = await advanceWorkspaceGenerationForDirectRequest(db, {
      accountId,
      workspaceId,
      sessionId,
      requestId,
      holderId,
      sandboxGroupId: groupId,
      expectedEpoch: epoch,
      expectedInstanceId: "box-direct-release",
      routeTargetId: null,
      routeEpoch: 0,
      operation: "exec",
    });

    expect(
      await readWorkspaceArchiveCapturePreflight(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        expectedInstanceId: "box-direct-release",
        liveness: "warm",
      }),
    ).toBeNull();
    expect(
      await releaseLeaseHolder(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        kind: "direct",
        holderId,
        idleGraceMs: 45_000,
      }),
    ).toEqual({ liveness: "draining", refcount: 0 });

    const [settled] = await admin<{ providerOutcome: string | null; settledAt: Date | null }[]>`
      select provider_outcome as "providerOutcome", settled_at as "settledAt"
      from sandbox_workspace_mutation_admissions
      where id = ${admission.id}`;
    expect(settled).toMatchObject({ providerOutcome: "rejected" });
    expect(settled?.settledAt).toBeInstanceOf(Date);
    expect(
      await readWorkspaceArchiveCapturePreflight(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: epoch,
        expectedInstanceId: "box-direct-release",
        liveness: "draining",
      }),
    ).toMatchObject({ workspaceGeneration: admission.workspaceGeneration });
  }, 60_000);

  test("(4) a stale VIEWER holder is TTL-reaped while a same-age TURN holder survives; lease stays warm", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "turn-keep",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "box",
      leaseTtlMs: 45_000,
    });
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "viewer-stale",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    const before = await readRow(workspaceId, groupId);
    expect(before?.refcount).toBe(2);
    expect(before?.turn_holders).toBe(1);
    expect(before?.viewer_holders).toBe(1);

    // Backdate BOTH holders' heartbeats to 10 minutes ago (both "stale-looking").
    await admin`update sandbox_lease_holders set last_heartbeat_at = now() - interval '10 minutes'
                where workspace_id = ${workspaceId}`;

    const reap = await reapStaleLeaseHolders(db, {
      workspaceId,
      viewerHolderTtlMs: 90_000,
      idleGraceMs: 45_000,
    });
    expect(reap.reapedViewers).toBe(1);

    const after = await readRow(workspaceId, groupId);
    expect(after?.refcount).toBe(1);
    expect(after?.turn_holders).toBe(1); // the turn holder is TTL-EXEMPT (survives)
    expect(after?.viewer_holders).toBe(0);
    expect(after?.liveness).toBe("warm"); // NOT drained out from under the agent

    const survivors = await admin<{ kind: string; holder_id: string }[]>`
      select kind, holder_id from sandbox_lease_holders where workspace_id = ${workspaceId}`;
    expect(survivors.length).toBe(1);
    expect(survivors[0]!.kind).toBe("turn");
    expect(survivors[0]!.holder_id).toBe("turn-keep");
  }, 60_000);

  test("(5) the SECURITY-DEFINER global sweep selects drainable rows across workspaces in one pass", async () => {
    if (!available) return;
    // Two distinct workspaces, each with a draining-past-grace lease. The global
    // sweep (the cross-workspace SECURITY DEFINER fn) must return BOTH in one call
    // — a per-workspace RLS-scoped read could never see both.
    const wsA = await freshWorkspace();
    const wsB = await freshWorkspace();
    for (const ws of [wsA, wsB]) {
      await acquireLease(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        sandboxGroupId: ws.groupId,
        kind: "turn",
        holderId: "t",
        backend: "modal",
        leaseTtlMs: 45_000,
      });
      await commitWarmingToWarm(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        sandboxGroupId: ws.groupId,
        expectedEpoch: 0,
        instanceId: `box-${ws.workspaceId.slice(0, 6)}`,
        leaseTtlMs: 45_000,
      });
      await releaseLeaseHolder(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        sandboxGroupId: ws.groupId,
        kind: "turn",
        holderId: "t",
        idleGraceMs: 0,
      });
    }
    // Both are now draining with an already-elapsed grace.
    const drained = await reapStaleLeaseHoldersGlobal(db, {
      viewerHolderTtlMs: 90_000,
      idleGraceMs: 45_000,
    });
    const groups = drained.map((d) => d.sandboxGroupId);
    expect(groups).toContain(wsA.groupId);
    expect(groups).toContain(wsB.groupId);
    // Each row carries the right workspace + instance, proving cross-workspace fan-out.
    const rowA = drained.find((d) => d.sandboxGroupId === wsA.groupId);
    expect(rowA?.workspaceId).toBe(wsA.workspaceId);
  }, 60_000);

  test("(5a) the global reaper skips an in-flight rearm instead of publishing its pre-wait zero-holder snapshot", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    const initial = await acquireLease(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      kind: "viewer",
      holderId: "pre-race-holder",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(initial.role).toBe("spawner");
    await commitWarmingToWarm(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      expectedEpoch: initial.lease.leaseEpoch,
      instanceId: "sb-rearm-race",
      leaseTtlMs: 45_000,
    });
    await releaseLeaseHolder(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      kind: "viewer",
      holderId: "pre-race-holder",
      idleGraceMs: 45_000,
    });
    expect((await readRow(ids.workspaceId, ids.groupId))?.liveness).toBe("draining");

    const actor = postgres(shared!.appUrl, { max: 1 });
    let announceLocked!: () => void;
    let allowCommit!: () => void;
    const locked = new Promise<void>((resolve) => {
      announceLocked = resolve;
    });
    const commit = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    const acquiring = actor.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${ids.accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${ids.workspaceId}, true)`;
      await tx`select set_config('opengeni.sandbox_recovery_protocol_v2', '1', true)`;
      const [lease] = await tx<{ id: string }[]>`
        select id from sandbox_leases
        where workspace_id = ${ids.workspaceId}
          and sandbox_group_id = ${ids.groupId}
        for update`;
      if (!lease) throw new Error("race fixture lease vanished");
      await tx`
        insert into sandbox_lease_holders (
          account_id, workspace_id, lease_id, kind, holder_id, last_heartbeat_at
        ) values (
          ${ids.accountId}, ${ids.workspaceId}, ${lease.id},
          'viewer', 'concurrent-rearm', now()
        )`;
      await tx`
        update sandbox_leases set
          liveness = 'warm',
          refcount = 1,
          turn_holders = 0,
          viewer_holders = 1,
          expires_at = now() + interval '45 seconds',
          updated_at = now()
        where id = ${lease.id}`;
      announceLocked();
      await commit;
    });

    try {
      await locked;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const raced = await Promise.race([
        reapStaleLeaseHoldersGlobal(db, {
          viewerHolderTtlMs: 90_000,
          turnHolderTtlMs: 0,
          idleGraceMs: 45_000,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("global reaper blocked behind an active lease")),
            2_000,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      expect(raced.some((row) => row.sandboxGroupId === ids.groupId)).toBe(false);
    } finally {
      allowCommit();
      await acquiring;
      await actor.end();
    }

    await reapStaleLeaseHoldersGlobal(db, {
      viewerHolderTtlMs: 90_000,
      turnHolderTtlMs: 0,
      idleGraceMs: 45_000,
    });
    const after = await readRow(ids.workspaceId, ids.groupId);
    expect(after?.liveness).toBe("warm");
    expect(after?.refcount).toBe(1);
    expect(after?.viewer_holders).toBe(1);
  }, 60_000);

  test("(5b) the global reaper locks and deletes stale holders, then makes a requested rotation immediately drainable", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    const acquired = await acquireLease(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      kind: "viewer",
      holderId: "stale-rotation-viewer",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "sb-stale-rotation",
      leaseTtlMs: 45_000,
    });
    await admin`
      update sandbox_lease_holders
      set last_heartbeat_at = now() - interval '10 minutes'
      where workspace_id = ${ids.workspaceId}
        and holder_id = 'stale-rotation-viewer'`;
    await admin`
      update sandbox_leases
      set rotation_requested_at = now(), rotation_reason = 'operator'
      where workspace_id = ${ids.workspaceId}
        and sandbox_group_id = ${ids.groupId}`;

    const drained = await reapStaleLeaseHoldersGlobal(db, {
      viewerHolderTtlMs: 90_000,
      turnHolderTtlMs: 0,
      idleGraceMs: 45_000,
    });
    const [holderCount] = await admin<{ count: number }[]>`
      select count(*)::int as count
      from sandbox_lease_holders
      where workspace_id = ${ids.workspaceId}
        and holder_id = 'stale-rotation-viewer'`;
    expect(holderCount?.count).toBe(0);
    const after = await readRow(ids.workspaceId, ids.groupId);
    expect(after?.liveness).toBe("draining");
    expect(after?.refcount).toBe(0);
    expect(after?.viewer_holders).toBe(0);
    expect(after?.expires_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(drained).toContainEqual(
      expect.objectContaining({
        workspaceId: ids.workspaceId,
        sandboxGroupId: ids.groupId,
        instanceId: "sb-stale-rotation",
      }),
    );
  }, 60_000);

  test("(6) RLS isolation: a per-workspace read under one workspace's context cannot see another workspace's lease", async () => {
    if (!available) return;
    const wsA = await freshWorkspace();
    const wsB = await freshWorkspace();
    await acquireLease(db, {
      accountId: wsA.accountId,
      workspaceId: wsA.workspaceId,
      sandboxGroupId: wsA.groupId,
      kind: "turn",
      holderId: "a",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await acquireLease(db, {
      accountId: wsB.accountId,
      workspaceId: wsB.workspaceId,
      sandboxGroupId: wsB.groupId,
      kind: "turn",
      holderId: "b",
      backend: "modal",
      leaseTtlMs: 45_000,
    });

    // Reaping under workspace A's RLS context must NOT touch workspace B's holder.
    await admin`update sandbox_lease_holders set last_heartbeat_at = now() - interval '10 minutes'
                where workspace_id = ${wsB.workspaceId}`;
    // Make B a viewer so it would be reapable IF RLS leaked.
    await admin`update sandbox_lease_holders set kind='viewer' where workspace_id = ${wsB.workspaceId}`;
    const reapUnderA = await reapStaleLeaseHolders(db, {
      workspaceId: wsA.workspaceId,
      viewerHolderTtlMs: 90_000,
      idleGraceMs: 45_000,
    });
    expect(reapUnderA.reapedViewers).toBe(0); // A's sweep cannot see/reap B's stale viewer

    const bHolders = await admin<{ id: string }[]>`
      select id from sandbox_lease_holders where workspace_id = ${wsB.workspaceId}`;
    expect(bHolders.length).toBe(1); // B's holder is untouched by A's scoped reap
  }, 60_000);

  // The file-persistence regression: persistDrainSnapshot folds the /workspace
  // snapshot onto the DRAINING lease's resume_state, and confirmDrainCold then
  // commits draining->cold. The bug was confirmDrainCold nulling resume_state
  // wholesale — destroying the snapshot the next cold-restore must replay, IN THE
  // SAME reaper sweep (drainable:1, terminated:1, but arch=NULL → file lost). The
  // fix: confirmDrainCold PRESERVES a minimal archive-only envelope across the cold
  // transition so the snapshot survives until the re-warm hydrates it.
  test("(7) the persisted /workspace archive SURVIVES confirmDrainCold (draining->cold) — file-persistence regression", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    // Warm a box with a realistic resume envelope (providerState + sandboxId).
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "t",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-live",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: {
          providerState: { sandboxId: "sb-live", appName: "app" },
          workspaceReady: true,
        },
      },
      leaseTtlMs: 45_000,
    });
    // Drain it (0ms grace) -> draining at refcount 0. commitWarmingToWarm bumped
    // the epoch (0->1), so the drain seam fences on the LIVE epoch.
    const rel = await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "t",
      idleGraceMs: 0,
    });
    expect(rel?.liveness).toBe("draining");
    const epoch = (await readRow(workspaceId, groupId))!.lease_epoch;

    // The reaper persist seam: fold the /workspace snapshot-ref onto the lease.
    const ARCHIVE_B64 = Buffer.from(
      'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-snap-xyz"}',
    ).toString("base64");
    const captureId = crypto.randomUUID();
    expect(
      await claimWorkspaceArchiveCapture(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        captureId,
        expectedEpoch: epoch,
        expectedInstanceId: "sb-live",
        liveness: "draining",
        captureTimeoutMs: 60_000,
        minIntervalMs: 0,
      }),
    ).toMatchObject({ status: "claimed" });
    const persisted = await persistDrainSnapshotRaw(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: epoch,
      expectedInstanceId: "sb-live",
      expectedWorkspaceGeneration: 0,
      captureId,
      workspaceArchive: ARCHIVE_B64,
      workspaceArchiveMeta: archiveDescriptor(ARCHIVE_B64, 1_900_000_000_000),
    });
    expect(persisted.wrote).toBe(true);

    // Now the cold commit — the seam that USED to wipe the archive.
    const cold = await confirmDrainCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: epoch,
      expectedCaptureId: captureId,
    });
    expect(cold.wentCold).toBe(true);

    const [row] = await admin<
      {
        liveness: string;
        instance_id: string | null;
        resume_backend_id: string | null;
        archive: string | null;
        sandbox_id: string | null;
        backend_id: string | null;
      }[]
    >`
      select liveness, instance_id, resume_backend_id,
             resume_state #>> '{sessionState,workspaceArchive}' as archive,
             resume_state #>> '{sessionState,providerState,sandboxId}' as sandbox_id,
             resume_state ->> 'backendId' as backend_id
      from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.liveness).toBe("cold");
    expect(row?.instance_id).toBeNull(); // live-box id cleared
    // The archive SURVIVES the cold transition — the whole point of the fix.
    expect(row?.archive).toBe(ARCHIVE_B64);
    expect(row?.resume_backend_id).toBe("modal"); // backend kept so cold-restore knows the client
    expect(row?.backend_id).toBe("modal"); // archive-only envelope carries backendId
    // The DEAD box's providerState/sandboxId is dropped (resume-by-id would only fail).
    expect(row?.sandbox_id).toBeNull();
  }, 60_000);

  // The other side: a drained lease with NO persisted archive still colds cleanly
  // with resume_state nulled (no regression for the tar/none/never-persisted case).
  test("(8) confirmDrainCold with NO archive nulls resume_state (clean cold)", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "t",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-live",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "sb-live" }, workspaceReady: true },
      },
      leaseTtlMs: 45_000,
    });
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "t",
      idleGraceMs: 0,
    });
    const epoch = (await readRow(workspaceId, groupId))!.lease_epoch;
    const cold = await confirmDrainCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: epoch,
    });
    expect(cold.wentCold).toBe(true);
    const [row] = await admin<
      { liveness: string; resume_state: unknown; resume_backend_id: string | null }[]
    >`
      select liveness, resume_state, resume_backend_id
      from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.liveness).toBe("cold");
    expect(row?.resume_state).toBeNull();
    expect(row?.resume_backend_id).toBeNull();
  }, 60_000);

  test("(8a) provider disappearance before capture with NO archive becomes typed unrecoverable", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "missing-provider",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-missing-before-capture",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: {
          providerState: { sandboxId: "sb-missing-before-capture" },
        },
      },
      leaseTtlMs: 45_000,
    });
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "missing-provider",
      idleGraceMs: 0,
    });
    const before = await readLease(db, workspaceId, groupId);
    expect(before?.liveness).toBe("draining");

    const cold = await confirmDrainCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: before!.leaseEpoch,
      providerMissingBeforeCapture: true,
    });
    expect(cold.wentCold).toBe(true);

    const lease = await readLease(db, workspaceId, groupId);
    expect(lease?.liveness).toBe("cold");
    expect(lease?.instanceId).toBeNull();
    expect(lease?.recovery.provider).toMatchObject({
      status: "missing",
      instanceId: "sb-missing-before-capture",
      diagnostic: "provider_not_found_before_workspace_capture",
    });
    expect(lease?.recovery.archive.status).toBe("none");
    expect(lease?.recovery.restore).toMatchObject({
      status: "unrecoverable",
      failureCode: "archive_unavailable",
      retryable: false,
    });
    expect(lease?.recovery.workspace.status).toBe("unrecoverable");

    const retry = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "must-not-spawn",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(retry.role).toBe("blocked");
    if (retry.role === "blocked") {
      expect(retry.code).toBe("restore_unrecoverable");
    }
  }, 60_000);

  test("(8b) a provider-loss cold commit adopts the exact late capture callback", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "late-provider-capture",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    const instanceId = "sb-late-provider-capture";
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId,
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: {
          providerState: { sandboxId: instanceId, workspacePersistence: "tar" },
        },
      },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "late-provider-capture",
      idleGraceMs: 0,
    });
    const source = await readLease(db, workspaceId, groupId);
    expect(source?.liveness).toBe("draining");
    const captureId = crypto.randomUUID();
    const claim = await claimWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId,
      operationId: captureId,
      attempt: 1,
      expectedEpoch: source!.leaseEpoch,
      expectedInstanceId: instanceId,
      liveness: "draining",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
    });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("late capture fixture was not claimed");
    expect(claim.claim.providerReplaySafe).toBe(false);

    const cold = await confirmDrainCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: source!.leaseEpoch,
      expectedCaptureId: captureId,
      providerMissingBeforeCapture: true,
    });
    expect(cold.wentCold).toBe(true);
    const beforeCallback = await readLease(db, workspaceId, groupId);
    expect(beforeCallback?.recovery.restore.status).toBe("unrecoverable");
    expect(beforeCallback?.recovery.lateArchiveCapture).toMatchObject({
      captureId,
      providerRequestId: claim.claim.providerRequestId,
      sourceLeaseId: source!.id,
      sourceLeaseEpoch: source!.leaseEpoch,
      sourceInstanceId: instanceId,
      sourceWorkspaceGeneration: 0,
    });
    const blocked = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "blocked-before-late-callback",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(blocked).toMatchObject({ role: "blocked", code: "restore_unrecoverable" });

    const archive = Buffer.from("LATE_PROVIDER_CAPTURE_ARCHIVE").toString("base64");
    const descriptor = archiveDescriptor(archive, 1_900_000_000_111);
    const published = await persistDrainSnapshotRaw(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedLeaseId: source!.id,
      expectedEpoch: source!.leaseEpoch,
      expectedInstanceId: instanceId,
      expectedWorkspaceGeneration: 0,
      captureId,
      providerRequestId: claim.claim.providerRequestId,
      workspaceArchive: archive,
      workspaceArchiveMeta: descriptor,
    });
    expect(published).toEqual({ wrote: true, archiveRevision: descriptor.revision });
    const repaired = await readLease(db, workspaceId, groupId);
    expect(repaired).toMatchObject({
      liveness: "cold",
      leaseEpoch: source!.leaseEpoch + 1,
      archiveGeneration: 0,
      archiveComplete: true,
    });
    expect(repaired?.recovery).toMatchObject({
      archive: { status: "available", current: { revision: descriptor.revision } },
      restore: { status: "pending", selectedRevision: descriptor.revision },
      workspace: { status: "not_ready" },
    });
    expect(repaired?.recovery.lateArchiveCapture).toBeUndefined();

    // The one-shot receipt cannot mutate a later state a second time.
    expect(
      await persistDrainSnapshotRaw(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedLeaseId: source!.id,
        expectedEpoch: source!.leaseEpoch,
        expectedInstanceId: instanceId,
        expectedWorkspaceGeneration: 0,
        captureId,
        providerRequestId: claim.claim.providerRequestId,
        workspaceArchive: archive,
        workspaceArchiveMeta: descriptor,
      }),
    ).toEqual({ wrote: false, archiveRevision: null });
    const successor = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "spawn-after-late-callback",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(successor.role).toBe("spawner");
  }, 60_000);

  test("(8c) a late native checkpoint atomically supersedes an older recoverable archive", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "late-native-capture",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    const instanceId = "sb-late-native-capture";
    const priorArchive = Buffer.from("PRIOR_RECOVERABLE_ARCHIVE").toString("base64");
    const priorDescriptor = archiveDescriptor(priorArchive, 1_900_000_000_100);
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId,
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: {
          providerState: {
            sandboxId: instanceId,
            workspacePersistence: "snapshot_filesystem",
          },
          workspaceArchive: priorArchive,
          workspaceArchiveMeta: priorDescriptor,
          workspaceArchiveAt: priorDescriptor.capturedAt,
        },
      },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);
    // The fixture starts with a provider-restored, generation-complete archive.
    // Production reaches the same state through rematerialization verification.
    await admin`
      update sandbox_leases
      set archive_generation = workspace_generation
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "late-native-capture",
      idleGraceMs: 0,
    });
    const source = await readLease(db, workspaceId, groupId);
    expect(source).toMatchObject({ liveness: "draining", archiveComplete: true });

    const operationId = crypto.randomUUID();
    const claim = await claimWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId: operationId,
      operationId,
      attempt: 1,
      expectedEpoch: source!.leaseEpoch,
      expectedInstanceId: instanceId,
      liveness: "draining",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
      providerReplaySafe: true,
      takeoverSafe: true,
    });
    expect(claim.status).toBe("claimed");
    if (claim.status !== "claimed") throw new Error("native capture fixture was not claimed");
    expect(claim.claim.providerReplaySafe).toBe(true);

    const imageId = "im-late-native-capture";
    const nativeBytes = Buffer.from(
      `MODAL_SANDBOX_FS_SNAPSHOT_V1\n${JSON.stringify({
        snapshot_id: imageId,
        workspace_persistence: "snapshot_filesystem",
      })}`,
    );
    const nativeArchive = nativeBytes.toString("base64");
    const nativeSha = createHash("sha256").update(nativeBytes).digest("hex");
    const capturedAtMs = 1_900_000_000_200;
    const nativeDescriptor = {
      version: 2 as const,
      kind: "provider_snapshot" as const,
      revision: `wa2:${capturedAtMs}:${nativeSha}`,
      archiveSha256: nativeSha,
      archiveBytes: nativeBytes.length,
      capturedAt: new Date(capturedAtMs).toISOString(),
      provider: "modal_snapshot_filesystem" as const,
      snapshotId: imageId,
      workspacePersistence: "snapshot_filesystem",
    };
    const binding = {
      version: 1,
      serverUrl: "https://modal.test",
      workspaceName: "late-native-workspace",
      environment: "main",
    };
    const candidate = await registerSandboxCheckpointArtifact(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      sourceLeaseId: claim.claim.leaseId,
      sourceLeaseEpoch: claim.claim.leaseEpoch,
      sourceInstanceId: claim.claim.instanceId,
      sourceWorkspaceGeneration: claim.claim.workspaceGeneration,
      providerBindingKey: JSON.stringify(binding),
      providerBinding: binding,
      workspaceArchive: nativeArchive,
      workspaceArchiveMeta: nativeDescriptor,
    });

    expect(
      await confirmDrainCold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: source!.leaseEpoch,
        expectedCaptureId: claim.claim.id,
        providerMissingBeforeCapture: true,
      }),
    ).toEqual({ wentCold: true });
    const beforeCallback = await readLease(db, workspaceId, groupId);
    expect(beforeCallback?.recovery).toMatchObject({
      archive: { status: "available", current: { revision: priorDescriptor.revision } },
      restore: { status: "pending", selectedRevision: priorDescriptor.revision },
      lateArchiveCapture: { providerRequestId: operationId },
    });

    expect(
      await persistDrainSnapshotRaw(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedLeaseId: source!.id,
        expectedEpoch: source!.leaseEpoch,
        expectedInstanceId: instanceId,
        expectedWorkspaceGeneration: 0,
        captureId: claim.claim.id,
        providerRequestId: claim.claim.providerRequestId,
        workspaceArchive: nativeArchive,
        workspaceArchiveMeta: nativeDescriptor,
        checkpointArtifactId: candidate.id,
      }),
    ).toEqual({ wrote: true, archiveRevision: nativeDescriptor.revision });

    const repaired = await readLease(db, workspaceId, groupId);
    expect(repaired).toMatchObject({
      liveness: "cold",
      currentCheckpointArtifactId: candidate.id,
      archiveComplete: true,
      recovery: {
        archive: {
          status: "available",
          current: { revision: nativeDescriptor.revision },
          previous: { revision: priorDescriptor.revision },
        },
        restore: { status: "pending", selectedRevision: nativeDescriptor.revision },
      },
    });
    expect(repaired?.recovery.lateArchiveCapture).toBeUndefined();
    const [artifact] = await admin<Array<{ state: string }>>`
      select state from sandbox_checkpoint_artifacts where id = ${candidate.id}`;
    expect(artifact?.state).toBe("current");
  }, 60_000);

  // IMAGE IS SHARED STATE (B3): the lease stamps the image the box runs; a resume with
  // a DIFFERENT image is a conflict (solo → recreate; N-holders → hard fail).
  test("(9) image B3: cold-create stamps the image on the warming row", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const res = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "t",
      backend: "modal",
      image: "img-A",
      leaseTtlMs: 45_000,
    });
    expect(res.role).toBe("spawner");
    const [row] = await admin<{ image: string | null; liveness: string }[]>`
      select image, liveness from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.image).toBe("img-A");
    expect(row?.liveness).toBe("warming");
  });

  test("(10) image B3: warm box + SAME image = plain attach (no recreate)", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "spawner",
      backend: "modal",
      image: "img-A",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-live",
      resumeBackendId: "modal",
      resumeState: { backendId: "modal" },
      leaseTtlMs: 45_000,
    });
    // A SECOND holder arrives on the warm box with the SAME image -> attach, box intact.
    const res = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "v2",
      backend: "modal",
      image: "img-A",
      leaseTtlMs: 45_000,
    });
    expect(res.role).toBe("attached");
    const [row] = await admin<
      { liveness: string; image: string | null; instance_id: string | null; refcount: number }[]
    >`
      select liveness, image, instance_id, refcount from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.liveness).toBe("warm"); // never recreated
    expect(row?.image).toBe("img-A");
    expect(row?.instance_id).toBe("sb-live"); // live box untouched
    expect(row?.refcount).toBe(2);
  });

  test("(11) image B3: a solo image change preserves the box/checkpoint and requests capture-and-drain rotation", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    // Warm on img-A, held by exactly ONE holder ("solo").
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "solo",
      backend: "modal",
      image: "img-A",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-live",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "sb-live" } },
      },
      leaseTtlMs: 45_000,
    });
    // The SAME solo holder re-arrives resolving a DIFFERENT image. It must not
    // erase the only provider pointer or resume envelope; the reaper owns
    // snapshot + termination before a successor can stamp img-B.
    const res = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "solo",
      backend: "modal",
      image: "img-B",
      leaseTtlMs: 45_000,
    });
    expect(res.role).toBe("fenced");
    const [row] = await admin<
      {
        liveness: string;
        image: string | null;
        instance_id: string | null;
        resume_state: unknown;
        rotation_requested_at: Date | null;
        rotation_reason: string | null;
      }[]
    >`
      select liveness, image, instance_id, resume_state,
        rotation_requested_at, rotation_reason
      from sandbox_leases
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.liveness).toBe("warm");
    expect(row?.image).toBe("img-A");
    expect(row?.instance_id).toBe("sb-live");
    expect(row?.resume_state).toMatchObject({
      backendId: "modal",
      sessionState: { providerState: { sandboxId: "sb-live" } },
    });
    expect(row?.rotation_requested_at).toBeInstanceOf(Date);
    expect(row?.rotation_reason).toBe("operator");

    const released = await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "solo",
      idleGraceMs: 45_000,
    });
    expect(released).toEqual({ liveness: "draining", refcount: 0 });
    const [draining] = await admin<
      Array<{ instance_id: string | null; resume_state: unknown; image: string | null }>
    >`
      select instance_id, resume_state, image
      from sandbox_leases
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(draining?.instance_id).toBe("sb-live");
    expect(draining?.resume_state).toEqual(row?.resume_state);
    expect(draining?.image).toBe("img-A");
  });

  test("(12) image B3: warm box + OTHER holders + DIFFERENT image -> SandboxImageConflictError (box untouched)", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    // Warm on img-A with a holder that STAYS on the box.
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "keeper",
      backend: "modal",
      image: "img-A",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-live",
      resumeBackendId: "modal",
      resumeState: { backendId: "modal" },
      leaseTtlMs: 45_000,
    });
    // A DIFFERENT holder resolves a DIFFERENT image while "keeper" still holds -> refuse.
    await expect(
      acquireLease(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        kind: "turn",
        holderId: "newcomer",
        backend: "modal",
        image: "img-B",
        leaseTtlMs: 45_000,
      }),
    ).rejects.toThrow(SandboxImageConflictError);
    // The box is UNTOUCHED — the other session keeps running its filesystem.
    const [row] = await admin<
      { liveness: string; image: string | null; instance_id: string | null }[]
    >`
      select liveness, image, instance_id from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.liveness).toBe("warm");
    expect(row?.image).toBe("img-A");
    expect(row?.instance_id).toBe("sb-live");
  });

  test("(13) image B3: a null input image (e.g. selfhosted) NEVER conflicts + never stamps", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "keeper",
      backend: "modal",
      image: "img-A",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-live",
      resumeBackendId: "modal",
      resumeState: { backendId: "modal" },
      leaseTtlMs: 45_000,
    });
    // No image on this acquire -> attach, no conflict, image column unchanged.
    const res = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "no-image",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(res.role).toBe("attached");
    const [row] = await admin<{ image: string | null; liveness: string }[]>`
      select image, liveness from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.image).toBe("img-A");
    expect(row?.liveness).toBe("warm");
  });

  // RIG IS SHARED STATE (M3): the lease also stamps the frozen rig version; a resume
  // resolving a DIFFERENT rig version conflicts exactly like a different image.
  test("(14) rig M3: cold-create stamps rig_version_id on the warming row", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const res = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "t",
      backend: "modal",
      rigVersionId: "aaaa1111-1111-4111-8111-111111111111",
      leaseTtlMs: 45_000,
    });
    expect(res.role).toBe("spawner");
    const [row] = await admin<{ rig_version_id: string | null; liveness: string }[]>`
      select rig_version_id, liveness from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.rig_version_id).toBe("aaaa1111-1111-4111-8111-111111111111");
    expect(row?.liveness).toBe("warming");
  });

  test("(15) rig M3: a solo rig change requests durable rotation without erasing the live provider", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "solo",
      backend: "modal",
      image: "img-A",
      rigVersionId: "aaaa1111-1111-4111-8111-111111111111",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-live",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "sb-live" } },
      },
      leaseTtlMs: 45_000,
    });
    // SAME solo holder, SAME image, DIFFERENT rig -> capture-and-drain rotation.
    // The new rig is stamped only by a later cold successor.
    const res = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "solo",
      backend: "modal",
      image: "img-A",
      rigVersionId: "bbbb2222-2222-4222-8222-222222222222",
      leaseTtlMs: 45_000,
    });
    expect(res.role).toBe("fenced");
    const [row] = await admin<
      {
        liveness: string;
        image: string | null;
        rig_version_id: string | null;
        instance_id: string | null;
        resume_state: unknown;
        rotation_requested_at: Date | null;
        rotation_reason: string | null;
      }[]
    >`
      select liveness, image, rig_version_id, instance_id, resume_state,
        rotation_requested_at, rotation_reason
      from sandbox_leases
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.liveness).toBe("warm");
    expect(row?.image).toBe("img-A");
    expect(row?.rig_version_id).toBe("aaaa1111-1111-4111-8111-111111111111");
    expect(row?.instance_id).toBe("sb-live");
    expect(row?.resume_state).toMatchObject({
      backendId: "modal",
      sessionState: { providerState: { sandboxId: "sb-live" } },
    });
    expect(row?.rotation_requested_at).toBeInstanceOf(Date);
    expect(row?.rotation_reason).toBe("operator");
  });

  test("(16) rig M3: warm box + OTHER holders + DIFFERENT rig -> SandboxRigConflictError (box untouched)", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "keeper",
      backend: "modal",
      rigVersionId: "aaaa1111-1111-4111-8111-111111111111",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-live",
      resumeBackendId: "modal",
      resumeState: { backendId: "modal" },
      leaseTtlMs: 45_000,
    });
    await expect(
      acquireLease(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        kind: "turn",
        holderId: "newcomer",
        backend: "modal",
        rigVersionId: "bbbb2222-2222-4222-8222-222222222222",
        leaseTtlMs: 45_000,
      }),
    ).rejects.toThrow(SandboxRigConflictError);
    const [row] = await admin<
      { liveness: string; rig_version_id: string | null; instance_id: string | null }[]
    >`
      select liveness, rig_version_id, instance_id from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.liveness).toBe("warm");
    expect(row?.rig_version_id).toBe("aaaa1111-1111-4111-8111-111111111111");
    expect(row?.instance_id).toBe("sb-live");
  });

  test("(17) rig M3: SAME rig on a warm box = plain attach (no recreate)", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "spawner",
      backend: "modal",
      rigVersionId: "aaaa1111-1111-4111-8111-111111111111",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-live",
      resumeBackendId: "modal",
      resumeState: { backendId: "modal" },
      leaseTtlMs: 45_000,
    });
    const res = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "v2",
      backend: "modal",
      rigVersionId: "aaaa1111-1111-4111-8111-111111111111",
      leaseTtlMs: 45_000,
    });
    expect(res.role).toBe("attached");
    const [row] = await admin<
      {
        liveness: string;
        rig_version_id: string | null;
        instance_id: string | null;
        refcount: number;
      }[]
    >`
      select liveness, rig_version_id, instance_id, refcount from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.liveness).toBe("warm");
    expect(row?.rig_version_id).toBe("aaaa1111-1111-4111-8111-111111111111");
    expect(row?.instance_id).toBe("sb-live");
    expect(row?.refcount).toBe(2);
  });

  test("(18) rig M3: a null input rig (rig-less session) NEVER conflicts + never stamps", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "keeper",
      backend: "modal",
      rigVersionId: "aaaa1111-1111-4111-8111-111111111111",
      leaseTtlMs: 45_000,
    });
    await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "sb-live",
      resumeBackendId: "modal",
      resumeState: { backendId: "modal" },
      leaseTtlMs: 45_000,
    });
    // A rig-less acquire (no rigVersionId) attaches and leaves the rig column intact.
    const res = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "rigless",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(res.role).toBe("attached");
    const [row] = await admin<{ rig_version_id: string | null; liveness: string }[]>`
      select rig_version_id, liveness from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.rig_version_id).toBe("aaaa1111-1111-4111-8111-111111111111");
    expect(row?.liveness).toBe("warm");
  });

  test("(19) provider loss elects one epoch-fenced rematerialization and publishes only its verified revision", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const archive = Buffer.from("exact-durable-revision").toString("base64");
    const archiveHash = "a".repeat(64);
    const descriptor = {
      version: 1 as const,
      revision: `wa1:1900000000000:${archiveHash}`,
      archiveSha256: archiveHash,
      archiveBytes: Buffer.from(archive, "base64").length,
      capturedAt: "2030-03-17T17:46:40.000Z",
      workspace: {
        algorithm: "sha256" as const,
        sha256: "b".repeat(64),
        entryCount: 7,
        fileCount: 3,
        totalFileBytes: 91,
      },
    };

    const initial = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "initial",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(initial.role).toBe("spawner");
    const firstCommit = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "box-before-loss",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: {
          providerState: { sandboxId: "box-before-loss" },
          workspaceArchive: archive,
          workspaceArchiveMeta: descriptor,
        },
      },
      leaseTtlMs: 45_000,
    });
    expect(firstCommit.committed).toBe(true);
    // commitWarmingToWarm is not a capture seam. This fixture models an archive
    // that a prior verified capture already completed before provider loss.
    await admin`
      update sandbox_leases
      set archive_generation = workspace_generation
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;

    const losses = await Promise.all(
      Array.from({ length: 24 }, () =>
        markWarmLeaseInstanceLost(db, {
          accountId,
          workspaceId,
          sandboxGroupId: groupId,
          expectedEpoch: 1,
          expectedInstanceId: "box-before-loss",
          diagnostic: "provider_not_found",
        }),
      ),
    );
    expect(losses.filter((result) => result.status === "marked")).toHaveLength(1);
    expect(losses.filter((result) => result.status === "stale")).toHaveLength(23);
    const lost = losses.find((result) => result.status === "marked");
    expect(lost?.lease.leaseEpoch).toBe(2);
    expect(lost?.lease.recovery.provider.status).toBe("missing");
    expect(lost?.lease.recovery.archive.current?.revision).toBe(descriptor.revision);
    expect(lost?.lease.recovery.restore.status).toBe("pending");
    expect(lost?.lease.recovery.workspace.status).toBe("not_ready");

    const acquires = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        acquireLease(db, {
          accountId,
          workspaceId,
          sandboxGroupId: groupId,
          kind: "turn",
          holderId: `recovery-${index}`,
          backend: "modal",
          leaseTtlMs: 45_000,
        }),
      ),
    );
    expect(acquires.filter((result) => result.role === "spawner")).toHaveLength(1);
    expect(acquires.filter((result) => result.role === "attached")).toHaveLength(23);

    const rematerializationId = crypto.randomUUID();
    const starts = await Promise.all(
      Array.from({ length: 8 }, () =>
        beginSandboxRematerialization(db, {
          accountId,
          workspaceId,
          sandboxGroupId: groupId,
          expectedEpoch: 2,
          rematerializationId,
        }),
      ),
    );
    expect(starts.every((result) => result.status === "started")).toBe(true);
    expect(
      starts.every(
        (result) =>
          result.status === "started" &&
          result.lease.recovery.restore.rematerializationId === rematerializationId &&
          result.lease.recovery.restore.selectedRevision === descriptor.revision,
      ),
    ).toBe(true);
    const rival = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 2,
      rematerializationId: crypto.randomUUID(),
    });
    expect(rival.status).toBe("blocked");
    if (rival.status === "blocked") expect(rival.code).toBe("attempt_conflict");

    const recorded = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 2,
      rematerializationId,
      instanceId: "box-after-loss",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "box-after-loss" } },
      },
      leaseTtlMs: 45_000,
    });
    expect(recorded.recorded).toBe(true);
    expect(recorded.lease?.recovery.restore.rematerializationId).toBe(rematerializationId);
    expect(recorded.lease?.recovery.archive.current?.revision).toBe(descriptor.revision);

    const verifying = await markSandboxRestoreVerifying(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 2,
      rematerializationId,
    });
    expect(verifying.wrote).toBe(true);
    const staleCommit = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 2,
      instanceId: "stale-box",
      resumeBackendId: "modal",
      resumeState: { backendId: "modal" },
      rematerialization: {
        id: crypto.randomUUID(),
        verifiedRevision: descriptor.revision,
      },
      leaseTtlMs: 45_000,
    });
    expect(staleCommit.committed).toBe(false);
    expect(staleCommit.reason).toBe("rematerialization_mismatch");

    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 2,
      instanceId: "box-after-loss",
      resumeBackendId: "modal",
      resumeState: {
        backendId: "modal",
        sessionState: { providerState: { sandboxId: "box-after-loss" } },
      },
      rematerialization: {
        id: rematerializationId,
        verifiedRevision: descriptor.revision,
      },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);
    expect(committed.lease?.leaseEpoch).toBe(3);
    expect(committed.lease?.recovery.provider).toMatchObject({
      status: "exists",
      instanceId: "box-after-loss",
    });
    expect(committed.lease?.recovery.restore).toMatchObject({
      status: "ready",
      rematerializationId,
      selectedRevision: descriptor.revision,
    });
    expect(committed.lease?.recovery.workspace).toMatchObject({
      status: "ready",
      verifiedRevision: descriptor.revision,
    });
    const staleVerifying = await markSandboxRestoreVerifying(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: 2,
      rematerializationId,
    });
    expect(staleVerifying.wrote).toBe(false);
  }, 60_000);

  test("(20) a durable per-session fallback archive is imported and selected atomically before restore", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const archive = Buffer.from("legacy-session-fallback-archive").toString("base64");
    const descriptor = {
      version: 1 as const,
      revision: `wa1:1900000000001:${"c".repeat(64)}`,
      archiveSha256: "c".repeat(64),
      archiveBytes: Buffer.from(archive, "base64").length,
      capturedAt: "2030-03-17T17:46:40.001Z",
      workspace: {
        algorithm: "sha256" as const,
        sha256: "d".repeat(64),
        entryCount: 4,
        fileCount: 2,
        totalFileBytes: 31,
      },
    };
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "fallback-importer",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    expect(acquired.lease.recovery.archive.status).toBe("none");

    const rematerializationId = crypto.randomUUID();
    const begun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      rematerializationId,
      archiveSource: {
        backendId: "modal",
        sessionState: {
          providerState: { sandboxId: "dead-session-pointer-must-not-import" },
          workspaceArchive: archive,
          workspaceArchiveMeta: descriptor,
        },
      },
    });
    expect(begun.status).toBe("started");
    if (begun.status === "started") {
      expect(begun.lease.archiveComplete).toBe(true);
      expect(begun.lease.archiveGeneration).toBe(begun.lease.workspaceGeneration);
      expect(begun.lease.recovery.archive.current?.revision).toBe(descriptor.revision);
      expect(begun.lease.recovery.restore).toMatchObject({
        status: "restoring",
        rematerializationId,
        selectedRevision: descriptor.revision,
      });
    }

    const [row] = await admin<
      {
        archive: string | null;
        archive_revision: string | null;
        stale_provider_id: string | null;
      }[]
    >`
      select resume_state #>> '{sessionState,workspaceArchive}' as archive,
             resume_state #>> '{sessionState,workspaceArchiveMeta,revision}' as archive_revision,
             resume_state #>> '{sessionState,providerState,sandboxId}' as stale_provider_id
      from sandbox_leases
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.archive).toBe(archive);
    expect(row?.archive_revision).toBe(descriptor.revision);
    expect(row?.stale_provider_id).toBeNull();

    const rival = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      rematerializationId: crypto.randomUUID(),
      archiveSource: {
        sessionState: {
          workspaceArchive: Buffer.from("rival").toString("base64"),
          workspaceArchiveMeta: {
            ...descriptor,
            revision: `wa1:1900000000002:${"e".repeat(64)}`,
            archiveSha256: "e".repeat(64),
          },
        },
      },
    });
    expect(rival.status).toBe("blocked");
    if (rival.status === "blocked") expect(rival.code).toBe("attempt_conflict");
  }, 60_000);

  test("(21) a legacy native receipt is adopted only at mutation revision zero", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const nativeBytes = Buffer.from(
      'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-legacy","workspace_persistence":"snapshot_filesystem"}',
    );
    const archive = nativeBytes.toString("base64");
    const archiveSha256 = new Bun.CryptoHasher("sha256").update(nativeBytes).digest("hex");
    const descriptor = {
      version: 2 as const,
      kind: "provider_snapshot" as const,
      revision: `wa2:1900000000007:${archiveSha256}`,
      archiveSha256,
      archiveBytes: nativeBytes.length,
      capturedAt: "2030-03-17T17:46:40.007Z",
      provider: "modal_snapshot_filesystem" as const,
      snapshotId: "im-legacy",
      workspacePersistence: "snapshot_filesystem",
    };
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "legacy-native-adoption",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    const rematerializationId = crypto.randomUUID();

    const begun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      rematerializationId,
      archiveSource: {
        backendId: "modal",
        sessionState: { workspaceArchive: archive },
      },
      legacyNativeArchive: { archiveBase64: archive, descriptor },
    });

    expect(begun.status).toBe("started");
    if (begun.status === "started") {
      expect(begun.lease.archiveComplete).toBe(true);
      expect(begun.lease.recovery.archive.current).toMatchObject({
        version: 2,
        kind: "provider_snapshot",
        provider: "modal_snapshot_filesystem",
        snapshotId: "im-legacy",
      });
      expect(begun.lease.recovery.restore.selectedRevision).toBe(descriptor.revision);
      const providerBinding = {
        version: 1,
        serverUrl: "https://modal.test",
        workspaceName: "legacy-restore-workspace",
        environment: "main",
      };
      const adoption = {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        leaseId: acquired.lease.id,
        leaseEpoch: acquired.lease.leaseEpoch,
        workspaceGeneration: begun.lease.workspaceGeneration,
        slot: "current" as const,
        archiveBase64: archive,
        descriptor,
        providerBindingKey: JSON.stringify(providerBinding),
        providerBinding,
      };
      expect(
        await adoptLegacyModalCheckpointArtifact(db, {
          ...adoption,
          rematerializationId: crypto.randomUUID(),
        }),
      ).toBe(false);
      const [beforeAdoption] = await admin<Array<{ count: number }>>`
        select count(*)::int as count
        from sandbox_checkpoint_artifacts
        where object_id = 'im-legacy'`;
      expect(beforeAdoption?.count).toBe(0);

      expect(
        await adoptLegacyModalCheckpointArtifact(db, {
          ...adoption,
          rematerializationId,
        }),
      ).toBe(true);
      expect(
        await adoptLegacyModalCheckpointArtifact(db, {
          ...adoption,
          rematerializationId,
        }),
      ).toBe(true);
      const [adopted] = await admin<
        Array<{
          provenance: string;
          sourceInstanceId: string | null;
          sourceGeneration: number | null;
          currentArtifactId: string | null;
          artifactId: string;
          state: string;
        }>
      >`
        select artifact.provenance,
          artifact.source_instance_id as "sourceInstanceId",
          artifact.source_workspace_generation as "sourceGeneration",
          lease.current_checkpoint_artifact_id as "currentArtifactId",
          artifact.id as "artifactId", artifact.state
        from sandbox_checkpoint_artifacts artifact
        join sandbox_leases lease on lease.id = artifact.source_lease_id
        where artifact.object_id = 'im-legacy'`;
      expect(adopted).toMatchObject({
        provenance: "legacy_provider_adopted",
        sourceInstanceId: null,
        sourceGeneration: null,
        state: "current",
      });
      expect(adopted?.currentArtifactId).toBe(adopted?.artifactId);
    }
  }, 60_000);

  test("(21b) a generation-gap lease may not adopt a legacy native receipt", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const archive = Buffer.from(
      'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-stale","workspace_persistence":"snapshot_filesystem"}',
    ).toString("base64");
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "legacy-native-gap",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    await admin`
      update sandbox_leases
      set workspace_generation = 1
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}
    `;

    const begun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      rematerializationId: crypto.randomUUID(),
      archiveSource: {
        backendId: "modal",
        sessionState: { workspaceArchive: archive },
      },
      legacyNativeArchive: {
        archiveBase64: archive,
        descriptor: {
          version: 2,
          kind: "provider_snapshot",
          revision: `wa2:1900000000008:${"b".repeat(64)}`,
          archiveSha256: "b".repeat(64),
          archiveBytes: Buffer.from(archive, "base64").length,
          capturedAt: "2030-03-17T17:46:48.000Z",
          provider: "modal_snapshot_filesystem",
          snapshotId: "im-stale",
          workspacePersistence: "snapshot_filesystem",
        },
      },
    });

    expect(begun.status).toBe("blocked");
    if (begun.status === "blocked") expect(begun.code).toBe("archive_unverified");
  }, 60_000);

  test("(21c) an exact v1 descriptor around a native receipt is atomically upgraded to v2", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const nativeBytes = Buffer.from(
      'MODAL_SANDBOX_FS_SNAPSHOT_V1\n{"snapshot_id":"im-v1","workspace_persistence":"snapshot_filesystem"}',
    );
    const archive = nativeBytes.toString("base64");
    const archiveSha256 = new Bun.CryptoHasher("sha256").update(nativeBytes).digest("hex");
    const capturedAt = "2030-03-17T17:46:49.000Z";
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "legacy-native-v1",
      backend: "modal",
      leaseTtlMs: 45_000,
    });

    const v2 = {
      version: 2 as const,
      kind: "provider_snapshot" as const,
      revision: `wa2:${Date.parse(capturedAt)}:${archiveSha256}`,
      archiveSha256,
      archiveBytes: nativeBytes.length,
      capturedAt,
      provider: "modal_snapshot_filesystem" as const,
      snapshotId: "im-v1",
      workspacePersistence: "snapshot_filesystem",
    };
    const begun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      rematerializationId: crypto.randomUUID(),
      archiveSource: {
        backendId: "modal",
        sessionState: {
          workspaceArchive: archive,
          workspaceArchiveMeta: {
            version: 1,
            revision: `wa1:${Date.parse(capturedAt)}:${archiveSha256}`,
            archiveSha256,
            archiveBytes: nativeBytes.length,
            capturedAt,
            workspace: {
              algorithm: "sha256",
              sha256: "d".repeat(64),
              entryCount: 3,
              fileCount: 2,
              totalFileBytes: 9,
            },
          },
        },
      },
      legacyNativeArchive: { archiveBase64: archive, descriptor: v2 },
    });

    expect(begun.status).toBe("started");
    if (begun.status === "started") {
      expect(begun.lease.archiveComplete).toBe(true);
      expect(begun.lease.recovery.archive.current).toEqual(v2);
      expect(begun.lease.recovery.restore.selectedRevision).toBe(v2.revision);
    }
  }, 60_000);

  test("(22) an unverified fallback archive becomes degraded and is never selected", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "viewer",
      holderId: "unverified-fallback",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");

    const begun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      rematerializationId: crypto.randomUUID(),
      archiveSource: {
        backendId: "modal",
        sessionState: {
          workspaceArchive: Buffer.from("archive-without-metadata").toString("base64"),
        },
      },
    });
    expect(begun.status).toBe("blocked");
    if (begun.status === "blocked") {
      expect(begun.code).toBe("archive_unverified");
      expect(begun.lease?.recovery.restore).toMatchObject({
        status: "degraded",
        failureCode: "archive_unverified",
        retryable: false,
      });
      expect(begun.lease?.recovery.workspace.status).toBe("degraded");
    }
  }, 60_000);

  test("(22c) checkpoint GC cannot delete the exact native snapshot owned by an active capture receipt", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "capture-owned-checkpoint",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    const providerStarted = new Date();
    expect(
      (
        await recordWarmingSandboxCreated(db, {
          accountId,
          workspaceId,
          sandboxGroupId: groupId,
          expectedEpoch: acquired.lease.leaseEpoch,
          instanceId: "sb-capture-owned-checkpoint",
          resumeBackendId: "modal",
          resumeState: { backendId: "modal", sessionState: {} },
          providerCreatedAt: providerStarted,
          providerDeadlineAt: new Date(providerStarted.getTime() + 86_400_000),
          leaseTtlMs: 45_000,
        })
      ).recorded,
    ).toBe(true);
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "sb-capture-owned-checkpoint",
      resumeBackendId: "modal",
      resumeState: { backendId: "modal", sessionState: {} },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);
    await releaseLeaseHolder(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "capture-owned-checkpoint",
      idleGraceMs: 0,
    });

    const captureId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const capture = await claimWorkspaceArchiveCapture(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      captureId,
      operationId,
      expectedEpoch: committed.lease!.leaseEpoch,
      expectedInstanceId: "sb-capture-owned-checkpoint",
      liveness: "draining",
      captureTimeoutMs: 60_000,
      minIntervalMs: 0,
    });
    expect(capture.status).toBe("claimed");
    if (capture.status !== "claimed") throw new Error("Expected exact capture claim");

    const providerImageId = "im-capture-owned-checkpoint";
    const bytes = Buffer.from(
      `MODAL_SANDBOX_FS_SNAPSHOT_V1\n${JSON.stringify({
        snapshot_id: providerImageId,
        workspace_persistence: "snapshot_filesystem",
      })}`,
    );
    const sha = createHash("sha256").update(bytes).digest("hex");
    const capturedAtMs = 1_900_000_100_000;
    const binding = {
      version: 1,
      serverUrl: "https://modal.test",
      workspaceName: "workspace",
      environment: "main",
    };
    const candidate = await registerSandboxCheckpointArtifact(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      sourceLeaseId: capture.claim.leaseId,
      sourceLeaseEpoch: capture.claim.leaseEpoch,
      sourceInstanceId: capture.claim.instanceId,
      sourceWorkspaceGeneration: capture.claim.workspaceGeneration,
      providerBindingKey: JSON.stringify(binding),
      providerBinding: binding,
      workspaceArchive: bytes.toString("base64"),
      workspaceArchiveMeta: {
        version: 2,
        kind: "provider_snapshot",
        revision: `wa2:${capturedAtMs}:${sha}`,
        archiveSha256: sha,
        archiveBytes: bytes.length,
        capturedAt: new Date(capturedAtMs).toISOString(),
        provider: "modal_snapshot_filesystem",
        snapshotId: providerImageId,
        workspacePersistence: "snapshot_filesystem",
      },
    });
    expect(
      await markSandboxCheckpointArtifactDeletePending(db, {
        accountId,
        workspaceId,
        artifactId: candidate.id,
        reason: "publication outcome pending recovery",
      }),
    ).toBe(true);

    // The capture claim keeps this exact source object out of GC. A successor
    // replay can therefore reclaim the predecessor's pessimistic handoff and
    // publish the same provider image without taking another snapshot.
    const recoveredPublication = await persistDrainSnapshotRaw(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: capture.claim.leaseEpoch,
      expectedInstanceId: capture.claim.instanceId,
      expectedWorkspaceGeneration: capture.claim.workspaceGeneration,
      captureId,
      workspaceArchive: bytes.toString("base64"),
      workspaceArchiveMeta: {
        version: 2,
        kind: "provider_snapshot",
        revision: `wa2:${capturedAtMs}:${sha}`,
        archiveSha256: sha,
        archiveBytes: bytes.length,
        capturedAt: new Date(capturedAtMs).toISOString(),
        provider: "modal_snapshot_filesystem",
        snapshotId: providerImageId,
        workspacePersistence: "snapshot_filesystem",
      },
      checkpointArtifactId: candidate.id,
    });
    expect(recoveredPublication).toEqual({
      wrote: true,
      archiveRevision: `wa2:${capturedAtMs}:${sha}`,
    });
    expect(await readLease(db, workspaceId, groupId)).toMatchObject({
      archiveCapture: { id: captureId, publishedAt: expect.any(Date) },
      currentCheckpointArtifactId: candidate.id,
    });

    const protectedClaims = await claimSandboxCheckpointArtifactsForGc(db, {
      claimId: crypto.randomUUID(),
      limit: 500,
      claimTtlMs: 60_000,
    });
    expect(protectedClaims.some((claim) => claim.id === candidate.id)).toBe(false);

    expect(
      await releaseWorkspaceArchiveCapture(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        captureId,
        expectedEpoch: capture.claim.leaseEpoch,
        expectedInstanceId: capture.claim.instanceId,
      }),
    ).toBe(false);
    const collectibleClaims = await claimSandboxCheckpointArtifactsForGc(db, {
      claimId: crypto.randomUUID(),
      limit: 500,
      claimTtlMs: 60_000,
    });
    expect(collectibleClaims.some((claim) => claim.id === candidate.id)).toBe(false);
  }, 60_000);

  test("(23) native checkpoint publication rotates durable artifact ownership and exposes only the evicted object to GC", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const acquired = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "checkpoint-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    const providerStarted = new Date();
    const recorded = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "sb-checkpoint",
      resumeBackendId: "modal",
      resumeState: { backendId: "modal", sessionState: {} },
      providerCreatedAt: providerStarted,
      providerDeadlineAt: new Date(providerStarted.getTime() + 86_400_000),
      leaseTtlMs: 45_000,
    });
    expect(recorded.recorded).toBe(true);
    const committed = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "sb-checkpoint",
      resumeBackendId: "modal",
      resumeState: { backendId: "modal", sessionState: {} },
      leaseTtlMs: 45_000,
    });
    expect(committed.committed).toBe(true);
    const epoch = committed.lease!.leaseEpoch;
    const binding = {
      version: 1,
      serverUrl: "https://modal.test",
      workspaceName: "workspace",
      environment: "main",
    };
    const bindingKey = JSON.stringify(binding);
    const artifacts: string[] = [];
    const sourceLeaseId = committed.lease!.id;
    let currentEpoch = epoch;
    let currentInstanceId = "sb-checkpoint";
    let currentHolderId = "checkpoint-owner";
    for (let index = 1; index <= 3; index += 1) {
      await releaseLeaseHolder(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        kind: "turn",
        holderId: currentHolderId,
        idleGraceMs: 45_000,
      });
      const capturedAtMs = 1_900_000_000_000 + index;
      const bytes = Buffer.from(
        `MODAL_SANDBOX_FS_SNAPSHOT_V1\n${JSON.stringify({
          snapshot_id: `im-checkpoint-${index}`,
          workspace_persistence: "snapshot_filesystem",
        })}`,
      );
      const sha = createHash("sha256").update(bytes).digest("hex");
      const archive = bytes.toString("base64");
      const descriptor = {
        version: 2 as const,
        kind: "provider_snapshot" as const,
        revision: `wa2:${capturedAtMs}:${sha}`,
        archiveSha256: sha,
        archiveBytes: bytes.length,
        capturedAt: new Date(capturedAtMs).toISOString(),
        provider: "modal_snapshot_filesystem" as const,
        snapshotId: `im-checkpoint-${index}`,
        workspacePersistence: "snapshot_filesystem",
      };
      if (index === 1) {
        await expect(
          persistDrainSnapshot(db, {
            accountId,
            workspaceId,
            sandboxGroupId: groupId,
            expectedEpoch: currentEpoch,
            expectedInstanceId: currentInstanceId,
            expectedWorkspaceGeneration: 0,
            workspaceArchive: archive,
          } as never),
        ).rejects.toThrow("verified workspace archive descriptor");
        await expect(
          persistDrainSnapshot(db, {
            accountId,
            workspaceId,
            sandboxGroupId: groupId,
            expectedEpoch: currentEpoch,
            expectedInstanceId: currentInstanceId,
            expectedWorkspaceGeneration: 0,
            workspaceArchive: archive,
            workspaceArchiveMeta: descriptor,
          }),
        ).rejects.toThrow("requires a registered artifact");
      }
      const candidate = await registerSandboxCheckpointArtifact(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        sourceLeaseId,
        sourceLeaseEpoch: currentEpoch,
        sourceInstanceId: currentInstanceId,
        sourceWorkspaceGeneration: 0,
        providerBindingKey: bindingKey,
        providerBinding: binding,
        workspaceArchive: archive,
        workspaceArchiveMeta: descriptor,
      });
      if (index === 1) {
        let injectUnknownCommitOutcome = true;
        const outcomeUnknownDb = new Proxy(db, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property !== "transaction" || typeof value !== "function") return value;
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(value, target, args);
              if (injectUnknownCommitOutcome) {
                injectUnknownCommitOutcome = false;
                throw new Error("simulated lost transaction commit response");
              }
              return result;
            };
          },
        });
        const reconciledUnknownOutcome = await registerSandboxCheckpointArtifact(outcomeUnknownDb, {
          accountId,
          workspaceId,
          sandboxGroupId: groupId,
          sourceLeaseId,
          sourceLeaseEpoch: currentEpoch,
          sourceInstanceId: currentInstanceId,
          sourceWorkspaceGeneration: 0,
          providerBindingKey: bindingKey,
          providerBinding: binding,
          workspaceArchive: archive,
          workspaceArchiveMeta: descriptor,
        });
        expect(reconciledUnknownOutcome).toEqual(candidate);

        await expect(
          registerSandboxCheckpointArtifact(db, {
            accountId,
            workspaceId,
            sandboxGroupId: groupId,
            sourceLeaseId,
            sourceLeaseEpoch: currentEpoch,
            sourceInstanceId: currentInstanceId,
            sourceWorkspaceGeneration: 0,
            providerBindingKey: bindingKey,
            providerBinding: { ...binding, workspaceName: "different-workspace" },
            workspaceArchive: archive,
            workspaceArchiveMeta: descriptor,
          }),
        ).rejects.toThrow("provider binding key is invalid");

        const directoryBytes = Buffer.from(
          `MODAL_SANDBOX_DIR_SNAPSHOT_V1\n${JSON.stringify({
            snapshot_id: descriptor.snapshotId,
            workspace_persistence: "snapshot_directory",
          })}`,
        );
        const directorySha = createHash("sha256").update(directoryBytes).digest("hex");
        await expect(
          registerSandboxCheckpointArtifact(db, {
            accountId,
            workspaceId,
            sandboxGroupId: groupId,
            sourceLeaseId,
            sourceLeaseEpoch: currentEpoch,
            sourceInstanceId: currentInstanceId,
            sourceWorkspaceGeneration: 0,
            providerBindingKey: bindingKey,
            providerBinding: binding,
            workspaceArchive: directoryBytes.toString("base64"),
            workspaceArchiveMeta: {
              ...descriptor,
              revision: `wa2:${capturedAtMs}:${directorySha}`,
              archiveSha256: directorySha,
              archiveBytes: directoryBytes.length,
              provider: "modal_snapshot_directory",
              workspacePersistence: "snapshot_directory",
            },
          }),
        ).rejects.toThrow(SandboxCheckpointArtifactRegistrationConflictError);
      }
      artifacts.push(candidate.id);
      const drainCaptureId = crypto.randomUUID();
      const claim = await claimWorkspaceArchiveCapture(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        captureId: drainCaptureId,
        expectedEpoch: currentEpoch,
        expectedInstanceId: currentInstanceId,
        liveness: "draining",
        captureTimeoutMs: 60_000,
        minIntervalMs: 0,
      });
      expect(claim.status).toBe("claimed");
      const persisted = await persistDrainSnapshotRaw(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: currentEpoch,
        expectedInstanceId: currentInstanceId,
        expectedWorkspaceGeneration: 0,
        captureId: drainCaptureId,
        workspaceArchive: archive,
        workspaceArchiveMeta: descriptor,
        checkpointArtifactId: candidate.id,
      });
      expect(persisted.wrote).toBe(true);

      const cold = await confirmDrainCold(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: currentEpoch,
        expectedCaptureId: drainCaptureId,
      });
      expect(cold.wentCold).toBe(true);
      if (index === 3) continue;

      currentHolderId = `checkpoint-owner-${index + 1}`;
      const successor = await acquireLease(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        kind: "turn",
        holderId: currentHolderId,
        backend: "modal",
        leaseTtlMs: 45_000,
      });
      expect(successor.role).toBe("spawner");
      currentEpoch = successor.lease.leaseEpoch;
      const rematerializationId = crypto.randomUUID();
      const begun = await beginSandboxRematerialization(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: currentEpoch,
        rematerializationId,
      });
      expect(begun.status).toBe("started");
      currentInstanceId = `sb-checkpoint-restored-${index}`;
      const restored = await recordWarmingSandboxCreated(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: currentEpoch,
        rematerializationId,
        instanceId: currentInstanceId,
        resumeBackendId: "modal",
        resumeState: {
          backendId: "modal",
          sessionState: { providerState: { sandboxId: currentInstanceId } },
        },
        leaseTtlMs: 45_000,
      });
      expect(restored.recorded).toBe(true);
      expect(
        (
          await markSandboxRestoreVerifying(db, {
            accountId,
            workspaceId,
            sandboxGroupId: groupId,
            expectedEpoch: currentEpoch,
            rematerializationId,
          })
        ).wrote,
      ).toBe(true);
      const warm = await commitWarmingToWarm(db, {
        accountId,
        workspaceId,
        sandboxGroupId: groupId,
        expectedEpoch: currentEpoch,
        instanceId: currentInstanceId,
        resumeBackendId: "modal",
        resumeState: {
          backendId: "modal",
          sessionState: { providerState: { sandboxId: currentInstanceId } },
        },
        rematerialization: {
          id: rematerializationId,
          verifiedRevision: descriptor.revision,
        },
        leaseTtlMs: 45_000,
      });
      expect(warm.committed).toBe(true);
      currentEpoch = warm.lease!.leaseEpoch;
    }

    const [evictedArtifactId, previousArtifactId, currentArtifactId] = artifacts;
    if (!evictedArtifactId || !previousArtifactId || !currentArtifactId) {
      throw new Error("checkpoint fixture failed to publish all three artifacts");
    }
    const lease = await readLease(db, workspaceId, groupId);
    expect(lease?.currentCheckpointArtifactId).toBe(currentArtifactId);
    expect(lease?.previousCheckpointArtifactId).toBe(previousArtifactId);
    const states = await admin<Array<{ id: string; state: string }>>`
      select id, state from sandbox_checkpoint_artifacts
      where id in (${evictedArtifactId}, ${previousArtifactId}, ${currentArtifactId})
      order by id`;
    expect(Object.fromEntries(states.map((row) => [row.id, row.state]))).toEqual({
      [evictedArtifactId]: "delete_pending",
      [previousArtifactId]: "previous",
      [currentArtifactId]: "current",
    });
    const successor = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "checkpoint-restore-owner",
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(successor.role).toBe("spawner");
    const begun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: successor.lease.leaseEpoch,
      rematerializationId: crypto.randomUUID(),
    });
    expect(begun.status).toBe("started");
    if (begun.status === "started") {
      expect(begun.checkpointArtifact).toMatchObject({
        id: currentArtifactId,
        providerBackend: "modal",
        providerBindingKey: bindingKey,
        objectKind: "modal_filesystem_snapshot",
        objectId: "im-checkpoint-3",
      });
      expect(begun.checkpointArtifact?.descriptorRevision).toBe(
        begun.lease.recovery.restore.selectedRevision ?? undefined,
      );
    }
    const claims = await claimSandboxCheckpointArtifactsForGc(db, {
      claimId: crypto.randomUUID(),
      limit: 10,
      claimTtlMs: 60_000,
    });
    expect(claims.map((claim) => claim.id)).toEqual([evictedArtifactId]);
  }, 60_000);

  test("(23) Docker continuity serializes restart ownership and preserves the workspace across retry", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const workspaceRootPath = "/var/lib/opengeni/docker-workspaces/exact-continuity";
    const envelope = (containerId: string) => ({
      backendId: "docker",
      opengeniProviderInstanceId: containerId,
      sessionState: {
        providerState: {
          containerId,
          workspaceRootPath,
          workspaceRootOwned: true,
          snapshot: null,
        },
      },
    });

    const initial = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "docker-initial",
      backend: "docker",
      leaseTtlMs: 45_000,
    });
    expect(initial.role).toBe("spawner");
    const warm = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: initial.lease.leaseEpoch,
      instanceId: "docker-old",
      resumeBackendId: "docker",
      resumeState: envelope("docker-old"),
      leaseTtlMs: 45_000,
    });
    expect(warm.committed).toBe(true);

    const lost = await markWarmLeaseInstanceLost(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: warm.lease!.leaseEpoch,
      expectedInstanceId: "docker-old",
    });
    expect(lost.status).toBe("marked");
    if (lost.status !== "marked") throw new Error("Docker loss fixture was stale");
    expect(lost.lease.liveness).toBe("cold");
    expect(lost.lease.recovery.restore.status).toBe("pending");
    expect(lost.lease.recovery.continuity).toEqual({
      version: 1,
      backend: "docker",
      kind: "docker_workspace",
      sourceInstanceId: "docker-old",
      continuityKey: workspaceRootPath,
    });
    expect(lost.lease.resumeState).toMatchObject(envelope("docker-old"));

    const elected = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "docker-recovery",
      backend: "docker",
      leaseTtlMs: 45_000,
    });
    expect(elected.role).toBe("spawner");
    const continuity = elected.lease.recovery.continuity!;
    const wrongRecord = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: elected.lease.leaseEpoch,
      instanceId: "docker-new",
      resumeBackendId: "docker",
      resumeState: envelope("docker-new"),
      continuityRecovery: { ...continuity, continuityKey: `${workspaceRootPath}-wrong` },
      leaseTtlMs: 45_000,
    });
    expect(wrongRecord.recorded).toBe(false);
    const recorded = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: elected.lease.leaseEpoch,
      instanceId: "docker-new",
      resumeBackendId: "docker",
      resumeState: envelope("docker-new"),
      continuityRecovery: continuity,
      leaseTtlMs: 45_000,
    });
    expect(recorded.recorded).toBe(true);

    const omittedReceipt = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: elected.lease.leaseEpoch,
      instanceId: "docker-new",
      resumeBackendId: "docker",
      resumeState: envelope("docker-new"),
      leaseTtlMs: 45_000,
    });
    expect(omittedReceipt).toMatchObject({ committed: false, reason: "continuity_mismatch" });
    const adopted = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: elected.lease.leaseEpoch,
      instanceId: "docker-new",
      resumeBackendId: "docker",
      resumeState: envelope("docker-new"),
      continuityRecovery: continuity,
      leaseTtlMs: 45_000,
    });
    expect(adopted.committed).toBe(true);
    expect(adopted.lease?.recovery.continuity).toBeUndefined();

    const secondLoss = await markWarmLeaseInstanceLost(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: adopted.lease!.leaseEpoch,
      expectedInstanceId: "docker-new",
    });
    expect(secondLoss.status).toBe("marked");
    if (secondLoss.status !== "marked") throw new Error("second Docker loss fixture was stale");
    const retryOwner = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "docker-retry",
      backend: "docker",
      leaseTtlMs: 45_000,
    });
    expect(retryOwner.role).toBe("spawner");
    const retryContinuity = retryOwner.lease.recovery.continuity!;
    const retryRecord = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: retryOwner.lease.leaseEpoch,
      instanceId: "docker-retry-wrapper",
      resumeBackendId: "docker",
      resumeState: envelope("docker-retry-wrapper"),
      continuityRecovery: retryContinuity,
      leaseTtlMs: 45_000,
    });
    expect(retryRecord.recorded).toBe(true);
    await failWarmingToCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: retryOwner.lease.leaseEpoch,
    });
    const retryCold = await readLease(db, workspaceId, groupId);
    expect(retryCold?.liveness).toBe("cold");
    expect(retryCold?.recovery.continuity).toEqual({
      ...retryContinuity,
      sourceInstanceId: "docker-retry-wrapper",
    });
    expect(retryCold?.resumeState).toMatchObject(envelope("docker-retry-wrapper"));
  }, 60_000);

  test("(24) Docker continuity remains authoritative while a verified archive is selected as fallback", async () => {
    if (!available) return;
    const { accountId, workspaceId, groupId } = await freshWorkspace();
    const workspaceRootPath = "/var/lib/opengeni/docker-workspaces/archive-fallback";
    const archive = Buffer.from("older-verified-fallback").toString("base64");
    const descriptor = archiveDescriptor(archive, Date.parse("2031-01-02T03:04:05.000Z"));
    const envelope = (containerId: string) => ({
      backendId: "docker",
      opengeniProviderInstanceId: containerId,
      sessionState: {
        providerState: {
          containerId,
          workspaceRootPath,
          workspaceRootOwned: true,
          snapshot: null,
        },
        workspaceArchive: archive,
        workspaceArchiveMeta: descriptor,
      },
    });
    const initial = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "docker-archive-initial",
      backend: "docker",
      leaseTtlMs: 45_000,
    });
    const warm = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: initial.lease.leaseEpoch,
      instanceId: "docker-archive-old",
      resumeBackendId: "docker",
      resumeState: envelope("docker-archive-old"),
      leaseTtlMs: 45_000,
    });
    expect(warm.committed).toBe(true);
    await admin`
      update sandbox_leases set archive_generation = workspace_generation
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    const lost = await markWarmLeaseInstanceLost(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: warm.lease!.leaseEpoch,
      expectedInstanceId: "docker-archive-old",
    });
    expect(lost.status).toBe("marked");
    const elected = await acquireLease(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: "docker-archive-recovery",
      backend: "docker",
      leaseTtlMs: 45_000,
    });
    expect(elected.role).toBe("spawner");
    const continuity = elected.lease.recovery.continuity!;
    const rematerializationId = crypto.randomUUID();
    const begun = await beginSandboxRematerialization(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: elected.lease.leaseEpoch,
      rematerializationId,
    });
    expect(begun.status).toBe("started");
    if (begun.status !== "started") throw new Error("fallback selection was blocked");
    expect(begun.lease.recovery.continuity).toEqual(continuity);
    const recorded = await recordWarmingSandboxCreated(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: elected.lease.leaseEpoch,
      rematerializationId,
      instanceId: "docker-archive-new",
      resumeBackendId: "docker",
      resumeState: envelope("docker-archive-new"),
      continuityRecovery: continuity,
      leaseTtlMs: 45_000,
    });
    expect(recorded.recorded).toBe(true);
    const adopted = await commitWarmingToWarm(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: elected.lease.leaseEpoch,
      instanceId: "docker-archive-new",
      resumeBackendId: "docker",
      resumeState: envelope("docker-archive-new"),
      continuityRecovery: continuity,
      leaseTtlMs: 45_000,
    });
    expect(adopted.committed).toBe(true);
    expect(adopted.lease?.recovery).toMatchObject({
      archive: { status: "available" },
      restore: { status: "not_required" },
      workspace: { status: "ready" },
    });
    expect(adopted.lease?.recovery.continuity).toBeUndefined();
  }, 60_000);
});
