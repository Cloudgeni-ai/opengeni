import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createEnrollment,
  createSandbox,
  createSession,
  getEnrollment,
  getSandbox,
  listEnrollments,
  removeEnrollment,
  MachineRemovalIdempotencyError,
  MachineRemovalRevisionConflictError,
  setActiveSandbox,
  touchEnrollmentLastSeen,
  type DbClient,
  type Database,
} from "../src/index";

// The normal CI path uses the shared pgvector container. Local verification can
// point this file at a real PostgreSQL 16 instance without changing the shared
// harness contract:
//
//   OPENGENI_CONNECTED_MACHINE_REMOVAL_ADMIN_URL=... \
//   OPENGENI_CONNECTED_MACHINE_REMOVAL_APP_URL=... \
//   bun test packages/db/test/connected-machine-removal.test.ts
const localAdminUrl = process.env.OPENGENI_CONNECTED_MACHINE_REMOVAL_ADMIN_URL?.trim();
const localAppUrl = process.env.OPENGENI_CONNECTED_MACHINE_REMOVAL_APP_URL?.trim();

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('connected-machine-removal') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'connected-machine-removal') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

beforeAll(async () => {
  if (localAdminUrl && localAppUrl) {
    admin = postgres(localAdminUrl, { max: 2, prepare: false });
    client = createDb(localAppUrl, { max: 4 });
    db = client.db;
    return;
  }
  shared = await acquireSharedTestDatabase("connected-machine-removal");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[connected-machine-removal] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  if (localAdminUrl) {
    await admin?.end().catch(() => undefined);
  }
  await shared?.release();
}, 180_000);

