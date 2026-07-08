import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  accrueWarmSeconds,
  acquireLease,
  commitWarmingToWarm,
  createDb,
  forceDrainOverLimitViewerOnlyBoxes,
  listMeterableWarmLeases,
  type Database,
  type DbClient,
} from "../src/index";

// P2.1 warm-time metering driven through the REAL packages/db query fns
// (accrueWarmSeconds / forceDrainOverLimitViewerOnlyBoxes / listMeterableWarmLeases)
// against a THROWAWAY postgres. We prove the Critical meter key:
//
//   (1) a warm box accrues sandbox.warm_seconds on a tick; the FIRST tick only
//       seeds the cursor (delta-since-last-tick contract).
//   (2) IDEMPOTENCY — re-running a tick at the SAME (group, epoch, tick) does NOT
//       double-charge (the meter cursor + the usage insert are atomic, so a
//       re-fire at the same epoch with no elapsed seconds is a no-op; a forced
//       same-tick re-insert collapses on the idempotency key).
//   (3) SHARED-ONCE — a shared box (2 viewer sessions, one group) produces EXACTLY
//       ONE warm-seconds stream (N sessions != N x bill) — the group meter key.
//   (4) EPOCH FENCE — a stale-epoch tick is a no-op (no accrual, cursor untouched).
//   (5) the cursor advances (last_meter_tick increments per accrual).
//   (6) FORCE-DRAIN — a 0-balance / over-cap workspace force-drains its VIEWER-ONLY
//       box while a TURN-HELD box in the SAME workspace SURVIVES (turn_holders=0
//       guard), and warm_cost is debited at the configured rate.
//
// pgvector/pgvector:pg16 (0000_initial does CREATE EXTENSION vector). The package
// fns connect as opengeni_app (a NON-superuser so FORCE RLS applies; the warm-lease
// read rides the SECURITY-DEFINER list_meterable_warm_leases fn). Container torn
// down in afterAll regardless of outcome.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
  groupId: string;
}> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id, groupId: crypto.randomUUID() };
}

// Bring a fresh group to WARM at epoch 1 with one turn holder (so it is alive),
// then return the epoch. Backdates last_meter_at so the next accrue tick sees
// elapsed seconds without a real sleep.
async function warmGroup(
  ids: { accountId: string; workspaceId: string; groupId: string },
  holders: { kind: "turn" | "viewer"; holderId: string }[],
): Promise<number> {
  for (const h of holders) {
    await acquireLease(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      kind: h.kind,
      holderId: h.holderId,
      backend: "modal",
      leaseTtlMs: 90_000,
    });
  }
  const committed = await commitWarmingToWarm(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sandboxGroupId: ids.groupId,
    expectedEpoch: 0,
    instanceId: "box",
    leaseTtlMs: 90_000,
  });
  return committed.lease!.leaseEpoch;
}

// Force the meter cursor back by `secondsAgo` so the next accrue sees elapsed time.
async function backdateMeterCursor(
  workspaceId: string,
  groupId: string,
  secondsAgo: number,
): Promise<void> {
  await admin`
    update sandbox_leases set last_meter_at = now() - (${String(secondsAgo)} || ' seconds')::interval
    where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
}

async function readMeterRow(workspaceId: string, groupId: string) {
  const [r] = await admin`
    select last_meter_tick, last_meter_at from sandbox_leases
    where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
  return r as { last_meter_tick: number; last_meter_at: Date | null } | undefined;
}

async function warmSecondsEvents(
  workspaceId: string,
  groupId: string,
): Promise<{ quantity: number; idempotency_key: string }[]> {
  const rows = await admin<{ quantity: number; idempotency_key: string }[]>`
    select quantity, idempotency_key from usage_events
    where workspace_id = ${workspaceId}
      and event_type = 'sandbox.warm_seconds'
      and source_resource_id like ${groupId + ":%"}
    order by idempotency_key`;
  return rows.map((r) => ({ quantity: Number(r.quantity), idempotency_key: r.idempotency_key }));
}

