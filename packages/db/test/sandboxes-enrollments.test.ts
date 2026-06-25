import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import {
  createDb,
  createEnrollment,
  createSandbox,
  createSession,
  getEnrollment,
  getSandbox,
  getSession,
  insertMachineMetricsSeries,
  listEnrollments,
  listSandboxes,
  readActiveSandbox,
  revokeEnrollment,
  setActiveSandbox,
  touchEnrollmentLastSeen,
  upsertMachineMetricsLatest,
  type Database,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";

// M2 (bring-your-own-compute): the 0024 sandboxes/enrollments/metrics DAOs +
// the per-session epoch-fenced active-sandbox pointer + the mapSession round-trip
// (active_sandbox_id/active_epoch), driven through the REAL packages/db query fns
// against a THROWAWAY postgres (same harness as sandbox-leases.test.ts). The
// package fns connect as opengeni_app (a NON-superuser, so FORCE RLS genuinely
// applies); accounts/workspaces are seeded as the postgres superuser (bypasses
// RLS). pgvector/pgvector:pg16 because 0000_initial does CREATE EXTENSION vector.
// Container torn down in afterAll regardless of outcome.

const CONTAINER = "ogtest-pg-byoc";
const PORT = 55456;
const PASSWORD = "x";
const APP_PASSWORD = "apppw";
const ADMIN_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const APP_URL = `postgres://opengeni_app:${APP_PASSWORD}@127.0.0.1:${PORT}/postgres`;
const IMAGE = "pgvector/pgvector:pg16";

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function removeContainer(): void {
  try {
    docker(["rm", "-f", CONTAINER]);
  } catch {
    // already gone
  }
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const probe = postgres(ADMIN_URL, { max: 1, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        return;
      } finally {
        await probe.end();
      }
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`postgres did not become ready in time: ${String(err)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

let available = true;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

// Seed a fresh (account, workspace) as the superuser (bypasses RLS).
async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id };
}

beforeAll(async () => {
  try {
    removeContainer();
    docker(["run", "--rm", "-d", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-p", `${PORT}:5432`, "--name", CONTAINER, IMAGE]);
  } catch (err) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn(`[sandboxes-enrollments] docker unavailable, skipping: ${String(err)}`);
    return;
  }
  await waitForReady();

  // Apply the full migration chain as the superuser.
  await migrate(ADMIN_URL);

  // Provision the opengeni_app login role AFTER migrating, then run the same grant
  // blocks the migrations would have (IF EXISTS-skipped while the role was absent).
  admin = postgres(ADMIN_URL, { max: 4 });
  await admin.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='opengeni_app') THEN
        CREATE ROLE opengeni_app LOGIN PASSWORD '${APP_PASSWORD}';
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA public TO opengeni_app;
    GRANT USAGE ON SCHEMA opengeni_private TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO opengeni_app;
  `);

  client = createDb(APP_URL);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch { /* noop */ }
  try {
    await admin?.end();
  } catch { /* noop */ }
  removeContainer();
});

