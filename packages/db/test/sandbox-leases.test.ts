import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  acquireLease,
  beginSandboxRematerialization,
  commitWarmingToWarm,
  confirmDrainCold,
  createDb,
  getMaterializedSandboxFileResources,
  heartbeatLeaseHolder,
  markSandboxRestoreVerifying,
  markWarmLeaseInstanceLost,
  markSandboxFileResourcesMaterialized,
  persistDrainSnapshot,
  readLease,
  recordWarmingSandboxCreated,
  reapStaleLeaseHolders,
  reapStaleLeaseHoldersGlobal,
  releaseLeaseHolder,
  SandboxImageConflictError,
  SandboxRigConflictError,
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
});

describe("0017 sandbox lease state machine (real packages/db + RLS)", () => {
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
    const archive = Buffer.from("ope-60-pre-create-timeout-archive").toString("base64");
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
    const archive = Buffer.from("ope-60-scoped-timeout-archive").toString("base64");
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

  test("(2b) file materialization markers are keyed by warm box instance and epoch", async () => {
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
    const persisted = await persistDrainSnapshot(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: epoch,
      workspaceArchive: ARCHIVE_B64,
    });
    expect(persisted.wrote).toBe(true);

    // Now the cold commit — the seam that USED to wipe the archive.
    const cold = await confirmDrainCold(db, {
      accountId,
      workspaceId,
      sandboxGroupId: groupId,
      expectedEpoch: epoch,
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

  test("(11) image B3: warm box + SOLO holder + DIFFERENT image -> recreate (cold, re-stamped, spawner)", async () => {
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
    // The SAME solo holder re-arrives resolving a DIFFERENT image -> recreate. acquireLease
    // resets to cold, re-stamps img-B, and CASes the holder back in as spawner.
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
    expect(res.role).toBe("spawner");
    const [row] = await admin<
      {
        liveness: string;
        image: string | null;
        instance_id: string | null;
        resume_state: unknown;
      }[]
    >`
      select liveness, image, instance_id, resume_state from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    // Warming (spawner will cold-create on the NEW image), image re-stamped, live-box
    // fields cleared (a divergent image cannot replay the old box's live state).
    expect(row?.liveness).toBe("warming");
    expect(row?.image).toBe("img-B");
    expect(row?.instance_id).toBeNull();
    expect(row?.resume_state).toBeNull();
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

  test("(15) rig M3: warm box + SOLO holder + DIFFERENT rig -> recreate (cold, re-stamped, spawner)", async () => {
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
    // SAME solo holder, SAME image, DIFFERENT rig -> recreate cold, re-stamp the rig,
    // and CAS back in as spawner. The image (unchanged) is preserved by the
    // conditional re-stamp; the rig column moves to the new version.
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
    expect(res.role).toBe("spawner");
    const [row] = await admin<
      {
        liveness: string;
        image: string | null;
        rig_version_id: string | null;
        instance_id: string | null;
        resume_state: unknown;
      }[]
    >`
      select liveness, image, rig_version_id, instance_id, resume_state from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    expect(row?.liveness).toBe("warming");
    expect(row?.image).toBe("img-A"); // image-only re-stamp did NOT clobber the image
    expect(row?.rig_version_id).toBe("bbbb2222-2222-4222-8222-222222222222");
    expect(row?.instance_id).toBeNull();
    expect(row?.resume_state).toBeNull();
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
    const archive = Buffer.from("ope-60-exact-durable-revision").toString("base64");
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
      capturedAt: "2030-03-17T17:46:41.000Z",
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

  test("(21) an unverified fallback archive becomes degraded and is never selected", async () => {
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
});
