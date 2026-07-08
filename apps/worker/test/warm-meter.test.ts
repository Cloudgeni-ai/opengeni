// P2.1 — warm-time metering ON THE REAPER TICK. Drives the REAL reapSandboxLeases
// activity (createSandboxLeaseActivities) against a THROWAWAY postgres with real
// leases. The provider terminate is spied (no live provider). We prove the reaper
// is the warm-meter tick for VIEWER-ONLY boxes between turns, and the sole
// cost-stop driver:
//
//   (1) a reaper sweep accrues sandbox.warm_seconds for a WARM viewer-only box;
//       a TURN-HELD box is NOT metered on the reaper (it meters on the turn
//       heartbeat — the list fn excludes turn_holders>0, so no double-meter).
//   (2) the reaper sweep is idempotent — re-running it does not double-charge the
//       same (group, epoch, tick).
//   (3) a 0-balance workspace force-drains its VIEWER-ONLY box on the reaper tick
//       while a TURN-HELD box in the same workspace SURVIVES, and the freshly
//       drained box is then terminated by the same sweep (CAS draining->cold).
//
// pgvector/pgvector:pg16 (0000_initial does CREATE EXTENSION vector). The package
// fns connect as opengeni_app (non-superuser → FORCE RLS applies; the warm-lease
// read rides the SECURITY-DEFINER list fn). Container torn down in afterAll.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { type Settings } from "@opengeni/config";
import {
  acquireLease,
  commitWarmingToWarm,
  createDb,
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

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

function reaperServices(settings: Settings): () => Promise<ActivityServices> {
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

function makeTerminateSpy(): { fn: TerminateBoxFn; calls: { group: string; epoch: number }[] } {
  const calls: { group: string; epoch: number }[] = [];
  const fn: TerminateBoxFn = async (_settings, lease, _observability, persistArchive) => {
    calls.push({ group: lease.sandboxGroupId, epoch: lease.leaseEpoch });
    // Mirror the production seam: persist the /workspace archive onto the lease
    // (epoch-fenced) BEFORE terminating; a CAS miss (re-armed) returns false and
    // the box is left running. Return wrote so the caller colds only on success.
    const { wrote } = await persistArchive(
      Buffer.from("WARM_METER_SPY_ARCHIVE").toString("base64"),
    );
    return wrote;
  };
  return { fn, calls };
}

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id };
}

// Bring a fresh group to WARM at epoch 1 with the given holders.
async function warmGroup(
  ids: { accountId: string; workspaceId: string },
  groupId: string,
  holders: { kind: "turn" | "viewer"; holderId: string }[],
): Promise<void> {
  for (const h of holders) {
    await acquireLease(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: groupId,
      kind: h.kind,
      holderId: h.holderId,
      backend: "modal",
      leaseTtlMs: 90_000,
    });
  }
  await commitWarmingToWarm(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: groupId,
    expectedEpoch: 0,
    instanceId: "box",
    resumeBackendId: "modal",
    resumeState: { sandboxId: "box" },
    leaseTtlMs: 90_000,
  });
}

async function backdateMeterCursor(
  workspaceId: string,
  groupId: string,
  secondsAgo: number,
): Promise<void> {
  await admin`
    update sandbox_leases set last_meter_at = now() - (${String(secondsAgo)} || ' seconds')::interval
    where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
}

async function warmSecondsCount(workspaceId: string, groupId: string): Promise<number> {
  const [r] = await admin<{ n: number }[]>`
    select count(*)::int as n from usage_events
    where workspace_id = ${workspaceId} and event_type = 'sandbox.warm_seconds'
      and source_resource_id like ${groupId + ":%"}`;
  return r!.n;
}

async function replayWarmMeterTick(workspaceId: string, groupId: string): Promise<void> {
  await admin`
    update sandbox_leases set last_meter_tick = 0,
      last_meter_at = now() - interval '8 seconds'
    where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
}

