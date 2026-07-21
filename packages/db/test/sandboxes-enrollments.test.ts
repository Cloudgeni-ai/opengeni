import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  clearEnrollmentWentOffline,
  createDb,
  createEnrollment,
  createSandbox,
  createSession,
  getEnrollment,
  getSandbox,
  getSession,
  ingestMachineMetricsSample,
  insertMachineMetricsSeries,
  listEnrollments,
  listSandboxes,
  readActiveSandbox,
  readMachineMetricsLatest,
  readMachineMetricsLatestForWorkspace,
  readMachineMetricsSeries,
  revokeEnrollment,
  revokeEnrollmentByGeneration,
  sessionsWithActiveOpOnEnrollment,
  setActiveSandbox,
  setEnrollmentWentOffline,
  touchEnrollmentLastSeen,
  upsertMachineMetricsLatest,
  type Database,
  type DbClient,
} from "../src/index";

// M2 (bring-your-own-compute): the 0024 sandboxes/enrollments/metrics DAOs +
// the per-session epoch-fenced active-sandbox pointer + the mapSession round-trip
// (active_sandbox_id/active_epoch), driven through the REAL packages/db query fns
// against a THROWAWAY postgres database (acquired from the SHARED test container —
// see packages/testing/src/shared-pg.ts — so the full parallel `bun test` run does
// not spin up one container per file). The package fns connect as opengeni_app (a
// NON-superuser, so FORCE RLS genuinely applies); accounts/workspaces are seeded as
// the postgres superuser (bypasses RLS). pgvector image because 0000_initial does
// CREATE EXTENSION vector. The database is dropped + the shared refcount released
// in afterAll regardless of outcome.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

// Seed a fresh (account, workspace) as the superuser (bypasses RLS).
async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("sandboxes-enrollments");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[sandboxes-enrollments] docker unavailable, skipping");
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

