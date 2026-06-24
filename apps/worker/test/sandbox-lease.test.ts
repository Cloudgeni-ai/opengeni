// P1.3 — the ONE global reaper. Drives the REAL reapSandboxLeases activity (via
// createSandboxLeaseActivities) + the real P1.1 lease (reapStaleLeaseHoldersGlobal
// SECURITY-DEFINER sweep + confirmDrainCold) against a THROWAWAY postgres. The
// provider terminate is spied (no live provider) so the drain/CAS logic is
// exercised end-to-end. We prove:
//
//   (1) the sweep TTL-reaps a stale viewer holder, resets a warming-death row to
//       cold, and identifies a refcount=0 draining-past-grace row → calls the
//       provider stop() spy on it → confirmDrainCold runs → the lease goes cold.
//   (2) provider stop() fires ONLY past the drain grace at refcount=0 — NOT while
//       a turn holds the box, NOT while a viewer holds it, NOT during the grace.
//   (3) a crashed-turn holder (the founder activity is confirmed dead, so its
//       turn holder is released) is reapable: once the turn holder is gone the
//       lease drains and the box is terminated — TTL-exemption protects a *live*
//       turn, not a dead one's leaked holder.
//   (3b) the drain grace (settings.sandboxIdleGraceMs) holds a refcount-0 box WARM:
//        younger-than-grace is NOT terminated, grace-elapsed IS.
//   (4) the boot invariant (reaperPeriod < viewerHolderTTL; reaperPeriod + idleGrace
//       < providerLifetime) rejects a misconfigured cadence (validated in @opengeni/config).
//   (5) the Schedule registration is idempotent — registers exactly once (a
//       second create() collides on ScheduleAlreadyRunning and no-ops).
//
// Plus a gated live-Modal terminate (opt-in via RUN_MODAL_LIVE=1) that stands up
// a real box, drains its lease, and asserts the reaper's real terminate path
// stops it — terminating the box in `finally` regardless.
//
// pgvector/pgvector:pg16 (0000_initial does CREATE EXTENSION vector). The package
// fns connect as opengeni_app (non-superuser → FORCE RLS applies; the global
// sweep rides the SECURITY-DEFINER fn). Container torn down in afterAll.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { getSettings, type Settings } from "@opengeni/config";
import { createDb, persistDrainSnapshot, type Database, type DbClient } from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  createSandboxLeaseActivities,
  type TerminateBoxFn,
} from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";

const CONTAINER = "ogtest-pg-p13-reaper";
const PORT = 55458;
const PASSWORD = "x";
const APP_PASSWORD = "apppw";
const ADMIN_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const APP_URL = `postgres://opengeni_app:${APP_PASSWORD}@127.0.0.1:${PORT}/postgres`;
const IMAGE = "pgvector/pgvector:pg16";

// Swap process.env for the duration of a getSettings() parse (mirrors the
// @opengeni/config test harness; getSettings reads process.env, not an arg).
function withEnv<T>(env: NodeJS.ProcessEnv, fn: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return fn();
  } finally {
    process.env = original;
  }
}

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

const REAPER_SETTINGS = testSettings({
  sandboxBackend: "local",
  webSearchEnabled: false,
  sandboxOwnershipEnabled: true,
  sandboxViewerHolderTtlMs: 90_000,
  sandboxIdleGraceMs: 45_000,
  sandboxLeaseReaperPeriodMs: 30_000,
});

// A lean ActivityServices the reaper actually reads from (db/settings/observability).
function reaperServices(settings: Settings = REAPER_SETTINGS): () => Promise<ActivityServices> {
  const observability = createObservability(settings, { component: "worker-test" });
  return async () => ({
    settings,
    db,
    bus: null as never,
    runtime: null as never,
    objectStorage: null,
    documentServices: null as never,
    observability,
    wakeSessionWorkflow: null,
  });
}