describe("0024 sandboxes / enrollments / metrics DAOs + active-sandbox pointer", () => {
  test("migration adds sessions.active_sandbox_id (nullable) + active_epoch (NOT NULL default 0, integer)", async () => {
    if (!available) return;
    const cols = await admin<{ column_name: string; is_nullable: string; data_type: string; column_default: string | null }[]>`
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
      accountId, workspaceId, pubkey: "ed25519:AAAA", hasDisplay: true, os: "linux", arch: "x86_64",
    });
    expect(created.status).toBe("active");
    expect(created.exposure).toBe("whole-machine");
    expect(created.hasDisplay).toBe(true);
    expect(created.allowScreenControl).toBe(false);
    expect(created.lastSeenAt).toBeNull();
    expect(created.revokedAt).toBeNull();

    const fetched = await getEnrollment(db, workspaceId, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.pubkey).toBe("ed25519:AAAA");

    // Idempotent re-enroll of the SAME (workspace, pubkey) -> SAME row id, updated
    // consent fields, NOT a duplicate.
    const reEnrolled = await createEnrollment(db, {
      accountId, workspaceId, pubkey: "ed25519:AAAA", hasDisplay: false, allowScreenControl: true, os: "linux",
    });
    expect(reEnrolled.id).toBe(created.id);
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
    const reactivated = await createEnrollment(db, { accountId, workspaceId, pubkey: "ed25519:AAAA" });
    expect(reactivated.id).toBe(created.id);
    expect(reactivated.status).toBe("active");
    expect(reactivated.revokedAt).toBeNull();
  }, 60_000);

  test("sandbox create: selfhosted requires enrollment, modal forbids it; get + list", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enrollment = await createEnrollment(db, { accountId, workspaceId, pubkey: "ed25519:BBBB" });

    const modal = await createSandbox(db, { accountId, workspaceId, kind: "modal", name: "cloud box" });
    expect(modal.kind).toBe("modal");
    expect(modal.enrollmentId).toBeNull();

    const selfhosted = await createSandbox(db, {
      accountId, workspaceId, kind: "selfhosted", name: "my laptop", enrollmentId: enrollment.id,
    });
    expect(selfhosted.kind).toBe("selfhosted");
    expect(selfhosted.enrollmentId).toBe(enrollment.id);

    // Typed pre-checks (a selfhosted sandbox MUST carry an enrollment; modal MUST NOT).
    await expect(createSandbox(db, { accountId, workspaceId, kind: "selfhosted", name: "bad" }))
      .rejects.toThrow(/requires an enrollmentId/);
    await expect(createSandbox(db, { accountId, workspaceId, kind: "modal", name: "bad", enrollmentId: enrollment.id }))
      .rejects.toThrow(/must not carry an enrollmentId/);

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
      accountId, workspaceId, initialMessage: "hi", resources: [], metadata: {},
      model: "gpt", sandboxBackend: "modal",
    });
    expect(session.activeSandboxId).toBeNull();
    expect(session.activeEpoch).toBe(0);
    const reread = await getSession(db, workspaceId, session.id);
    expect(reread?.activeSandboxId).toBeNull();
    expect(reread?.activeEpoch).toBe(0);

    const pointer0 = await readActiveSandbox(db, workspaceId, session.id);
    expect(pointer0).toEqual({ activeSandboxId: null, activeEpoch: 0 });

    const target = await createSandbox(db, { accountId, workspaceId, kind: "modal", name: "target" });

    // Swap at the correct epoch -> wins, epoch bumps to 1, pointer set.
    const swap1 = await setActiveSandbox(db, {
      accountId, workspaceId, sessionId: session.id, targetSandboxId: target.id, expectedEpoch: 0,
    });
    expect(swap1.swapped).toBe(true);
    expect(swap1.pointer).toEqual({ activeSandboxId: target.id, activeEpoch: 1 });

    // A concurrent double-swap reading the OLD epoch (0) loses — the fence rejects it.
    const stale = await setActiveSandbox(db, {
      accountId, workspaceId, sessionId: session.id, targetSandboxId: null, expectedEpoch: 0,
    });
    expect(stale.swapped).toBe(false);
    expect(stale.pointer).toBeNull();

    // The pointer is unchanged by the losing swap.
    expect(await readActiveSandbox(db, workspaceId, session.id)).toEqual({ activeSandboxId: target.id, activeEpoch: 1 });

    // Swap back to the group sandbox (NULL) at the current epoch -> wins, epoch 2.
    const swap2 = await setActiveSandbox(db, {
      accountId, workspaceId, sessionId: session.id, targetSandboxId: null, expectedEpoch: 1,
    });
    expect(swap2.swapped).toBe(true);
    expect(swap2.pointer).toEqual({ activeSandboxId: null, activeEpoch: 2 });

    // The full session re-read reflects the pointer (mapSession round-trip).
    const rereadAfter = await getSession(db, workspaceId, session.id);
    expect(rereadAfter?.activeSandboxId).toBeNull();
    expect(rereadAfter?.activeEpoch).toBe(2);

    // Deleting the pointed-at sandbox degrades the pointer to NULL (ON DELETE SET
    // NULL), never a dangling FK. Re-point first, then delete.
    const swap3 = await setActiveSandbox(db, {
      accountId, workspaceId, sessionId: session.id, targetSandboxId: target.id, expectedEpoch: 2,
    });
    expect(swap3.swapped).toBe(true);
    await admin`delete from sandboxes where id = ${target.id}`;
    const afterDelete = await readActiveSandbox(db, workspaceId, session.id);
    expect(afterDelete?.activeSandboxId).toBeNull();
  }, 60_000);

  test("metrics: last-sample upsert (one row per enrollment) + append-only series", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const enrollment = await createEnrollment(db, { accountId, workspaceId, pubkey: "ed25519:CCCC" });

    await upsertMachineMetricsLatest(db, {
      accountId, workspaceId, enrollmentId: enrollment.id,
      sample: { cpuPercent: 12.5, load1: 0.5, memUsedBytes: 1024, memTotalBytes: 4096, sampledAt: new Date() },
    });
    const latest1 = await admin<{ cpu_percent: string; mem_used_bytes: string }[]>`
      select cpu_percent, mem_used_bytes from machine_metrics_latest where enrollment_id = ${enrollment.id}`;
    expect(latest1.length).toBe(1);
    expect(Number(latest1[0]!.cpu_percent)).toBe(12.5);

    // Second upsert overwrites the SAME row (one row per enrollment).
    await upsertMachineMetricsLatest(db, {
      accountId, workspaceId, enrollmentId: enrollment.id,
      sample: { cpuPercent: 88, contention: 3, sampledAt: new Date() },
    });
    const latest2 = await admin<{ cpu_percent: string }[]>`
      select cpu_percent from machine_metrics_latest where enrollment_id = ${enrollment.id}`;
    expect(latest2.length).toBe(1);
    expect(Number(latest2[0]!.cpu_percent)).toBe(88);

    // Series is append-only.
    await insertMachineMetricsSeries(db, {
      accountId, workspaceId, enrollmentId: enrollment.id,
      sample: { cpuPercent: 10, sampledAt: new Date(Date.now() - 60_000) },
    });
    await insertMachineMetricsSeries(db, {
      accountId, workspaceId, enrollmentId: enrollment.id,
      sample: { cpuPercent: 20, sampledAt: new Date() },
    });
    const series = await admin<{ n: string }[]>`
      select count(*)::int as n from machine_metrics_series where enrollment_id = ${enrollment.id}`;
    expect(Number(series[0]!.n)).toBe(2);
  }, 60_000);

  test("RLS isolation: workspace B's scoped connection cannot see workspace A's enrollment/sandbox/metrics", async () => {
    if (!available) return;
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    const enrollmentA = await createEnrollment(db, { accountId: a.accountId, workspaceId: a.workspaceId, pubkey: "ed25519:ISO" });
    await createSandbox(db, { accountId: a.accountId, workspaceId: a.workspaceId, kind: "modal", name: "A box" });

    // Reading A's rows scoped to B returns nothing (FORCE RLS).
    expect(await getEnrollment(db, b.workspaceId, enrollmentA.id)).toBeNull();
    expect((await listEnrollments(db, b.workspaceId)).length).toBe(0);
    expect((await listSandboxes(db, b.workspaceId)).length).toBe(0);
    // ... while A still sees its own.
    expect((await listEnrollments(db, a.workspaceId)).length).toBe(1);
    expect((await listSandboxes(db, a.workspaceId)).length).toBe(1);
  }, 60_000);
});