describe("0024 sandboxes / enrollments / metrics DAOs + active-sandbox pointer", () => {
  test("migration adds sessions.active_sandbox_id (nullable) + active_epoch (NOT NULL default 0, integer)", async () => {
    if (!available) return;
    const cols = await admin<
      {
        column_name: string;
        is_nullable: string;
        data_type: string;
        column_default: string | null;
      }[]
    >`
      SELECT column_name, is_nullable, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'sessions' AND column_name IN ('active_sandbox_id', 'active_epoch')
      ORDER BY column_name`;
    const map = new Map(cols.map((c) => [c.column_name, c]));
    const pointer = map.get("active_sandbox_id");
    expect(pointer).toBeDefined();
    expect(pointer!.is_nullable).toBe("YES");
    expect(pointer!.data_type).toBe("uuid");
    const epoch = map.get("active_epoch");
    expect(epoch).toBeDefined();
    expect(epoch!.is_nullable).toBe("NO");
    expect(epoch!.data_type).toBe("integer");
    expect(epoch!.column_default).toContain("0");
  }, 60_000);

  test("enrollment create -> get -> list, idempotent re-enroll (upsert), revoke (+ re-activate)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();

    const created = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: "ed25519:AAAA",
      hasDisplay: true,
      os: "linux",
      arch: "x86_64",
    });
    expect(created.status).toBe("active");
    expect(created.credentialGeneration).toBe(1);
    expect(created.exposure).toBe("whole-machine");
    expect(created.hasDisplay).toBe(true);
    expect(created.allowScreenControl).toBe(false);
    expect(created.lastSeenAt).toBeNull();
    expect(created.revokedAt).toBeNull();

    const fetched = await getEnrollment(db, workspaceId, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.pubkey).toBe("ed25519:AAAA");

    // Re-enroll of the SAME (workspace, pubkey) -> SAME row id, updated consent
    // fields, NOT a duplicate, and a new credential generation.
    const reEnrolled = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: "ed25519:AAAA",
      hasDisplay: false,
      allowScreenControl: true,
      os: "linux",
    });
    expect(reEnrolled.id).toBe(created.id);
    expect(reEnrolled.credentialGeneration).toBe(2);
    expect(reEnrolled.hasDisplay).toBe(false);
    expect(reEnrolled.allowScreenControl).toBe(true);

    const all = await listEnrollments(db, workspaceId);
    expect(all.length).toBe(1);
    const active = await listEnrollments(db, workspaceId, { status: "active" });
    expect(active.length).toBe(1);

    // heartbeat cursor
    await touchEnrollmentLastSeen(db, { accountId, workspaceId, enrollmentId: created.id });
    const afterTouch = await getEnrollment(db, workspaceId, created.id);
    expect(afterTouch?.lastSeenAt).not.toBeNull();

    // revoke -> idempotent
    const r1 = await revokeEnrollment(db, { accountId, workspaceId, enrollmentId: created.id });
    expect(r1.revoked).toBe(true);
    const r2 = await revokeEnrollment(db, { accountId, workspaceId, enrollmentId: created.id });
    expect(r2.revoked).toBe(false); // already revoked
    const revoked = await getEnrollment(db, workspaceId, created.id);
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokedAt).not.toBeNull();
    expect((await listEnrollments(db, workspaceId, { status: "active" })).length).toBe(0);

    // re-enroll re-activates (status->active, revoked_at cleared)
    const reactivated = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: "ed25519:AAAA",
    });
    expect(reactivated.id).toBe(created.id);
    expect(reactivated.status).toBe("active");
    expect(reactivated.revokedAt).toBeNull();
    expect(reactivated.credentialGeneration).toBe(3);
  }, 60_000);

  test("generation-fenced self-revoke is retry-safe, stale-proof, and tenant-isolated", async () => {
    if (!available) return;
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const first = await createEnrollment(db, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      pubkey: "ed25519:GENERATION-FENCE",
    });
    expect(first.credentialGeneration).toBe(1);

    const revoked = await revokeEnrollmentByGeneration(db, {
      workspaceId: a.workspaceId,
      enrollmentId: first.id,
      credentialGeneration: 1,
    });
    expect(revoked).toEqual({ matched: true, revoked: true });
    const lostResponseRetry = await revokeEnrollmentByGeneration(db, {
      workspaceId: a.workspaceId,
      enrollmentId: first.id,
      credentialGeneration: 1,
    });
    expect(lostResponseRetry).toEqual({ matched: true, revoked: false });

    const second = await createEnrollment(db, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      pubkey: "ed25519:GENERATION-FENCE",
    });
    expect(second.id).toBe(first.id);
    expect(second.credentialGeneration).toBe(2);
    expect(second.status).toBe("active");

    // The old family cannot revoke the active re-enrollment.
    expect(
      await revokeEnrollmentByGeneration(db, {
        workspaceId: a.workspaceId,
        enrollmentId: second.id,
        credentialGeneration: 1,
      }),
    ).toEqual({ matched: false, revoked: false });
    expect((await getEnrollment(db, a.workspaceId, second.id))?.status).toBe("active");

    // Workspace B cannot resolve or mutate A's enrollment even with the right id
    // and current generation; the FORCE-RLS scoped lookup is intentionally flat.
    expect(
      await revokeEnrollmentByGeneration(db, {
        workspaceId: b.workspaceId,
        enrollmentId: second.id,
        credentialGeneration: 2,
      }),
    ).toEqual({ matched: false, revoked: false });
    expect((await getEnrollment(db, a.workspaceId, second.id))?.status).toBe("active");

    expect(
      await revokeEnrollmentByGeneration(db, {
        workspaceId: a.workspaceId,
        enrollmentId: second.id,
        credentialGeneration: 2,
      }),
    ).toEqual({ matched: true, revoked: true });
  }, 60_000);

  test("clean going-offline marker: set → clear-on-heartbeat and clear-on-Hello (change-guarded)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const created = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: "ed25519:GOODBYE",
      hasDisplay: true,
    });
    // A machine reporting a heartbeat first (fresh last_seen, no marker).
    await touchEnrollmentLastSeen(db, { accountId, workspaceId, enrollmentId: created.id });
    const online = await getEnrollment(db, workspaceId, created.id);
    expect(online?.wentOfflineAt).toBeNull();
    expect(online?.lastSeenAt).not.toBeNull();

    // GoingOffline stamps the marker (WHEN + typed reason) WITHOUT touching last_seen.
    await setEnrollmentWentOffline(db, {
      accountId,
      workspaceId,
      enrollmentId: created.id,
      reason: "GOING_OFFLINE_REASON_HOST_SHUTDOWN",
    });
    const goodbye = await getEnrollment(db, workspaceId, created.id);
    expect(goodbye?.wentOfflineAt).not.toBeNull();
    expect(goodbye?.wentOfflineReason).toBe("GOING_OFFLINE_REASON_HOST_SHUTDOWN");
    // last_seen is NOT bumped by the goodbye (a shutdown must not look more alive).
    expect(goodbye?.lastSeenAt).toBe(online?.lastSeenAt);

    // A fresh heartbeat clears the marker in the SAME update that bumps last_seen.
    await touchEnrollmentLastSeen(db, { accountId, workspaceId, enrollmentId: created.id });
    const revived = await getEnrollment(db, workspaceId, created.id);
    expect(revived?.wentOfflineAt).toBeNull();
    expect(revived?.wentOfflineReason).toBeNull();

    // clearEnrollmentWentOffline (the Hello path): reports cleared only when a
    // marker was present, and is a no-op (cleared:false) on a steady-state clear.
    await setEnrollmentWentOffline(db, {
      accountId,
      workspaceId,
      enrollmentId: created.id,
      reason: "GOING_OFFLINE_REASON_USER_STOP",
    });
    const firstClear = await clearEnrollmentWentOffline(db, {
      accountId,
      workspaceId,
      enrollmentId: created.id,
    });
    expect(firstClear.cleared).toBe(true);
    expect((await getEnrollment(db, workspaceId, created.id))?.wentOfflineAt).toBeNull();
    const secondClear = await clearEnrollmentWentOffline(db, {
      accountId,
      workspaceId,
      enrollmentId: created.id,
    });
    expect(secondClear.cleared).toBe(false); // nothing to clear → no churn
  }, 60_000);

  test("sessionsWithActiveOpOnEnrollment: only active-sandbox + running-turn sessions for enrollment X", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enrollX = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: "ed25519:FANX",
      hasDisplay: true,
    });
    const enrollY = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: "ed25519:FANY",
      hasDisplay: true,
    });
    const sandX = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "machine-x",
      enrollmentId: enrollX.id,
    });
    const sandY = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "machine-y",
      enrollmentId: enrollY.id,
    });
    const sandModal = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "group-box",
    });

    const mkSession = async () =>
      await createSession(db, {
        accountId,
        workspaceId,
        initialMessage: "hi",
        resources: [],
        metadata: {},
        model: "gpt",
        sandboxBackend: "modal",
      });
    const point = async (sessionId: string, sandboxId: string) =>
      await setActiveSandbox(db, {
        accountId,
        workspaceId,
        sessionId,
        targetSandboxId: sandboxId,
        expectedEpoch: 0,
      });
    const setTurn = async (sessionId: string, turnId: string) =>
      await admin`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`;

    // INCLUDED: pointer → machine X's sandbox + a running turn.
    const included = await mkSession();
    await point(included.id, sandX.id);
    const includedTurn = "cccccccc-0000-4000-8000-000000000001";
    await setTurn(included.id, includedTurn);

    // EXCLUDED: pointer → machine X but NO running turn (active_turn_id null).
    const noTurn = await mkSession();
    await point(noTurn.id, sandX.id);

    // EXCLUDED: pointer → machine Y's sandbox (a different enrollment) + a turn.
    const otherEnrollment = await mkSession();
    await point(otherEnrollment.id, sandY.id);
    await setTurn(otherEnrollment.id, "cccccccc-0000-4000-8000-000000000002");

    // EXCLUDED: pointer → the Modal group box (kind != selfhosted) + a turn.
    const modal = await mkSession();
    await point(modal.id, sandModal.id);
    await setTurn(modal.id, "cccccccc-0000-4000-8000-000000000003");

    const rows = await sessionsWithActiveOpOnEnrollment(db, {
      workspaceId,
      enrollmentId: enrollX.id,
    });
    expect(rows).toEqual([{ sessionId: included.id, activeTurnId: includedTurn }]);
  }, 60_000);

  test("sandbox create: selfhosted requires enrollment, modal forbids it; get + list", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: "ed25519:BBBB",
    });

    const modal = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "cloud box",
    });
    expect(modal.kind).toBe("modal");
    expect(modal.enrollmentId).toBeNull();

    const selfhosted = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "selfhosted",
      name: "my laptop",
      enrollmentId: enrollment.id,
    });
    expect(selfhosted.kind).toBe("selfhosted");
    expect(selfhosted.enrollmentId).toBe(enrollment.id);

    // Typed pre-checks (a selfhosted sandbox MUST carry an enrollment; modal MUST NOT).
    await expect(
      createSandbox(db, { accountId, workspaceId, kind: "selfhosted", name: "bad" }),
    ).rejects.toThrow(/requires an enrollmentId/);
    await expect(
      createSandbox(db, {
        accountId,
        workspaceId,
        kind: "modal",
        name: "bad",
        enrollmentId: enrollment.id,
      }),
    ).rejects.toThrow(/must not carry an enrollmentId/);

    const fetched = await getSandbox(db, workspaceId, selfhosted.id);
    expect(fetched?.id).toBe(selfhosted.id);

    const list = await listSandboxes(db, workspaceId);
    expect(list.length).toBe(2);
    expect(new Set(list.map((s) => s.kind))).toEqual(new Set(["modal", "selfhosted"]));
  }, 60_000);

  test("the selfhosted<->enrollment DB CHECK rejects a raw violation (defense in depth)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    // Bypass the typed pre-check by writing raw as the superuser — the DB CHECK
    // must still reject a selfhosted sandbox with no enrollment.
    let rejected = false;
    try {
      await admin`
        insert into sandboxes (account_id, workspace_id, kind, name, enrollment_id)
        values (${accountId}, ${workspaceId}, 'selfhosted', 'bad', null)`;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  }, 60_000);

  test("active-sandbox pointer: epoch-fenced swap; a stale-epoch swap loses; mapSession round-trip carries it", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();

    // A fresh session: active_sandbox_id NULL, active_epoch 0 (the backward-compat
    // default) — and the mapSession round-trip carries BOTH new columns.
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "modal",
    });
    expect(session.activeSandboxId).toBeNull();
    expect(session.activeEpoch).toBe(0);
    const reread = await getSession(db, workspaceId, session.id);
    expect(reread?.activeSandboxId).toBeNull();
    expect(reread?.activeEpoch).toBe(0);

    const pointer0 = await readActiveSandbox(db, workspaceId, session.id);
    expect(pointer0).toEqual({ activeSandboxId: null, activeEpoch: 0, workingDir: null });

    const target = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "target",
    });

    // Swap at the correct epoch -> wins, epoch bumps to 1, pointer set.
    const swap1 = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: target.id,
      expectedEpoch: 0,
    });
    expect(swap1.swapped).toBe(true);
    expect(swap1.pointer).toEqual({ activeSandboxId: target.id, activeEpoch: 1, workingDir: null });

    // A concurrent double-swap reading the OLD epoch (0) loses — the fence rejects it.
    const stale = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: null,
      expectedEpoch: 0,
    });
    expect(stale.swapped).toBe(false);
    expect(stale.pointer).toBeNull();

    // The pointer is unchanged by the losing swap.
    expect(await readActiveSandbox(db, workspaceId, session.id)).toEqual({
      activeSandboxId: target.id,
      activeEpoch: 1,
      workingDir: null,
    });

    // Swap back to the group sandbox (NULL) at the current epoch -> wins, epoch 2.
    const swap2 = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: null,
      expectedEpoch: 1,
    });
    expect(swap2.swapped).toBe(true);
    expect(swap2.pointer).toEqual({ activeSandboxId: null, activeEpoch: 2, workingDir: null });

    // The full session re-read reflects the pointer (mapSession round-trip).
    const rereadAfter = await getSession(db, workspaceId, session.id);
    expect(rereadAfter?.activeSandboxId).toBeNull();
    expect(rereadAfter?.activeEpoch).toBe(2);

    // Deleting the pointed-at sandbox degrades the pointer to NULL (ON DELETE SET
    // NULL), never a dangling FK. Re-point first, then delete.
    const swap3 = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: target.id,
      expectedEpoch: 2,
    });
    expect(swap3.swapped).toBe(true);
    await admin`delete from sandboxes where id = ${target.id}`;
    const afterDelete = await readActiveSandbox(db, workspaceId, session.id);
    expect(afterDelete?.activeSandboxId).toBeNull();
  }, 60_000);

  test("active-sandbox pointer carries the per-session working_dir (create-time seed / leave-unchanged / clear)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const session = await createSession(db, {
      accountId,
      workspaceId,
      initialMessage: "hi",
      resources: [],
      metadata: {},
      model: "gpt",
      sandboxBackend: "modal",
    });
    const target = await createSandbox(db, {
      accountId,
      workspaceId,
      kind: "modal",
      name: "wd-target",
    });

    // A fresh pointer has a NULL working_dir (today's default — byte-identical no-op).
    expect(await readActiveSandbox(db, workspaceId, session.id)).toEqual({
      activeSandboxId: null,
      activeEpoch: 0,
      workingDir: null,
    });

    // Seeding the pointer WITH a working_dir writes it in the SAME epoch-fenced CAS
    // (the create-time machine-targeting path), and readActiveSandbox surfaces it.
    const seed = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: target.id,
      expectedEpoch: 0,
      workingDir: "/home/u/proj",
    });
    expect(seed.swapped).toBe(true);
    expect(seed.pointer).toEqual({
      activeSandboxId: target.id,
      activeEpoch: 1,
      workingDir: "/home/u/proj",
    });
    expect(await readActiveSandbox(db, workspaceId, session.id)).toEqual({
      activeSandboxId: target.id,
      activeEpoch: 1,
      workingDir: "/home/u/proj",
    });

    // A plain swap with workingDir OMITTED (undefined) leaves the column UNCHANGED —
    // a live swap/attach never touches the working dir.
    const plainSwap = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: null,
      expectedEpoch: 1,
    });
    expect(plainSwap.swapped).toBe(true);
    expect(plainSwap.pointer).toEqual({
      activeSandboxId: null,
      activeEpoch: 2,
      workingDir: "/home/u/proj",
    });
    expect(await readActiveSandbox(db, workspaceId, session.id)).toEqual({
      activeSandboxId: null,
      activeEpoch: 2,
      workingDir: "/home/u/proj",
    });

    // Explicit null clears it back to the default.
    const cleared = await setActiveSandbox(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      targetSandboxId: null,
      expectedEpoch: 2,
      workingDir: null,
    });
    expect(cleared.swapped).toBe(true);
    expect(cleared.pointer).toEqual({ activeSandboxId: null, activeEpoch: 3, workingDir: null });
    expect(await readActiveSandbox(db, workspaceId, session.id)).toEqual({
      activeSandboxId: null,
      activeEpoch: 3,
      workingDir: null,
    });
  }, 60_000);

  test("metrics: last-sample upsert (one row per enrollment) + append-only series", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: "ed25519:CCCC",
    });

    await upsertMachineMetricsLatest(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      sample: {
        cpuPercent: 12.5,
        load1: 0.5,
        memUsedBytes: 1024,
        memTotalBytes: 4096,
        sampledAt: new Date(),
      },
    });
    const latest1 = await admin<{ cpu_percent: string; mem_used_bytes: string }[]>`
      select cpu_percent, mem_used_bytes from machine_metrics_latest where enrollment_id = ${enrollment.id}`;
    expect(latest1.length).toBe(1);
    expect(Number(latest1[0]!.cpu_percent)).toBe(12.5);

    // Second upsert overwrites the SAME row (one row per enrollment).
    await upsertMachineMetricsLatest(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      sample: { cpuPercent: 88, contention: 3, sampledAt: new Date() },
    });
    const latest2 = await admin<{ cpu_percent: string }[]>`
      select cpu_percent from machine_metrics_latest where enrollment_id = ${enrollment.id}`;
    expect(latest2.length).toBe(1);
    expect(Number(latest2[0]!.cpu_percent)).toBe(88);

    // Series is append-only.
    await insertMachineMetricsSeries(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      sample: { cpuPercent: 10, sampledAt: new Date(Date.now() - 60_000) },
    });
    await insertMachineMetricsSeries(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      sample: { cpuPercent: 20, sampledAt: new Date() },
    });
    const series = await admin<{ n: string }[]>`
      select count(*)::int as n from machine_metrics_series where enrollment_id = ${enrollment.id}`;
    expect(Number(series[0]!.n)).toBe(2);
  }, 60_000);

  test("M10 ingestMachineMetricsSample: latest upsert always + series downsampled to ~1/min", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: "ed25519:DOWN",
    });
    const t0 = Date.now();
    const ingest = (cpu: number, atMs: number) =>
      ingestMachineMetricsSample(db, {
        accountId,
        workspaceId,
        enrollmentId: enrollment.id,
        sample: {
          cpuPercent: cpu,
          memUsedBytes: 100,
          memTotalBytes: 200,
          sampledAt: new Date(atMs),
        },
      });

    // First sample → latest upserted + series appended (no prior series row).
    const r1 = await ingest(10, t0);
    expect(r1.latestUpserted).toBe(true);
    expect(r1.seriesAppended).toBe(true);

    // A sample only 5s later (the heartbeat cadence) → latest upserted but NOT a
    // new series row (downsampled: < ~1/min since the last series point).
    const r2 = await ingest(20, t0 + 5_000);
    expect(r2.seriesAppended).toBe(false);

    // Another 5s later → still no new series row.
    const r3 = await ingest(30, t0 + 10_000);
    expect(r3.seriesAppended).toBe(false);

    // >= 60s after the last series row → a new series point lands.
    const r4 = await ingest(40, t0 + 61_000);
    expect(r4.seriesAppended).toBe(true);

    // The series therefore holds exactly 2 downsampled rows (t0 and t0+61s),
    // while the latest row reflects the MOST RECENT sample (cpu 40).
    const seriesCount = await admin<{ n: string }[]>`
      select count(*)::int as n from machine_metrics_series where enrollment_id = ${enrollment.id}`;
    expect(Number(seriesCount[0]!.n)).toBe(2);

    const latest = await readMachineMetricsLatest(db, workspaceId, enrollment.id);
    expect(latest).not.toBeNull();
    expect(latest!.cpuPercent).toBe(40);
    expect(latest!.memUsedBytes).toBe(100);
    expect(latest!.memTotalBytes).toBe(200);

    // The read DAOs surface the data the API joins onto the fleet.
    const byWs = await readMachineMetricsLatestForWorkspace(db, workspaceId);
    expect(byWs.get(enrollment.id)?.cpuPercent).toBe(40);

    const window = await readMachineMetricsSeries(db, {
      workspaceId,
      enrollmentId: enrollment.id,
      since: new Date(t0 - 1000),
    });
    expect(window.length).toBe(2);
    // Oldest-first ordering (a left-to-right chart).
    expect(window[0]!.cpuPercent).toBe(10);
    expect(window[1]!.cpuPercent).toBe(40);

    // A tight window excludes the older point.
    const recent = await readMachineMetricsSeries(db, {
      workspaceId,
      enrollmentId: enrollment.id,
      since: new Date(t0 + 30_000),
    });
    expect(recent.length).toBe(1);
    expect(recent[0]!.cpuPercent).toBe(40);
  }, 60_000);

  test("M10 readMachineMetricsLatest: GPU + null-when-absent round-trips through the DAO", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enrollment = await createEnrollment(db, {
      accountId,
      workspaceId,
      pubkey: "ed25519:GPU",
    });

    // A sample WITH gpu fields.
    await ingestMachineMetricsSample(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      sample: {
        cpuPercent: 50,
        gpuUtilPercent: 73,
        gpuMemUsedBytes: 4096,
        gpuMemTotalBytes: 40960,
        sampledAt: new Date(),
      },
    });
    const withGpu = await readMachineMetricsLatest(db, workspaceId, enrollment.id);
    expect(withGpu!.gpuUtilPercent).toBe(73);
    expect(withGpu!.gpuMemUsedBytes).toBe(4096);

    // A later sample with NO gpu fields → the latest row's gpu columns are null
    // (the not-reported contract — an absent GPU is null, never a real zero).
    await ingestMachineMetricsSample(db, {
      accountId,
      workspaceId,
      enrollmentId: enrollment.id,
      sample: { cpuPercent: 51, sampledAt: new Date() },
    });
    const noGpu = await readMachineMetricsLatest(db, workspaceId, enrollment.id);
    expect(noGpu!.gpuUtilPercent).toBeNull();
    expect(noGpu!.gpuMemUsedBytes).toBeNull();

    // An enrollment with no sample → null (offline before a first heartbeat).
    const fresh = await createEnrollment(db, { accountId, workspaceId, pubkey: "ed25519:NONE" });
    expect(await readMachineMetricsLatest(db, workspaceId, fresh.id)).toBeNull();
  }, 60_000);

  test("RLS isolation: workspace B's scoped connection cannot see workspace A's enrollment/sandbox/metrics", async () => {
    if (!available) return;
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const enrollmentA = await createEnrollment(db, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      pubkey: "ed25519:ISO",
    });
    await createSandbox(db, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      kind: "modal",
      name: "A box",
    });

    // Reading A's rows scoped to B returns nothing (FORCE RLS).
    expect(await getEnrollment(db, b.workspaceId, enrollmentA.id)).toBeNull();
    expect((await listEnrollments(db, b.workspaceId)).length).toBe(0);
    expect((await listSandboxes(db, b.workspaceId)).length).toBe(0);
    // ... while A still sees its own.
    expect((await listEnrollments(db, a.workspaceId)).length).toBe(1);
    expect((await listSandboxes(db, a.workspaceId)).length).toBe(1);
  }, 60_000);
});
