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
import { execFileSync } from "node:child_process";
import postgres from "postgres";
import { type Settings } from "@opengeni/config";
import {
  acquireLease,
  commitWarmingToWarm,
  createDb,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import {
  createSandboxLeaseActivities,
  type TerminateBoxFn,
} from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";

const CONTAINER = "ogtest-pg-warm-meter-worker";
const PORT = 55460;
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
      accountId: ids.accountId, workspaceId: ids.workspaceId, sandboxGroupId: groupId,
      kind: h.kind, holderId: h.holderId, backend: "modal", leaseTtlMs: 90_000,
    });
  }
  await commitWarmingToWarm(db, {
    accountId: ids.accountId, workspaceId: ids.workspaceId, sandboxGroupId: groupId,
    expectedEpoch: 0, instanceId: "box", resumeBackendId: "modal",
    resumeState: { sandboxId: "box" }, leaseTtlMs: 90_000,
  });
}

async function backdateMeterCursor(workspaceId: string, groupId: string, secondsAgo: number): Promise<void> {
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
  try {
    removeContainer();
    docker(["run", "--rm", "-d", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-p", `${PORT}:5432`, "--name", CONTAINER, IMAGE]);
  } catch (err) {
    available = false;
    console.warn(`[warm-meter-worker] docker unavailable, skipping: ${String(err)}`);
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

describe("P2.1 reaper-tick warm metering + force-drain (real lease + RLS, spied provider stop)", () => {
  test("(1) the reaper sweep meters a WARM viewer-only box but NOT a turn-held box", async () => {
    if (!available) return;
    const settings = testSettings({ sandboxBackend: "local", sandboxOwnershipEnabled: true, webSearchEnabled: false });
    const spy = makeTerminateSpy();
    const { reapSandboxLeases } = createSandboxLeaseActivities(reaperServices(settings), { terminateBox: spy.fn });

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
    const settings = testSettings({ sandboxBackend: "local", sandboxOwnershipEnabled: true, webSearchEnabled: false });
    const spy = makeTerminateSpy();
    const { reapSandboxLeases } = createSandboxLeaseActivities(reaperServices(settings), { terminateBox: spy.fn });

    const ws = await freshWorkspace();
    const group = crypto.randomUUID();
    await warmGroup(ws, group, [{ kind: "viewer", holderId: "v1" }]);
    await reapSandboxLeases();                       // seed
    await backdateMeterCursor(ws.workspaceId, group, 8);
    await reapSandboxLeases();                       // accrue tick 1
    expect(await warmSecondsCount(ws.workspaceId, group)).toBe(1);

    // A second sweep with NO further elapsed time → no new accrual (cursor was
    // advanced atomically with the insert; no whole second elapsed).
    await reapSandboxLeases();
    expect(await warmSecondsCount(ws.workspaceId, group)).toBe(1);
  }, 90_000);

  test("(3) a 0-balance workspace force-drains its VIEWER-ONLY box on the reaper tick; the TURN-HELD box survives and is terminated only at refcount 0", async () => {
    if (!available) return;
    const settings = testSettings({
      sandboxBackend: "local",
      sandboxOwnershipEnabled: true,
      webSearchEnabled: false,
      billingMode: "stripe",     // enable balance enforcement
      sandboxIdleGraceMs: 0,     // drain grace already elapsed → terminate same sweep
    });
    const spy = makeTerminateSpy();
    const { reapSandboxLeases } = createSandboxLeaseActivities(reaperServices(settings), { terminateBox: spy.fn });

    const ws = await freshWorkspace();
    await seedBalance(ws.accountId, 0);   // 0 balance
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
    expect(await readLiveness(ws.workspaceId, viewerOnly)).toBe("cold");   // drained → terminated → cold
    expect(await readLiveness(ws.workspaceId, turnHeld)).toBe("warm");     // SPARED — a paying turn is never killed
  }, 90_000);
});