async function eventCount(workspaceId: string, eventType: string): Promise<number> {
  const [r] = await admin<{ n: number }[]>`
    select count(*)::int as n from usage_events
    where workspace_id = ${workspaceId} and event_type = ${eventType}`;
  return r!.n;
}

async function readLiveness(workspaceId: string, groupId: string): Promise<string | undefined> {
  const [r] = await admin<{ liveness: string }[]>`
    select liveness from sandbox_leases where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
  return r?.liveness;
}

// Seed a credit ledger so getBillingBalance returns a known balance for the account.
async function seedBalance(accountId: string, micros: number): Promise<void> {
  await admin`
    insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
    values (${accountId}, 'grant', ${micros}, ${"seed:" + crypto.randomUUID()})`;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("warm-meter-db");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[warm-meter-db] docker unavailable, skipping");
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

describe("P2.1 warm-time metering (real packages/db + RLS)", () => {
  test("(1) the FIRST tick seeds the cursor (no accrual); the SECOND tick accrues warm-seconds", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }]);

    // commitWarmingToWarm leaves last_meter_at null → the first tick only seeds.
    const seed = await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    expect(seed.accrued).toBe(false);
    const afterSeed = await readMeterRow(ws.workspaceId, ws.groupId);
    expect(afterSeed?.last_meter_at).not.toBeNull();
    expect(afterSeed?.last_meter_tick).toBe(0);
    expect(await warmSecondsEvents(ws.workspaceId, ws.groupId)).toHaveLength(0);

    // Backdate the cursor 5s and tick again → 5 warm-seconds accrue at tick 1.
    await backdateMeterCursor(ws.workspaceId, ws.groupId, 5);
    const accrue = await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    expect(accrue.accrued).toBe(true);
    expect(accrue.seconds).toBeGreaterThanOrEqual(5);
    expect(accrue.tick).toBe(1);
    const events = await warmSecondsEvents(ws.workspaceId, ws.groupId);
    expect(events).toHaveLength(1);
    expect(events[0]!.quantity).toBeGreaterThanOrEqual(5);
    const afterAccrue = await readMeterRow(ws.workspaceId, ws.groupId);
    expect(afterAccrue?.last_meter_tick).toBe(1);
  }, 60_000);

  test("(2) IDEMPOTENCY: re-running a tick at the same (group, epoch, tick) does NOT double-charge", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }]);
    // Seed + one real accrual at tick 1.
    await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    await backdateMeterCursor(ws.workspaceId, ws.groupId, 10);
    const first = await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    expect(first.tick).toBe(1);
    const afterFirst = await warmSecondsEvents(ws.workspaceId, ws.groupId);
    expect(afterFirst).toHaveLength(1);

    // Simulate a re-dispatched/overlapping tick that recomputes the SAME tick
    // index (rewind both the cursor AND the tick counter to before the accrual),
    // proving the (group, epoch, tick) idempotency key collapses the re-insert.
    await admin`
      update sandbox_leases set last_meter_tick = 0,
        last_meter_at = now() - interval '10 seconds'
      where workspace_id = ${ws.workspaceId} and sandbox_group_id = ${ws.groupId}`;
    const replay = await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    expect(replay.tick).toBe(1); // same tick index as `first`
    const afterReplay = await warmSecondsEvents(ws.workspaceId, ws.groupId);
    // STILL exactly one event for (group, epoch, tick=1) — onConflictDoNothing.
    expect(afterReplay).toHaveLength(1);
    expect(afterReplay[0]!.idempotency_key).toBe(
      `usage:sandbox.warm_seconds:${ws.groupId}:${epoch}:1`,
    );
  }, 60_000);

  test("(3) SHARED-ONCE: 2 viewer sessions on one shared box → EXACTLY ONE warm-seconds stream (not 2x)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    // Two distinct sessions (viewer holders) on ONE group — the shared-box case.
    const epoch = await warmGroup(ws, [
      { kind: "viewer", holderId: "session-A" },
      { kind: "viewer", holderId: "session-B" },
    ]);
    // Seed + accrue once at the group key. Even with 2 holders, the meter is keyed
    // on the GROUP, so there is one stream.
    await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    await backdateMeterCursor(ws.workspaceId, ws.groupId, 7);
    const accrue = await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    expect(accrue.accrued).toBe(true);

    const events = await warmSecondsEvents(ws.workspaceId, ws.groupId);
    expect(events).toHaveLength(1); // ONE stream, not two
    expect(events[0]!.quantity).toBeGreaterThanOrEqual(7);

    // listMeterableWarmLeases returns ONE row for the group (not one per session).
    const meterable = await listMeterableWarmLeases(db);
    const forGroup = meterable.filter((m) => m.sandboxGroupId === ws.groupId);
    expect(forGroup).toHaveLength(1);
  }, 60_000);

  test("(4) EPOCH FENCE: a stale-epoch tick is a no-op (no accrual, cursor untouched)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }]);
    await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    await backdateMeterCursor(ws.workspaceId, ws.groupId, 5);
    const before = await readMeterRow(ws.workspaceId, ws.groupId);

    // A tick at a STALE epoch (epoch - 1) must no-op: wrong fence token.
    const stale = await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch - 1,
      warmRateMicrosPerSecond: 0,
    });
    expect(stale.accrued).toBe(false);
    expect(await warmSecondsEvents(ws.workspaceId, ws.groupId)).toHaveLength(0);
    const after = await readMeterRow(ws.workspaceId, ws.groupId);
    expect(after?.last_meter_tick).toBe(before?.last_meter_tick); // cursor untouched
  }, 60_000);

  test("(5) the meter cursor advances one tick per accrual (monotonic last_meter_tick)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }]);
    await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    for (let i = 1; i <= 3; i++) {
      await backdateMeterCursor(ws.workspaceId, ws.groupId, 3);
      const r = await accrueWarmSeconds(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        sandboxGroupId: ws.groupId,
        expectedEpoch: epoch,
        warmRateMicrosPerSecond: 0,
      });
      expect(r.tick).toBe(i);
    }
    const row = await readMeterRow(ws.workspaceId, ws.groupId);
    expect(row?.last_meter_tick).toBe(3);
    // Three distinct warm-seconds events at ticks 1..3.
    expect(await warmSecondsEvents(ws.workspaceId, ws.groupId)).toHaveLength(3);
  }, 60_000);

  test("(6) FORCE-DRAIN: a 0-balance workspace drains a VIEWER-ONLY box while a TURN-HELD box survives", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    // Box V: viewer-only (turn_holders=0) — eligible for force-drain.
    const viewerOnly = { ...ws, groupId: crypto.randomUUID() };
    await warmGroup(viewerOnly, [{ kind: "viewer", holderId: "v1" }]);
    // Box T: turn-held (a paying turn) in the SAME workspace — must NEVER be killed.
    const turnHeld = { ...ws, groupId: crypto.randomUUID() };
    await warmGroup(turnHeld, [{ kind: "turn", holderId: "t1" }]);

    expect(await readLiveness(ws.workspaceId, viewerOnly.groupId)).toBe("warm");
    expect(await readLiveness(ws.workspaceId, turnHeld.groupId)).toBe("warm");

    // 0 balance + balance enforcement on → force-drain viewer-only boxes only.
    const result = await forceDrainOverLimitViewerOnlyBoxes(db, {
      workspaceId: ws.workspaceId,
      balanceMicros: 0,
      enforceBalance: true,
      maxWarmSecondsPerWorkspace: 0,
      idleGraceMs: 0,
    });
    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("balance");
    expect(result.drained.map((d) => d.sandboxGroupId)).toContain(viewerOnly.groupId);
    expect(result.drained.map((d) => d.sandboxGroupId)).not.toContain(turnHeld.groupId);

    expect(await readLiveness(ws.workspaceId, viewerOnly.groupId)).toBe("draining"); // drained
    expect(await readLiveness(ws.workspaceId, turnHeld.groupId)).toBe("warm"); // SPARED
  }, 60_000);

  test("(6b) FORCE-DRAIN by warm-cap: a workspace over its warm-second cap drains viewer-only boxes", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const viewerOnly = { ...ws, groupId: crypto.randomUUID() };
    const epoch = await warmGroup(viewerOnly, [{ kind: "viewer", holderId: "v1" }]);
    // Accrue >= 10 warm-seconds so the cap (5) is exceeded.
    await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: viewerOnly.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    await backdateMeterCursor(ws.workspaceId, viewerOnly.groupId, 12);
    await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: viewerOnly.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });

    // Balance enforcement OFF, but the warm cap (5) is exceeded → force-drain.
    const result = await forceDrainOverLimitViewerOnlyBoxes(db, {
      workspaceId: ws.workspaceId,
      balanceMicros: 1_000_000,
      enforceBalance: false,
      maxWarmSecondsPerWorkspace: 5,
      idleGraceMs: 0,
    });
    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("warm_cap");
    expect(result.drained.map((d) => d.sandboxGroupId)).toContain(viewerOnly.groupId);
    expect(await readLiveness(ws.workspaceId, viewerOnly.groupId)).toBe("draining");
  }, 60_000);

  test("(7) warm-cost: a configured rate debits credits and records sandbox.warm_cost (orthogonal to warm_seconds)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await seedBalance(ws.accountId, 1_000_000);
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }]);
    await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 100,
    });
    await backdateMeterCursor(ws.workspaceId, ws.groupId, 4);
    const accrue = await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 100,
    });
    expect(accrue.accrued).toBe(true);
    expect(accrue.costMicros).toBe(accrue.seconds * 100);
    // Both meters recorded; they are orthogonal event types.
    expect(await eventCount(ws.workspaceId, "sandbox.warm_seconds")).toBe(1);
    expect(await eventCount(ws.workspaceId, "sandbox.warm_cost")).toBe(1);
    // The credit balance is debited by the actual warm-cost.
    const [bal] = await admin<{ b: number }[]>`
      select coalesce(sum(amount_micros), 0)::bigint as b from credit_ledger_entries where account_id = ${ws.accountId}`;
    expect(Number(bal!.b)).toBe(1_000_000 - accrue.costMicros);

    // IDEMPOTENT DEBIT: a re-fire at the same (group, epoch, tick) does NOT
    // double-debit (rewind the cursor + tick to replay the same tick index).
    await admin`
      update sandbox_leases set last_meter_tick = 0, last_meter_at = now() - interval '4 seconds'
      where workspace_id = ${ws.workspaceId} and sandbox_group_id = ${ws.groupId}`;
    const replay = await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 100,
    });
    expect(replay.tick).toBe(1);
    const [bal2] = await admin<{ b: number }[]>`
      select coalesce(sum(amount_micros), 0)::bigint as b from credit_ledger_entries where account_id = ${ws.accountId}`;
    expect(Number(bal2!.b)).toBe(1_000_000 - accrue.costMicros); // unchanged — no double-debit
  }, 60_000);

  test("(8) a NON-warm (draining) lease does not meter and is not listed as meterable", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }]);
    await admin`update sandbox_leases set liveness='draining'
                where workspace_id=${ws.workspaceId} and sandbox_group_id=${ws.groupId}`;
    const accrue = await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    expect(accrue.accrued).toBe(false);
    const meterable = await listMeterableWarmLeases(db);
    expect(meterable.map((m) => m.sandboxGroupId)).not.toContain(ws.groupId);
  }, 60_000);
});