async function readLiveness(workspaceId: string, groupId: string): Promise<string | undefined> {
  const [r] = await admin<{ liveness: string }[]>`
    select liveness from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
  return r?.liveness;
}

async function seedBalance(accountId: string, micros: number): Promise<void> {
  await admin`
    insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
    values (${accountId}, 'grant', ${micros}, ${"seed:" + crypto.randomUUID()})`;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("warm-meter-worker");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[warm-meter-worker] docker unavailable, skipping");
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

describe("P2.1 reaper-tick warm metering + force-drain (real lease + RLS, spied provider stop)", () => {
  test("(1) the reaper sweep meters a WARM viewer-only box but NOT a turn-held box", async () => {
    if (!available) return;
    const settings = testSettings({
      sandboxBackend: "local",
      sandboxOwnershipEnabled: true,
      webSearchEnabled: false,
    });
    const spy = makeTerminateSpy();
    const { reapSandboxLeases } = createSandboxLeaseActivities(reaperServices(settings), {
      terminateBox: spy.fn,
    });

    const ws = await freshWorkspace();
    const viewerOnly = crypto.randomUUID();
    const turnHeld = crypto.randomUUID();
    await warmGroup(ws, viewerOnly, [{ kind: "viewer", holderId: "v1" }]);
    await warmGroup(ws, turnHeld, [{ kind: "turn", holderId: "t1" }]);

    // First sweep seeds the cursors (no accrual yet); backdate both, sweep again.
    await reapSandboxLeases();
    await backdateMeterCursor(ws.workspaceId, viewerOnly, 6);
    await backdateMeterCursor(ws.workspaceId, turnHeld, 6);
    const result = await reapSandboxLeases();

    // The viewer-only box metered; the turn-held box did NOT (it meters on the
    // turn heartbeat — list_meterable_warm_leases excludes turn_holders>0).
    expect(result.metered).toBe(1);
    expect(await warmSecondsCount(ws.workspaceId, viewerOnly)).toBe(1);
    expect(await warmSecondsCount(ws.workspaceId, turnHeld)).toBe(0);
    // Neither was drained/terminated (both still have a holder).
    expect(spy.calls).toHaveLength(0);
    expect(await readLiveness(ws.workspaceId, viewerOnly)).toBe("warm");
    expect(await readLiveness(ws.workspaceId, turnHeld)).toBe("warm");
  }, 90_000);

  test("(2) re-running the reaper sweep does not double-charge the same (group, epoch, tick)", async () => {
    if (!available) return;
    const settings = testSettings({
      sandboxBackend: "local",
      sandboxOwnershipEnabled: true,
      webSearchEnabled: false,
    });
    const spy = makeTerminateSpy();
    const { reapSandboxLeases } = createSandboxLeaseActivities(reaperServices(settings), {
      terminateBox: spy.fn,
    });

    const ws = await freshWorkspace();
    const group = crypto.randomUUID();
    await warmGroup(ws, group, [{ kind: "viewer", holderId: "v1" }]);
    await reapSandboxLeases(); // seed
    await backdateMeterCursor(ws.workspaceId, group, 8);
    await reapSandboxLeases(); // accrue tick 1
    expect(await warmSecondsCount(ws.workspaceId, group)).toBe(1);

    // Replay the same tick index; the idempotency key must prevent a duplicate
    // usage row even if a re-fired sweep observes elapsed wall-clock time.
    await replayWarmMeterTick(ws.workspaceId, group);
    await reapSandboxLeases();
    expect(await warmSecondsCount(ws.workspaceId, group)).toBe(1);
  }, 90_000);

  test("(3) a 0-balance workspace force-drains its VIEWER-ONLY box on the reaper tick; the TURN-HELD box survives and is terminated only at refcount 0", async () => {
    if (!available) return;
    const settings = testSettings({
      sandboxBackend: "local",
      sandboxOwnershipEnabled: true,
      webSearchEnabled: false,
      billingMode: "stripe", // enable balance enforcement
      sandboxIdleGraceMs: 0, // drain grace already elapsed → terminate same sweep
    });
    const spy = makeTerminateSpy();
    const { reapSandboxLeases } = createSandboxLeaseActivities(reaperServices(settings), {
      terminateBox: spy.fn,
    });

    const ws = await freshWorkspace();
    await seedBalance(ws.accountId, 0); // 0 balance
    const viewerOnly = crypto.randomUUID();
    const turnHeld = crypto.randomUUID();
    await warmGroup(ws, viewerOnly, [{ kind: "viewer", holderId: "v1" }]);
    await warmGroup(ws, turnHeld, [{ kind: "turn", holderId: "t1" }]);

    const result = await reapSandboxLeases();

    // The viewer-only box was force-drained AND, with a 0ms grace, terminated +
    // CASed cold in the same sweep. The turn-held box is untouched (spared).
    // (result.forceDrained is a global-across-workspaces count; we assert on THIS
    // workspace's specific boxes instead — the load-bearing invariant.)
    expect(result.forceDrained).toBeGreaterThanOrEqual(1);
    expect(spy.calls.map((c) => c.group)).toContain(viewerOnly);
    expect(spy.calls.map((c) => c.group)).not.toContain(turnHeld);
    expect(await readLiveness(ws.workspaceId, viewerOnly)).toBe("cold"); // drained → terminated → cold
    expect(await readLiveness(ws.workspaceId, turnHeld)).toBe("warm"); // SPARED — a paying turn is never killed
  }, 90_000);
});