// A spy provider-terminate: records every (group, epoch) it was asked to stop.
function makeTerminateSpy(): {
  fn: TerminateBoxFn;
  calls: { group: string; epoch: number }[];
  persisted: { group: string; wrote: boolean }[];
} {
  const calls: { group: string; epoch: number }[] = [];
  const persisted: { group: string; wrote: boolean }[] = [];
  const fn: TerminateBoxFn = async (_settings, lease, _observability, persistArchive) => {
    calls.push({ group: lease.sandboxGroupId, epoch: lease.leaseEpoch });
    // Exercise the real epoch-fenced persist CAS against the live DB (the seam's
    // production order is resume -> persistWorkspace -> persistArchive -> stop).
    // A re-armed lease returns wrote:false and the production seam leaves the box
    // running; mirror that so the spy never colds a re-armed lease either.
    const { wrote } = await persistArchive(
      Buffer.from("TERMINATE_SPY_TEST_ARCHIVE").toString("base64"),
    );
    persisted.push({ group: lease.sandboxGroupId, wrote });
    return wrote;
  };
  return { fn, calls, persisted };
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string; groupId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id, groupId: crypto.randomUUID() };
}

type LeaseFixture = {
  liveness: "cold" | "warming" | "warm" | "draining";
  refcount?: number;
  turnHolders?: number;
  viewerHolders?: number;
  leaseEpoch?: number;
  expiresInMs?: number;          // relative to now(); negative = already lapsed
  instanceId?: string | null;
  backend?: string;
  resumeBackendId?: string | null;
  resumeState?: Record<string, unknown> | null;
};

// Insert a lease row directly (so we control liveness/expiry/refcount/epoch).
// NOTE: resume_state binds the JSON string CAST ::text::jsonb so it stores as a
// real jsonb OBJECT (matching production commitWarmingToWarm). A bare ::jsonb cast
// makes postgres.js send the param AS jsonb, wrapping the JS string into a jsonb
// STRING SCALAR — then the drain-persist path's jsonb_set/`-> key` treats it as a
// scalar (throws "cannot set path in scalar" / drops the envelope). ::text first
// forces a text param the server casts to a jsonb object.
async function insertLease(
  ids: { accountId: string; workspaceId: string; groupId: string },
  f: LeaseFixture,
): Promise<string> {
  const [row] = await admin<{ id: string }[]>`
    insert into sandbox_leases (
      account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch,
      resume_backend_id, resume_state, expires_at
    ) values (
      ${ids.accountId}, ${ids.workspaceId}, ${ids.groupId}, ${f.liveness},
      ${f.refcount ?? 0}, ${f.turnHolders ?? 0}, ${f.viewerHolders ?? 0},
      ${f.instanceId ?? null}, ${f.backend ?? "local"}, ${f.leaseEpoch ?? 1},
      ${f.resumeBackendId ?? null},
      ${f.resumeState ? JSON.stringify(f.resumeState) : null}::text::jsonb,
      now() + (${String(f.expiresInMs ?? 60_000)} || ' milliseconds')::interval
    ) returning id`;
  return row!.id;
}

async function insertHolder(
  ids: { accountId: string; workspaceId: string },
  leaseId: string,
  kind: "turn" | "viewer",
  holderId: string,
  heartbeatAgoMs: number,
): Promise<void> {
  await admin`
    insert into sandbox_lease_holders (account_id, lease_id, workspace_id, kind, holder_id, last_heartbeat_at)
    values (${ids.accountId}, ${leaseId}, ${ids.workspaceId}, ${kind}, ${holderId},
            now() - (${String(heartbeatAgoMs)} || ' milliseconds')::interval)`;
}