describe("connected machine removal lifecycle", () => {
  test("removes an offline enrollment without deleting history, rejects stale heartbeat, and replays idempotently", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();

    const posture = await admin<{ relforcerowsecurity: boolean; rolbypassrls: boolean }[]>`
      select c.relforcerowsecurity, r.rolbypassrls
      from pg_class c
      cross join pg_roles r
      where c.relname = 'machine_removal_operations'
        and r.rolname = 'opengeni_app'`;
    expect(posture[0]?.relforcerowsecurity).toBe(true);
    expect(posture[0]?.rolbypassrls).toBe(false);

    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:removal-${crypto.randomUUID()}`,
      os: "macos",
      arch: "arm64",
    });
    const machine = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "Offline-Mac.local",
      enrollmentId: enrollment.id,
    });
    const lastSeenAt = new Date("2026-08-04T09:13:46.102Z");
    await admin`
      update enrollments set last_seen_at = ${lastSeenAt}, updated_at = now()
      where id = ${enrollment.id}`;
    const loaded = await getEnrollment(db, workspaceId, enrollment.id);
    expect(loaded?.lastSeenAt).toBe(lastSeenAt.toISOString());

    const result = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      operationKey: "offline-remove-1",
      expectedUpdatedAt: loaded!.updatedAt,
    });
    expect(result).toMatchObject({
      enrollmentId: enrollment.id,
      outcome: "removed",
      removed: true,
      machineName: machine.name,
      lastSeenAt: lastSeenAt.toISOString(),
      code: null,
    });

    expect(await listEnrollments(db, workspaceId, { status: "active" })).toHaveLength(0);
    expect(await listEnrollments(db, workspaceId, { status: "revoked" })).toHaveLength(1);
    expect(await getSandbox(db, workspaceId, machine.id)).not.toBeNull();

    const afterRemoval = await getEnrollment(db, workspaceId, enrollment.id);
    await touchEnrollmentLastSeen(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
    });
    const afterStaleHeartbeat = await getEnrollment(db, workspaceId, enrollment.id);
    expect(afterStaleHeartbeat?.status).toBe("revoked");
    expect(afterStaleHeartbeat?.lastSeenAt).toBe(afterRemoval?.lastSeenAt);

    const replay = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      operationKey: "offline-remove-1",
      expectedUpdatedAt: loaded!.updatedAt,
    });
    expect(replay).toEqual(result);

    await expect(
      removeEnrollment(db, {
        accountId,
        workspaceId,
        enrollmentId: enrollment.id,
        operationKey: "offline-remove-1",
      }),
    ).rejects.toBeInstanceOf(MachineRemovalIdempotencyError);

    const [audit] = await admin<{ action: string; target_id: string }[]>`
      select action, target_id from audit_events
      where workspace_id = ${workspaceId} and target_id = ${enrollment.id}
      order by occurred_at desc limit 1`;
    expect(audit).toEqual({ action: "connected_machine.removed", target_id: enrollment.id });
  }, 60_000);

  test("removes only the selected duplicate enrollment", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const first = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:duplicate-a-${crypto.randomUUID()}`,
      os: "macos",
      arch: "arm64",
    });
    const second = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:duplicate-b-${crypto.randomUUID()}`,
      os: "macos",
      arch: "arm64",
    });
    await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "Jrgens-MacBook-Pro-2.local",
      enrollmentId: first.id,
    });
    await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "Jrgens-MacBook-Pro-2.local",
      enrollmentId: second.id,
    });

    const removed = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: first.id,
      operationKey: "duplicate-first",
    });
    expect(removed?.outcome).toBe("removed");
    expect((await getEnrollment(db, workspaceId, first.id))?.status).toBe("revoked");
    expect((await getEnrollment(db, workspaceId, second.id))?.status).toBe("active");
    expect((await listEnrollments(db, workspaceId, { status: "active" })).map((x) => x.id)).toEqual(
      [second.id],
    );
  }, 60_000);

  test("blocks active routing and live leases, rejects stale revisions, and serializes concurrent removal", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const routedEnrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:routed-${crypto.randomUUID()}`,
    });
    const routedMachine = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "Routed-Mac.local",
      enrollmentId: routedEnrollment.id,
    });
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "active route fixture",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "modal",
    });
    const routed = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: routedMachine.id,
      expectedEpoch: session.activeEpoch,
    });
    expect(routed.swapped).toBe(true);
    const routeBlocked = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: routedEnrollment.id,
      operationKey: "route-blocked",
    });
    expect(routeBlocked).toMatchObject({ outcome: "blocked", code: "active_route" });
    const detached = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: null,
      expectedEpoch: routed.pointer!.activeEpoch,
    });
    expect(detached.swapped).toBe(true);

    const leasedEnrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:leased-${crypto.randomUUID()}`,
    });
    const leasedMachine = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "Leased-Mac.local",
      enrollmentId: leasedEnrollment.id,
    });
    await admin`
      insert into sandbox_leases
        (account_id, workspace_id, sandbox_group_id, liveness, refcount, backend, expires_at)
      values
        (${accountId}, ${workspaceId}, ${leasedMachine.id}, 'warm', 1, 'selfhosted', now() + interval '1 hour')`;
    const leaseBlocked = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: leasedEnrollment.id,
      operationKey: "lease-blocked",
    });
    expect(leaseBlocked).toMatchObject({ outcome: "blocked", code: "active_lease" });
    await admin`
      update sandbox_leases set liveness = 'cold', refcount = 0
      where workspace_id = ${workspaceId} and sandbox_group_id = ${leasedMachine.id}`;
    const leaseRemoved = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: leasedEnrollment.id,
      operationKey: "lease-removed",
    });
    expect(leaseRemoved?.outcome).toBe("removed");

    const staleEnrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:stale-${crypto.randomUUID()}`,
    });
    const staleRevision = staleEnrollment.updatedAt;
    await touchEnrollmentLastSeen(db, {
      accountId,
      workspaceId,
      enrollmentId: staleEnrollment.id,
    });
    await expect(
      removeEnrollment(db, {
        accountId,
        workspaceId,
        enrollmentId: staleEnrollment.id,
        operationKey: "stale-revision",
        expectedUpdatedAt: staleRevision,
      }),
    ).rejects.toBeInstanceOf(MachineRemovalRevisionConflictError);

    const concurrentEnrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:concurrent-${crypto.randomUUID()}`,
    });
    const concurrentResults = await Promise.all([
      removeEnrollment(db, {
        accountId,
        workspaceId,
        enrollmentId: concurrentEnrollment.id,
        operationKey: "concurrent-a",
      }),
      removeEnrollment(db, {
        accountId,
        workspaceId,
        enrollmentId: concurrentEnrollment.id,
        operationKey: "concurrent-b",
      }),
    ]);
    expect(concurrentResults.map((x) => x?.outcome).sort()).toEqual(["already_removed", "removed"]);
    expect((await getEnrollment(db, workspaceId, concurrentEnrollment.id))?.status).toBe("revoked");
  }, 60_000);
});
