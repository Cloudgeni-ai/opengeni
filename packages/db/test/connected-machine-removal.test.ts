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
  test("forward migration exposes the tool through the database fallback default", async () => {
    if (!available) return;
    const [column] = await admin<{ column_default: string | null }[]>`
      select column_default
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'sessions'
        and column_name = 'first_party_mcp_tools'`;

    expect(column?.column_default).toContain('"connected_machine_remove"');
  });

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

  test("detaches idle sessions to no compute when removing their connected machine", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:machine-home-${crypto.randomUUID()}`,
    });
    const machine = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "Machine-Home.local",
      enrollmentId: enrollment.id,
    });
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "machine home fixture",
      resources: [],
      metadata: {},
      model: "gpt",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "selfhosted",
    });
    await admin`update sessions set title = 'Machine home session' where id = ${session.id}`;
    const routed = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: machine.id,
      expectedEpoch: session.activeEpoch,
    });
    expect(routed.swapped).toBe(true);

    const removed = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      operationKey: "machine-home-detached",
    });
    expect(removed).toMatchObject({
      outcome: "removed",
      removed: true,
      code: null,
      dependentSessions: [{ id: session.id, title: "Machine home session" }],
    });
    const [pointer] = await admin<
      {
        active_sandbox_id: string | null;
        active_epoch: number;
        sandbox_backend: string;
        sandbox_group_id: string;
      }[]
    >`
      select active_sandbox_id, active_epoch, sandbox_backend, sandbox_group_id
      from sessions where id = ${session.id}`;
    expect(pointer).toEqual({
      active_sandbox_id: null,
      active_epoch: routed.pointer!.activeEpoch + 1,
      sandbox_backend: "none",
      sandbox_group_id: session.id,
    });
    expect((await getEnrollment(db, workspaceId, enrollment.id))?.status).toBe("revoked");
  }, 60_000);

  test("revocation detaches same-account sessions that selected the machine from another workspace", async () => {
    if (!available) return;
    const { accountId, workspaceId: originWorkspaceId } = await freshWorkspace();
    const [targetWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${accountId}, 'connected-machine-consumer') returning id`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${targetWorkspace!.id}, ${accountId})`;
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId: originWorkspaceId,
      pubkey: `ed25519:cross-workspace-removal-${crypto.randomUUID()}`,
      os: "linux",
      arch: "x86_64",
    });
    const machine = await createSandbox(db, {
      accountId,
      workspaceId: originWorkspaceId,
      kind: "selfhosted",
      name: "Personal machine",
      enrollmentId: enrollment.id,
    });
    const session = await createSession(db, {
      accountId,
      workspaceId: targetWorkspace!.id,
      initialMessage: "cross-workspace machine",
      resources: [],
      tools: [],
      toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
      metadata: {},
      model: "gpt-5",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "modal",
    });
    await admin`
      update sessions set active_sandbox_id = ${machine.id}, active_epoch = active_epoch + 1
      where id = ${session.id}`;

    const removed = await removeEnrollment(db, {
      accountId,
      workspaceId: originWorkspaceId,
      enrollmentId: enrollment.id,
      operationKey: "cross-workspace-detach",
    });
    expect(removed).toMatchObject({
      outcome: "removed",
      removed: true,
      dependentSessions: [{ id: session.id, title: null }],
    });
    const [pointer] = await admin<
      { active_sandbox_id: string | null; active_epoch: number; sandbox_backend: string }[]
    >`select active_sandbox_id, active_epoch, sandbox_backend from sessions where id = ${session.id}`;
    expect(pointer).toEqual({
      active_sandbox_id: null,
      active_epoch: 2,
      sandbox_backend: "modal",
    });
  }, 60_000);

  test("fences idempotency keys by enrollment with omitted and equal revisions", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const omittedFirst = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:idempotency-omitted-a-${crypto.randomUUID()}`,
    });
    const omittedSecond = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:idempotency-omitted-b-${crypto.randomUUID()}`,
    });

    const omittedRemoval = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: omittedFirst.id,
      operationKey: "cross-enrollment-omitted",
    });
    expect(omittedRemoval?.outcome).toBe("removed");
    await expect(
      removeEnrollment(db, {
        accountId,
        workspaceId,
        enrollmentId: omittedSecond.id,
        operationKey: "cross-enrollment-omitted",
      }),
    ).rejects.toBeInstanceOf(MachineRemovalIdempotencyError);
    expect((await getEnrollment(db, workspaceId, omittedSecond.id))?.status).toBe("active");

    const equalFirst = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:idempotency-equal-a-${crypto.randomUUID()}`,
    });
    const equalSecond = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: `ed25519:idempotency-equal-b-${crypto.randomUUID()}`,
    });
    const equalRevision = new Date("2026-08-04T10:00:00.000Z");
    await admin`
      update enrollments
      set updated_at = ${equalRevision}
      where id in (${equalFirst.id}, ${equalSecond.id})`;

    const equalRemoval = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: equalFirst.id,
      operationKey: "cross-enrollment-equal",
      expectedUpdatedAt: equalRevision.toISOString(),
    });
    expect(equalRemoval?.outcome).toBe("removed");
    await expect(
      removeEnrollment(db, {
        accountId,
        workspaceId,
        enrollmentId: equalSecond.id,
        operationKey: "cross-enrollment-equal",
        expectedUpdatedAt: equalRevision.toISOString(),
      }),
    ).rejects.toBeInstanceOf(MachineRemovalIdempotencyError);
    expect((await getEnrollment(db, workspaceId, equalSecond.id))?.status).toBe("active");

    const replay = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: equalFirst.id,
      operationKey: "cross-enrollment-equal",
      expectedUpdatedAt: equalRevision.toISOString(),
    });
    expect(replay).toEqual(equalRemoval);
  }, 60_000);

  test("blocks active work and live leases, detaches idle routes, rejects stale revisions, and serializes concurrent removal", async () => {
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
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
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
    const secondSession = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "second active route fixture",
      resources: [],
      metadata: {},
      model: "gpt",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "modal",
    });
    await admin`update sessions set title = 'Second routed session' where id = ${secondSession.id}`;
    const secondRouted = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: secondSession.id,
      targetSandboxId: routedMachine.id,
      expectedEpoch: secondSession.activeEpoch,
    });
    expect(secondRouted.swapped).toBe(true);
    const activeTurnId = crypto.randomUUID();
    await admin`
      update sessions
      set active_turn_id = ${activeTurnId}, status = 'running'
      where id = ${session.id}`;
    const activeTurnBlocked = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: routedEnrollment.id,
      operationKey: "route-active-turn-blocked",
    });
    expect(activeTurnBlocked).toMatchObject({
      outcome: "blocked",
      removed: false,
      code: "active_commands",
      dependentSessions: [
        { id: session.id, title: null },
        { id: secondSession.id, title: "Second routed session" },
      ],
    });
    const [blockedSession] = await admin<
      {
        active_sandbox_id: string | null;
        active_epoch: number;
      }[]
    >`
      select active_sandbox_id, active_epoch
      from sessions where id = ${session.id}`;
    expect(blockedSession).toEqual({
      active_sandbox_id: routedMachine.id,
      active_epoch: routed.pointer!.activeEpoch,
    });
    expect((await getEnrollment(db, workspaceId, routedEnrollment.id))?.status).toBe("active");
    await admin`
      update sessions
      set active_turn_id = null, status = 'idle'
      where id = ${session.id}`;

    const [beforeMove] = await admin<
      {
        id: string;
        status: string;
        active_turn_id: string | null;
        queue_version: number;
        queue_head_position: string;
        queue_tail_position: string;
        last_sequence: number;
      }[]
    >`
      select id, status, active_turn_id, queue_version, queue_head_position,
             queue_tail_position, last_sequence
      from sessions where id = ${session.id}`;
    const removedAfterTurn = await removeEnrollment(db, {
      accountId,
      workspaceId,
      enrollmentId: routedEnrollment.id,
      operationKey: "route-remove-after-turn",
    });
    expect(removedAfterTurn).toMatchObject({
      outcome: "removed",
      removed: true,
      dependentSessions: [
        { id: session.id, title: null },
        { id: secondSession.id, title: "Second routed session" },
      ],
    });
    const movedSessions = await admin<
      {
        id: string;
        active_sandbox_id: string | null;
        active_epoch: number;
        sandbox_backend: string;
        status: string;
        active_turn_id: string | null;
        queue_version: number;
        queue_head_position: string;
        queue_tail_position: string;
        last_sequence: number;
      }[]
    >`
      select id, active_sandbox_id, active_epoch, sandbox_backend, status, active_turn_id,
             queue_version, queue_head_position, queue_tail_position, last_sequence
      from sessions where id in (${session.id}, ${secondSession.id}) order by created_at, id`;
    expect(movedSessions.map((row) => [row.id, row.active_sandbox_id, row.active_epoch])).toEqual([
      [session.id, null, routed.pointer!.activeEpoch + 1],
      [secondSession.id, null, secondRouted.pointer!.activeEpoch + 1],
    ]);
    expect(movedSessions.map((row) => row.sandbox_backend)).toEqual(["modal", "modal"]);
    expect(movedSessions[0]).toMatchObject(beforeMove!);

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