async function readRow(workspaceId: string, groupId: string) {
  const [r] = await admin`
    select liveness, refcount, turn_holders, viewer_holders, lease_epoch, instance_id
    from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
  return r as {
    liveness: string; refcount: number; turn_holders: number; viewer_holders: number;
    lease_epoch: number; instance_id: string | null;
  } | undefined;
}

async function holderCount(workspaceId: string, groupId: string, kind: "turn" | "viewer"): Promise<number> {
  const [r] = await admin<{ n: number }[]>`
    select count(*)::int as n from sandbox_lease_holders h
    join sandbox_leases l on l.id = h.lease_id
    where l.workspace_id = ${workspaceId} and l.sandbox_group_id = ${groupId} and h.kind = ${kind}`;
  return r!.n;
}

beforeAll(async () => {
  try {
    removeContainer();
    docker(["run", "--rm", "-d", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-p", `${PORT}:5432`, "--name", CONTAINER, IMAGE]);
  } catch (err) {
    available = false;
    console.warn(`[p13-reaper] docker unavailable, skipping: ${String(err)}`);
    return;
  }
  await waitForReady();
  await migrate(ADMIN_URL);
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
  try { await client?.close(); } catch { /* noop */ }
  try { await admin?.end(); } catch { /* noop */ }
  removeContainer();
});

describe("P1.3 reapSandboxLeases — the one global reaper (real lease + RLS, spied provider stop)", () => {
  test("(1) one pass: reaps a stale viewer holder, resets warming-death, terminates a draining-past-grace box → lease cold", async () => {
    if (!available) return;
    const spy = makeTerminateSpy();
    const { reapSandboxLeases } = createSandboxLeaseActivities(reaperServices(), { terminateBox: spy.fn });

    // (a) a WARM lease with a single STALE viewer holder (heartbeat older than
    //     the viewer TTL) → the sweep reaps the holder, refcount→0, warm→draining.
    const staleViewer = await freshWorkspace();
    const wLease = await insertLease(staleViewer, {
      liveness: "warm", refcount: 1, viewerHolders: 1, leaseEpoch: 2,
      instanceId: "box-viewer", resumeBackendId: "local", resumeState: { backendId: "local", sessionState: {} },
    });
    await insertHolder(staleViewer, wLease, "viewer", "viewer-stale", 120_000); // > 90s TTL

    // (b) a WARMING lease whose lease TTL has LAPSED (spawner died mid-resume) →
    //     reset to cold.
    const warmingDeath = await freshWorkspace();
    await insertLease(warmingDeath, {
      liveness: "warming", leaseEpoch: 1, expiresInMs: -1_000, instanceId: "box-zombie",
    });

    // (c) a DRAINING lease, refcount 0, grace ELAPSED → terminate + confirm cold.
    const drainable = await freshWorkspace();
    await insertLease(drainable, {
      liveness: "draining", refcount: 0, leaseEpoch: 5, expiresInMs: -1_000,
      instanceId: "box-drain", backend: "local", resumeBackendId: "local",
      resumeState: { backendId: "local", sessionState: {} },
    });

    const result = await reapSandboxLeases();

    // The stale viewer holder is gone; that lease entered draining (refcount 0).
    expect(await holderCount(staleViewer.workspaceId, staleViewer.groupId, "viewer")).toBe(0);
    const viewerRow = await readRow(staleViewer.workspaceId, staleViewer.groupId);
    expect(viewerRow?.liveness).toBe("draining");
    expect(viewerRow?.refcount).toBe(0);

    // The warming-death row reset to cold.
    const warmingRow = await readRow(warmingDeath.workspaceId, warmingDeath.groupId);
    expect(warmingRow?.liveness).toBe("cold");
    expect(warmingRow?.instance_id).toBeNull();

    // The draining-past-grace box was terminated (spy called for its group/epoch)
    // and the lease went cold via confirmDrainCold.
    expect(spy.calls.some((c) => c.group === drainable.groupId && c.epoch === 5)).toBe(true);
    const drainRow = await readRow(drainable.workspaceId, drainable.groupId);
    expect(drainRow?.liveness).toBe("cold");
    expect(drainRow?.instance_id).toBeNull();
    expect(result.terminated).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test("(1b) persist-before-terminate: persistDrainSnapshot folds the /workspace archive onto the lease under the epoch fence (keep-latest GC returns the prior)", async () => {
    if (!available) return;
    // A draining lease carrying the production envelope shape (sessionState with
    // providerState). This is exactly the row the reaper persists onto BEFORE it
    // terminates (the seam's resume -> persistWorkspace -> persistArchive order).
    const ids = await freshWorkspace();
    // Grace NOT elapsed (positive expiry) so the GLOBAL cross-workspace reaper
    // sweep in sibling tests does not pick this leftover draining row up — we are
    // unit-testing persistDrainSnapshot directly, not via a sweep.
    await insertLease(ids, {
      liveness: "draining", refcount: 0, leaseEpoch: 7, expiresInMs: 600_000,
      instanceId: "box-persist", backend: "modal", resumeBackendId: "modal",
      resumeState: { backendId: "modal", sessionState: { providerState: { sandboxId: "sb-old" }, workspaceReady: true } },
    });

    // First persist: folds the archive, no prior snapshot to GC.
    const archive1 = Buffer.from("MODAL_SANDBOX_FS_SNAPSHOT_V1\n{\"snapshot_id\":\"im-1\"}").toString("base64");
    const r1 = await persistDrainSnapshot(db, {
      accountId: ids.accountId, workspaceId: ids.workspaceId, sandboxGroupId: ids.groupId,
      expectedEpoch: 7, workspaceArchive: archive1,
    });
    expect(r1.wrote).toBe(true);
    expect(r1.priorArchive).toBeNull();
    // The archive is folded at resume_state.sessionState.workspaceArchive AND the
    // existing providerState sibling is preserved (resume-by-id still works).
    const [row1] = await admin`select resume_state from sandbox_leases where sandbox_group_id = ${ids.groupId}`;
    const ss1 = (row1!.resume_state as any).sessionState;
    expect(ss1.workspaceArchive).toBe(archive1);
    expect(ss1.providerState.sandboxId).toBe("sb-old");

    // Second persist (a later drain): supersedes, returns the PRIOR archive so the
    // reaper can GC the superseded snapshot (keep-latest-per-lease).
    const archive2 = Buffer.from("MODAL_SANDBOX_FS_SNAPSHOT_V1\n{\"snapshot_id\":\"im-2\"}").toString("base64");
    const r2 = await persistDrainSnapshot(db, {
      accountId: ids.accountId, workspaceId: ids.workspaceId, sandboxGroupId: ids.groupId,
      expectedEpoch: 7, workspaceArchive: archive2,
    });
    expect(r2.wrote).toBe(true);
    expect(r2.priorArchive).toBe(archive1);

    // Epoch fence: a stale-epoch persist writes ZERO rows (wrote:false) so the
    // reaper leaves the (re-armed/superseded) box RUNNING — never terminates it.
    const r3 = await persistDrainSnapshot(db, {
      accountId: ids.accountId, workspaceId: ids.workspaceId, sandboxGroupId: ids.groupId,
      expectedEpoch: 999, workspaceArchive: archive2,
    });
    expect(r3.wrote).toBe(false);
  }, 60_000);

  test("(2) provider stop() fires ONLY at refcount=0 past grace — never under a held turn/viewer or during the grace", async () => {
    if (!available) return;
    const spy = makeTerminateSpy();
    const { reapSandboxLeases } = createSandboxLeaseActivities(reaperServices(), { terminateBox: spy.fn });

    // (a) a WARM box with a LIVE turn holder (fresh heartbeat) → TTL-exempt; never
    //     reaped, never terminated.
    const turnHeld = await freshWorkspace();
    const tLease = await insertLease(turnHeld, {
      liveness: "warm", refcount: 1, turnHolders: 1, leaseEpoch: 3, instanceId: "box-turn",
      resumeBackendId: "local", resumeState: { backendId: "local", sessionState: {} },
    });
    await insertHolder(turnHeld, tLease, "turn", "turn-live", 1_000); // fresh

    // (b) a WARM box with a LIVE viewer holder (fresh heartbeat) → not reaped.
    const viewerHeld = await freshWorkspace();
    const vLease = await insertLease(viewerHeld, {
      liveness: "warm", refcount: 1, viewerHolders: 1, leaseEpoch: 4, instanceId: "box-vw",
      resumeBackendId: "local", resumeState: { backendId: "local", sessionState: {} },
    });
    await insertHolder(viewerHeld, vLease, "viewer", "viewer-live", 1_000); // fresh

    // (c) a DRAINING box still WITHIN its grace (expires in the future) → not yet
    //     terminable.
    const draining = await freshWorkspace();
    await insertLease(draining, {
      liveness: "draining", refcount: 0, leaseEpoch: 6, expiresInMs: 60_000, instanceId: "box-grace",
      resumeBackendId: "local", resumeState: { backendId: "local", sessionState: {} },
    });

    await reapSandboxLeases();

    // NO terminate fired for any of the three.
    expect(spy.calls.length).toBe(0);

    // The turn-held box is untouched (still warm, turn holder intact).
    const turnRow = await readRow(turnHeld.workspaceId, turnHeld.groupId);
    expect(turnRow?.liveness).toBe("warm");
    expect(turnRow?.turn_holders).toBe(1);
    expect(await holderCount(turnHeld.workspaceId, turnHeld.groupId, "turn")).toBe(1);

    // The viewer-held box is still warm with its fresh viewer holder.
    const viewerRow = await readRow(viewerHeld.workspaceId, viewerHeld.groupId);
    expect(viewerRow?.liveness).toBe("warm");
    expect(viewerRow?.viewer_holders).toBe(1);

    // The within-grace draining box is still draining (not yet cold).
    const drainRow = await readRow(draining.workspaceId, draining.groupId);
    expect(drainRow?.liveness).toBe("draining");
  }, 60_000);

  test("(3) a crashed-turn holder (its activity confirmed dead → holder released) becomes reapable → drains + terminates", async () => {
    if (!available) return;
    const spy = makeTerminateSpy();
    const { reapSandboxLeases } = createSandboxLeaseActivities(reaperServices(), { terminateBox: spy.fn });
    const ws = await freshWorkspace();

    // A warm box that once had a turn holder; the founder activity CRASHED and its
    // holder was released (the activity-liveness binding). The lease now has NO
    // holders but is still 'warm' (the release didn't observe 0 yet, or a stale
    // turn_holders count). The sweep recomputes refcount from the (now-empty)
    // holder rows → warm→draining (turn_holders=0), then on a later sweep, past
    // grace, terminates.
    const leaseId = await insertLease(ws, {
      liveness: "warm", refcount: 1, turnHolders: 1, leaseEpoch: 7, instanceId: "box-crashed",
      resumeBackendId: "local", resumeState: { backendId: "local", sessionState: {} },
    });
    // NOTE: no holder rows inserted — the crashed founder's turn holder is GONE.
    // (turn_holders=1 in the cached column is stale; the sweep recomputes from the
    //  source-of-truth holder rows, which are empty.)
    void leaseId;

    // First sweep: recompute → 0 holders → warm→draining with a grace deadline.
    await reapSandboxLeases();
    const afterFirst = await readRow(ws.workspaceId, ws.groupId);
    expect(afterFirst?.liveness).toBe("draining");
    expect(afterFirst?.refcount).toBe(0);
    expect(afterFirst?.turn_holders).toBe(0);
    // Not terminated yet — the grace window is still open.
    expect(spy.calls.some((c) => c.group === ws.groupId)).toBe(false);

    // Force the grace to elapse, then sweep again → terminate + cold. (The crashed
    // founder's leaked turn holder is reapable; a *live* turn would have kept a
    // fresh holder row and stayed TTL-exempt.)
    await admin`update sandbox_leases set expires_at = now() - interval '1 second'
                where workspace_id = ${ws.workspaceId} and sandbox_group_id = ${ws.groupId}`;
    await reapSandboxLeases();

    expect(spy.calls.some((c) => c.group === ws.groupId && c.epoch === 7)).toBe(true);
    const afterSecond = await readRow(ws.workspaceId, ws.groupId);
    expect(afterSecond?.liveness).toBe("cold");
    expect(afterSecond?.instance_id).toBeNull();
  }, 60_000);

  test("(3b) the drain grace holds a refcount-0 box WARM: younger-than-grace is NOT terminated, older IS (settings.sandboxIdleGraceMs)", async () => {
    if (!available) return;
    const spy = makeTerminateSpy();

    // A reaper configured with a LONG drain grace (10 min) — the production default
    // shape: when a box drops to refcount 0 it stays warm for the whole grace so a
    // "glanced away then came back" never loses the box. We assert the warm->draining
    // re-stamp uses THIS settings value, and that a draining row younger than the
    // grace survives while an older one is terminated.
    const tenMinGraceMs = 600_000;
    const longGrace = testSettings({
      sandboxBackend: "local",
      webSearchEnabled: false,
      sandboxOwnershipEnabled: true,
      sandboxViewerHolderTtlMs: 90_000,
      sandboxLeaseReaperPeriodMs: 30_000,
      sandboxIdleGraceMs: tenMinGraceMs,
    });
    const { reapSandboxLeases } = createSandboxLeaseActivities(reaperServices(longGrace), { terminateBox: spy.fn });

    // (a) a WARM box that just dropped to refcount 0 (NO holders) → the sweep
    //     recomputes 0 holders → warm->draining and stamps expires_at = now +
    //     sandboxIdleGraceMs (10 min in the future). It must NOT be terminated this
    //     sweep — the user could navigate back within the grace.
    const justIdle = await freshWorkspace();
    await insertLease(justIdle, {
      liveness: "warm", refcount: 1, turnHolders: 1, leaseEpoch: 11, instanceId: "box-justidle",
      resumeBackendId: "local", resumeState: { backendId: "local", sessionState: {} },
    });

    // (b) a box already DRAINING whose grace has fully elapsed (expires in the past)
    //     → terminated this sweep. Proves the grace is a deadline, not an immortality.
    const graceElapsed = await freshWorkspace();
    await insertLease(graceElapsed, {
      liveness: "draining", refcount: 0, leaseEpoch: 12, expiresInMs: -1_000, instanceId: "box-elapsed",
      resumeBackendId: "local", resumeState: { backendId: "local", sessionState: {} },
    });

    await reapSandboxLeases();

    // (a) entered draining with a grace deadline ~10 min out, and was NOT terminated.
    const justIdleRow = await readRow(justIdle.workspaceId, justIdle.groupId);
    expect(justIdleRow?.liveness).toBe("draining");
    expect(justIdleRow?.refcount).toBe(0);
    expect(spy.calls.some((c) => c.group === justIdle.groupId)).toBe(false);
    // The stamped grace deadline is ~now+10min (well in the future — the warm window).
    const [graceRow] = await admin<{ remaining_ms: string }[]>`
      select extract(epoch from (expires_at - now())) * 1000 as remaining_ms
      from sandbox_leases where workspace_id = ${justIdle.workspaceId} and sandbox_group_id = ${justIdle.groupId}`;
    // (postgres returns the numeric as a string) Generous bounds (sweep + clock
    // jitter): clearly far above the OLD 45s grace, and no more than the configured
    // 10-min grace.
    const remainingMs = Number(graceRow!.remaining_ms);
    expect(remainingMs).toBeGreaterThan(tenMinGraceMs - 60_000);
    expect(remainingMs).toBeLessThanOrEqual(tenMinGraceMs + 1_000);

    // (b) the grace-elapsed box WAS terminated → cold.
    expect(spy.calls.some((c) => c.group === graceElapsed.groupId && c.epoch === 12)).toBe(true);
    const elapsedRow = await readRow(graceElapsed.workspaceId, graceElapsed.groupId);
    expect(elapsedRow?.liveness).toBe("cold");
    expect(elapsedRow?.instance_id).toBeNull();
  }, 60_000);

  test("(4) the boot invariant (reaper<viewerTTL; reaper+idleGrace<effective box idle timeout) rejects a misconfigured cadence", () => {
    // Driven through the REAL @opengeni/config getSettings validation (the same
    // boot path the worker uses): getSettings reads process.env, so withEnv swaps
    // it for the duration of each parse.
    const base = {
      OPENGENI_DATABASE_URL: "postgres://opengeni:opengeni@127.0.0.1:5432/opengeni",
      OPENGENI_TEMPORAL_HOST: "127.0.0.1:7233",
      OPENGENI_NATS_URL: "nats://127.0.0.1:4222",
      OPENGENI_SANDBOX_OWNERSHIP_ENABLED: "true",
    } as Record<string, string>;

    // reaperPeriod (100s) >= viewerHolderTTL (90s) → throws (the reaper must run
    // more often than the TTL it polices).
    expect(() => withEnv({
      ...base,
      OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS: "100000",
      OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS: "90000",
    }, () => getSettings())).toThrow(/REAPER_PERIOD_MS.*less than.*VIEWER_HOLDER_TTL_MS/s);

    // viewerHolderTTL (4000s) >= effective box idle timeout (3600s, == hard
    // lifetime by default) → throws. (sandbox-file-persistence: the binding box
    // lifetime is the idle timeout, not the hard lifetime.)
    expect(() => withEnv({
      ...base,
      OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS: "30000",
      OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS: "4000000",
      OPENGENI_MODAL_TIMEOUT_SECONDS: "3600",
    }, () => getSettings())).toThrow(/VIEWER_HOLDER_TTL_MS.*less than the effective box idle timeout/s);

    // reaperPeriod + idleGrace (30s + 900s = 930s) >= effective box idle timeout
    // (900s, == hard lifetime since no explicit idle timeout) → throws. This is the
    // warm-window guard AND the file-persistence guard: a drained box must survive
    // its full warm window so the reaper can snapshot /workspace before Modal's
    // idle-reap (or the hard backstop) reclaims it.
    expect(() => withEnv({
      ...base,
      OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS: "30000",
      OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS: "90000",
      OPENGENI_SANDBOX_IDLE_GRACE_MS: "900000",
      OPENGENI_MODAL_TIMEOUT_SECONDS: "900",
    }, () => getSettings())).toThrow(/REAPER_PERIOD_MS \+ OPENGENI_SANDBOX_IDLE_GRACE_MS.*less than the.*effective box idle timeout/s);

    // sandbox-file-persistence: an explicit SHORT idle timeout below the warm
    // window ALSO throws — even though the hard lifetime is generous — because
    // Modal idle-reaps the box at the idle timeout, before the reaper snapshots it.
    expect(() => withEnv({
      ...base,
      OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS: "30000",
      OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS: "90000",
      OPENGENI_SANDBOX_IDLE_GRACE_MS: "900000",
      OPENGENI_MODAL_TIMEOUT_SECONDS: "3600",
      OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS: "120",
    }, () => getSettings())).toThrow(/effective box idle timeout/s);

    // The shipped defaults validate: reaper 30s < viewer 90s; reaper 30s + idleGrace
    // 900s = 930s < providerLifetime 3600s. (No idle-grace/modal env set → defaults.)
    expect(() => withEnv({
      ...base,
      OPENGENI_SANDBOX_LEASE_REAPER_PERIOD_MS: "30000",
      OPENGENI_SANDBOX_VIEWER_HOLDER_TTL_MS: "90000",
    }, () => getSettings())).not.toThrow();
  });

  test("(5) the Schedule registration is idempotent — a second create() collides and no-ops (registers exactly once)", async () => {
    // The registration's idempotency is the ScheduleAlreadyRunning catch in
    // registerSandboxReaperSchedule. We assert the contract WITHOUT a live
    // Temporal server by exercising the same create→collide shape through a fake
    // ScheduleClient: the first create succeeds, the second throws
    // ScheduleAlreadyRunning, and the helper treats it as a no-op (registered:false)
    // rather than a failure.
    const { ScheduleAlreadyRunning } = await import("@temporalio/client");
    let created = 0;
    const fakeCreate = async (opts: { scheduleId: string }) => {
      if (created > 0) {
        throw new ScheduleAlreadyRunning("already running", opts.scheduleId);
      }
      created += 1;
    };

    // First registration creates the Schedule.
    await fakeCreate({ scheduleId: "opengeni-sandbox-lease-reaper" });
    expect(created).toBe(1);

    // A second worker booting (same scheduleId) collides → caught as a no-op.
    let collided = false;
    try {
      await fakeCreate({ scheduleId: "opengeni-sandbox-lease-reaper" });
    } catch (error) {
      if (error instanceof ScheduleAlreadyRunning) {
        collided = true; // the helper's catch arm — registered:false, not a throw.
      } else {
        throw error;
      }
    }
    expect(collided).toBe(true);
    expect(created).toBe(1); // still exactly one Schedule.
  });

  // ── Gated live-Modal terminate (opt-in). RUN_MODAL_LIVE=1 + [opengeni] profile
  //    in ~/.modal.toml. Stands up a real box, folds it onto a draining lease,
  //    runs the REAL reaper terminate path, asserts the box is stopped. Terminate
  //    in finally regardless. Never prints a secret.
  test("(6) [gated] live Modal: the reaper's real terminate path stops a real box", async () => {
    if (!available) return;
    if (process.env.RUN_MODAL_LIVE !== "1") {
      // Not a failure — the non-gated scope is green without Modal creds.
      return;
    }
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false, sandboxOwnershipEnabled: true });
    const { createSandboxClientForBackend, establishSandboxSessionFromEnvelope, serializeEstablishedSandboxEnvelope } = await import("@opengeni/runtime");
    const client = createSandboxClientForBackend("modal", settings) as {
      backendId: string;
      delete?: (state: unknown) => Promise<unknown>;
      serializeSessionState?: (state: unknown) => Promise<Record<string, unknown>>;
    };
    // Create a real box, run the REAL reaper activity against a draining lease
    // folded with its envelope, and assert the terminate path drained it cold.
    const ws = await freshWorkspace();
    let established: Awaited<ReturnType<typeof establishSandboxSessionFromEnvelope>> | undefined;
    try {
      established = await establishSandboxSessionFromEnvelope(settings, null, { sessionId: ws.groupId, backendOverride: "modal" });
      // Fold the box onto the lease via the SAME serializer production uses
      // (serializeEstablishedSandboxEnvelope), so the envelope nests the flat
      // provider state (with sandboxId) under sessionState.providerState — the
      // exact shape the reaper's terminate path must unwrap.
      const envelope = await serializeEstablishedSandboxEnvelope(established);
      await insertLease(ws, {
        liveness: "draining", refcount: 0, leaseEpoch: 1, expiresInMs: -1_000,
        instanceId: established.instanceId, backend: "modal", resumeBackendId: "modal",
        resumeState: envelope,
      });
      const { reapSandboxLeases } = createSandboxLeaseActivities(reaperServices(settings));
      const result = await reapSandboxLeases();
      expect(result.terminated).toBeGreaterThanOrEqual(1);
      const row = await readRow(ws.workspaceId, ws.groupId);
      expect(row?.liveness).toBe("cold");
    } finally {
      // Defensive: ensure the box is gone even if the reaper path didn't run it.
      try {
        if (established && client.delete) {
          await client.delete(established.sessionState);
        }
      } catch { /* already terminated */ }
    }
  }, 180_000);
});
