import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  accrueWarmSeconds,
  acquireLease,
  commitWarmingToWarm,
  confirmDrainCold,
  createDb,
  forceDrainOverLimitViewerOnlyBoxes,
  listMeterableWarmLeases,
  markWarmBillingStopCutoff,
  listSandboxViewerForceDrainWorkspaceIds,
  reArmDrainingLease,
  releaseLeaseHolder,
  SandboxViewerAdmissionBlockedError,
  SandboxPaidComputeAdmissionError,
  heartbeatLeaseHolderStatus,
  type Database,
  type DbClient,
} from "../src/index";

// P2.1 warm-time metering driven through the REAL packages/db query fns
// (accrueWarmSeconds / forceDrainOverLimitViewerOnlyBoxes / listMeterableWarmLeases)
// against a THROWAWAY postgres. We prove the Critical meter key:
//
//   (1) a warm box accrues sandbox.warm_seconds from the warm transition,
//       including its FIRST tick and the final draining tick.
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
//       guard). Only credits mode debits warm cost.
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
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id, groupId: crypto.randomUUID() };
}

// Bring a fresh group to WARM at epoch 1 with one turn holder (so it is alive),
// then return the epoch. Backdates last_meter_at so the next accrue tick sees
// elapsed seconds without a real sleep.
async function warmGroup(
  ids: { accountId: string; workspaceId: string; groupId: string },
  holders: { kind: "turn" | "viewer" | "direct" | "interaction"; holderId: string }[],
  warmBilling?: { mode: "usage_only" | "shadow" | "credits"; rateMicrosPerSecond: number },
): Promise<number> {
  for (const h of holders) {
    await acquireLease(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sandboxGroupId: ids.groupId,
      kind: h.kind,
      holderId: h.holderId,
      backend: "modal",
      ...(warmBilling ? { warmBilling } : {}),
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

async function backdateWarmStart(workspaceId: string, groupId: string, secondsAgo: number) {
  await admin`
    update sandbox_leases set resume_state = jsonb_set(
      resume_state, '{opengeniRecovery,restore,completedAt}',
      to_jsonb((now() - (${String(secondsAgo)} || ' seconds')::interval)::text))
    where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
}

async function readMeterRow(workspaceId: string, groupId: string) {
  const [r] = await admin`
    select last_meter_tick, last_meter_at from sandbox_leases
    where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
  return r as { last_meter_tick: number; last_meter_at: Date | null } | undefined;
}

async function readViewerForceDrain(workspaceId: string) {
  const [row] = await admin<
    {
      reason: "balance" | "warm_cap" | null;
      requested_at: Date | null;
    }[]
  >`
    select
      sandbox_viewer_force_drain_reason as reason,
      sandbox_viewer_force_drain_requested_at as requested_at
    from workspaces
    where id = ${workspaceId}`;
  return row;
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
}, 180_000);

describe("P2.1 warm-time metering (real packages/db + RLS)", () => {
  test("paid admissions fence zero balance before cold create, warm join and draining re-arm; unpriced modes remain usable", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const paid = { mode: "credits" as const, rateMicrosPerSecond: 100 };
    const acquire = (
      kind: "turn" | "viewer" | "direct" | "interaction",
      holderId: string,
      warmBilling: {
        mode: "usage_only" | "shadow" | "credits";
        rateMicrosPerSecond: number;
      } = paid,
    ) =>
      acquireLease(db, {
        ...ws,
        sandboxGroupId: ws.groupId,
        kind,
        holderId,
        backend: "modal",
        leaseTtlMs: 90_000,
        warmBilling,
      });
    for (const kind of ["turn", "viewer", "direct", "interaction"] as const) {
      await expect(acquire(kind, `unfunded-${kind}`)).rejects.toBeInstanceOf(
        SandboxPaidComputeAdmissionError,
      );
    }
    expect(await readLiveness(ws.workspaceId, ws.groupId)).toBe("cold");
    expect(
      (await acquire("viewer", "free", { mode: "credits", rateMicrosPerSecond: 0 })).role,
    ).toBe("spawner");
    const committed = await commitWarmingToWarm(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      expectedEpoch: 0,
      instanceId: "box",
      leaseTtlMs: 90_000,
    });
    expect(committed.committed).toBe(true);
    // Enabling a paid rate cannot turn an already-running free box into a
    // paid box: every holder type can still join it at zero balance.
    for (const kind of ["turn", "viewer", "direct", "interaction"] as const) {
      expect((await acquire(kind, `free-${kind}`)).role).toBe("attached");
    }
    expect(await readLiveness(ws.workspaceId, ws.groupId)).toBe("warm");

    const paidWs = await freshWorkspace();
    await seedBalance(paidWs.accountId, 500);
    await warmGroup(paidWs, [{ kind: "viewer", holderId: "paid-viewer" }], paid);
    await seedBalance(paidWs.accountId, -500);
    const paidAcquire = (kind: "turn" | "viewer" | "direct" | "interaction", holderId: string) =>
      acquireLease(db, {
        ...paidWs,
        sandboxGroupId: paidWs.groupId,
        kind,
        holderId,
        backend: "modal",
        leaseTtlMs: 90_000,
        warmBilling: paid,
      });
    for (const kind of ["turn", "viewer", "direct", "interaction"] as const) {
      await expect(paidAcquire(kind, `zero-${kind}`)).rejects.toBeInstanceOf(
        SandboxPaidComputeAdmissionError,
      );
    }
    // Once its last holder releases, the paid lease may drain; standalone
    // re-arm still checks credits before prolonging it.
    await releaseLeaseHolder(db, {
      ...paidWs,
      sandboxGroupId: paidWs.groupId,
      kind: "viewer",
      holderId: "paid-viewer",
      idleGraceMs: 0,
    });
    expect(await readLiveness(paidWs.workspaceId, paidWs.groupId)).toBe("draining");
    await expect(
      reArmDrainingLease(db, {
        ...paidWs,
        sandboxGroupId: paidWs.groupId,
        leaseTtlMs: 90_000,
        warmBilling: paid,
      }),
    ).rejects.toBeInstanceOf(SandboxPaidComputeAdmissionError);
    await expect(paidAcquire("direct", "zero-rearm")).rejects.toBeInstanceOf(
      SandboxPaidComputeAdmissionError,
    );
    // A new top-up reopens paid admission without depending on the reaper.
    await seedBalance(paidWs.accountId, 500);
    expect((await paidAcquire("turn", "funded-rearm")).role).toBe("rearmed");
  }, 60_000);

  test("paid first and fractional final intervals retain the admitted payer and rate while paid mode remains enabled", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await seedBalance(ws.accountId, 2_000);
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }], {
      mode: "credits",
      rateMicrosPerSecond: 400,
    });
    await backdateWarmStart(ws.workspaceId, ws.groupId, 3);
    const first = await accrueWarmSeconds(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      billingMode: "credits",
      warmRateMicrosPerSecond: 900,
    });
    expect(first.seconds).toBeGreaterThanOrEqual(3);
    expect(first.costMicros).toBe(first.seconds * 400);
    // A later configured rate cannot rewrite the running box's admitted price.
    await releaseLeaseHolder(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      kind: "turn",
      holderId: "t1",
      idleGraceMs: 0,
    });
    await admin`update sandbox_leases set last_meter_at = now() - interval '600 milliseconds'
      where workspace_id = ${ws.workspaceId} and sandbox_group_id = ${ws.groupId}`;
    const cutoff = await markWarmBillingStopCutoff(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
    });
    expect(cutoff).toBeInstanceOf(Date);
    const final = await accrueWarmSeconds(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      billingMode: "credits",
      warmRateMicrosPerSecond: 90_000,
      finalDrain: true,
    });
    expect(final.accrued).toBe(true);
    expect(final.seconds).toBe(0);
    expect(final.costMicros).toBeGreaterThan(0);
    expect(final.costMicros).toBeLessThan(400);
    expect(await eventCount(ws.workspaceId, "sandbox.warm_cost")).toBe(2);
    // A delayed settlement retry cannot advance beyond the durable stop time.
    expect(
      (
        await accrueWarmSeconds(db, {
          ...ws,
          sandboxGroupId: ws.groupId,
          expectedEpoch: epoch,
          warmRateMicrosPerSecond: 99,
          billingMode: "credits",
          finalDrain: true,
        })
      ).accrued,
    ).toBe(false);
  }, 60_000);

  test("usage_only rollback stops an old paid lease's charge and funding fence", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await seedBalance(ws.accountId, 100);
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "old-turn" }], {
      mode: "credits",
      rateMicrosPerSecond: 10,
    });
    await backdateWarmStart(ws.workspaceId, ws.groupId, 2);
    await seedBalance(ws.accountId, -100);
    const tick = await accrueWarmSeconds(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      billingMode: "usage_only",
      warmRateMicrosPerSecond: 0,
    });
    expect(tick.accrued).toBe(true);
    expect(tick.costMicros).toBe(0);
    expect(await eventCount(ws.workspaceId, "sandbox.warm_cost")).toBe(0);
    expect(
      await heartbeatLeaseHolderStatus(db, {
        ...ws,
        sandboxGroupId: ws.groupId,
        kind: "turn",
        holderId: "old-turn",
        expectedEpoch: epoch,
        leaseTtlMs: 90_000,
        billingMode: "usage_only",
      }),
    ).toMatchObject({ holderAlive: true, leaseExtended: true, fence: null });
    expect(
      (
        await acquireLease(db, {
          ...ws,
          sandboxGroupId: ws.groupId,
          kind: "viewer",
          holderId: "new-viewer",
          backend: "modal",
          leaseTtlMs: 90_000,
          warmBilling: { mode: "usage_only", rateMicrosPerSecond: 0 },
        })
      ).role,
    ).toBe("attached");
  }, 60_000);

  test("removing the current rate does not reprice an already admitted paid lease", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await seedBalance(ws.accountId, 1_000);
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "rate-change" }], {
      mode: "credits",
      rateMicrosPerSecond: 20,
    });
    await backdateWarmStart(ws.workspaceId, ws.groupId, 3);
    const tick = await accrueWarmSeconds(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      billingMode: "credits",
      warmRateMicrosPerSecond: 0,
    });
    expect(tick.accrued).toBe(true);
    expect(tick.costMicros).toBe(tick.seconds * 20);
    expect(await eventCount(ws.workspaceId, "sandbox.warm_cost")).toBe(1);
  }, 60_000);

  test("a provider still running after a failed stop gets a fresh cutoff on re-arm", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await seedBalance(ws.accountId, 1_000);
    const epoch = await warmGroup(ws, [{ kind: "viewer", holderId: "first" }], {
      mode: "credits",
      rateMicrosPerSecond: 20,
    });
    await releaseLeaseHolder(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      kind: "viewer",
      holderId: "first",
      idleGraceMs: 0,
    });
    const firstCutoff = await markWarmBillingStopCutoff(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
    });
    expect(firstCutoff).toBeInstanceOf(Date);
    expect(
      (
        await acquireLease(db, {
          ...ws,
          sandboxGroupId: ws.groupId,
          kind: "viewer",
          holderId: "second",
          backend: "modal",
          warmBilling: { mode: "credits", rateMicrosPerSecond: 20 },
          leaseTtlMs: 90_000,
        })
      ).role,
    ).toBe("rearmed");
    const [rearmed] = await admin<{ state: { opengeniWarmBilling: { stopChargeAt?: string } } }[]>`
      select resume_state as state from sandbox_leases
      where workspace_id = ${ws.workspaceId} and sandbox_group_id = ${ws.groupId}`;
    expect(rearmed?.state.opengeniWarmBilling.stopChargeAt).toBeUndefined();
  }, 60_000);

  test("paid lease extension refuses zero balance without removing its active holder", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await seedBalance(ws.accountId, 100);
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }], {
      mode: "credits",
      rateMicrosPerSecond: 10,
    });
    await seedBalance(ws.accountId, -100);
    expect(
      await heartbeatLeaseHolderStatus(db, {
        ...ws,
        sandboxGroupId: ws.groupId,
        kind: "turn",
        holderId: "t1",
        expectedEpoch: epoch,
        leaseTtlMs: 90_000,
      }),
    ).toMatchObject({ holderAlive: true, leaseExtended: false, fence: "funding" });
    expect(await readLiveness(ws.workspaceId, ws.groupId)).toBe("warm");
    await seedBalance(ws.accountId, 100);
    expect(
      await heartbeatLeaseHolderStatus(db, {
        ...ws,
        sandboxGroupId: ws.groupId,
        kind: "turn",
        holderId: "t1",
        expectedEpoch: epoch,
        leaseTtlMs: 90_000,
      }),
    ).toMatchObject({ holderAlive: true, leaseExtended: true, fence: null });
  }, 60_000);

  test("(1) the FIRST tick includes the interval since warm transition", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }]);

    await backdateWarmStart(ws.workspaceId, ws.groupId, 5);
    const first = await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 0,
    });
    expect(first.accrued).toBe(true);
    expect(first.seconds).toBeGreaterThanOrEqual(5);
    const afterFirst = await readMeterRow(ws.workspaceId, ws.groupId);
    expect(afterFirst?.last_meter_at).not.toBeNull();
    expect(afterFirst?.last_meter_tick).toBe(1);
    expect(await warmSecondsEvents(ws.workspaceId, ws.groupId)).toHaveLength(1);

    // A subsequent tick advances the same stream.
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
    expect(accrue.tick).toBe(2);
    const events = await warmSecondsEvents(ws.workspaceId, ws.groupId);
    expect(events).toHaveLength(2);
    const afterAccrue = await readMeterRow(ws.workspaceId, ws.groupId);
    expect(afterAccrue?.last_meter_tick).toBe(2);
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

  test("(6) zero balance cannot drain any already active holder", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    // Box V: viewer-only (turn_holders=0) — eligible for force-drain.
    const viewerOnly = { ...ws, groupId: crypto.randomUUID() };
    await warmGroup(viewerOnly, [{ kind: "viewer", holderId: "v1" }]);
    const groups = await Promise.all(
      (["turn", "direct", "interaction"] as const).map(async (kind) => {
        const group = { ...ws, groupId: crypto.randomUUID() };
        await warmGroup(group, [{ kind, holderId: kind }]);
        return group;
      }),
    );

    expect(await readLiveness(ws.workspaceId, viewerOnly.groupId)).toBe("warm");
    for (const group of groups)
      expect(await readLiveness(ws.workspaceId, group.groupId)).toBe("warm");

    // Balance is a NEW paid admission boundary, never a running-holder drain.
    const result = await forceDrainOverLimitViewerOnlyBoxes(db, {
      workspaceId: ws.workspaceId,
      enforceBalance: true,
      maxWarmSecondsPerWorkspace: 0,
      idleGraceMs: 0,
    });
    expect(result).toEqual({ overLimit: false, reason: null, drained: [] });
    expect(await readLiveness(ws.workspaceId, viewerOnly.groupId)).toBe("warm");
    for (const group of groups)
      expect(await readLiveness(ws.workspaceId, group.groupId)).toBe("warm");
  }, 60_000);

  test("(6b) warm cap fences new viewers but preserves an active viewer", async () => {
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

    // Balance enforcement OFF; cap closes new admission but cannot drop v1.
    const result = await forceDrainOverLimitViewerOnlyBoxes(db, {
      workspaceId: ws.workspaceId,
      enforceBalance: false,
      maxWarmSecondsPerWorkspace: 5,
      idleGraceMs: 0,
    });
    expect(result.overLimit).toBe(true);
    expect(result.reason).toBe("warm_cap");
    expect(result.drained).toHaveLength(0);
    expect(await readLiveness(ws.workspaceId, viewerOnly.groupId)).toBe("warm");
  }, 60_000);

  test("(6c) a durable warm-cap gate blocks new viewers until fresh cap evaluation clears it", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await warmGroup(ws, [{ kind: "viewer", holderId: "v1" }]);
    await admin`insert into usage_events (account_id, workspace_id, event_type, quantity, unit, idempotency_key, occurred_at)
      values (${ws.accountId}, ${ws.workspaceId}, 'sandbox.warm_seconds', 10, 'seconds', ${crypto.randomUUID()}, now())`;

    const drained = await forceDrainOverLimitViewerOnlyBoxes(db, {
      workspaceId: ws.workspaceId,
      enforceBalance: false,
      maxWarmSecondsPerWorkspace: 5,
      idleGraceMs: 60_000,
    });
    expect(drained.reason).toBe("warm_cap");
    expect(await readViewerForceDrain(ws.workspaceId)).toMatchObject({
      reason: "warm_cap",
      requested_at: expect.any(Date),
    });
    expect(await listSandboxViewerForceDrainWorkspaceIds(db)).toContain(ws.workspaceId);

    const acquireViewer = (holderId: string) =>
      acquireLease(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        sandboxGroupId: ws.groupId,
        kind: "viewer",
        holderId,
        backend: "modal",
        leaseTtlMs: 90_000,
      });

    let drainingError: unknown;
    try {
      await acquireViewer("v2");
    } catch (error) {
      drainingError = error;
    }
    expect(drainingError).toBeInstanceOf(SandboxViewerAdmissionBlockedError);
    expect((drainingError as SandboxViewerAdmissionBlockedError).reason).toBe("warm_cap");
    expect(await readLiveness(ws.workspaceId, ws.groupId)).toBe("warm");

    // The existing holder and its box remain intact.
    // The existing viewer stays protected even while new viewers are fenced.

    // A cap-window reset is evaluated explicitly; no balance top-up is needed.
    await admin`delete from usage_events where workspace_id = ${ws.workspaceId} and event_type = 'sandbox.warm_seconds'`;
    expect(
      await forceDrainOverLimitViewerOnlyBoxes(db, {
        workspaceId: ws.workspaceId,
        enforceBalance: false,
        maxWarmSecondsPerWorkspace: 5,
        idleGraceMs: 60_000,
      }),
    ).toEqual({ overLimit: false, reason: null, drained: [] });
    expect(await readViewerForceDrain(ws.workspaceId)).toMatchObject({
      reason: null,
      requested_at: null,
    });
    expect(await listSandboxViewerForceDrainWorkspaceIds(db)).not.toContain(ws.workspaceId);
    expect((await acquireViewer("v4")).role).toBe("attached");
  }, 60_000);

  test("(7) credits settles the full signed warm cost, idempotently, below zero", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await seedBalance(ws.accountId, 100);
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }]);
    await backdateWarmStart(ws.workspaceId, ws.groupId, 4);
    const accrue = await accrueWarmSeconds(db, {
      accountId: ws.accountId,
      workspaceId: ws.workspaceId,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 100,
      billingMode: "credits",
    });
    expect(accrue.accrued).toBe(true);
    expect(accrue.costMicros).toBe(accrue.seconds * 100);
    // Both meters recorded; they are orthogonal event types.
    expect(await eventCount(ws.workspaceId, "sandbox.warm_seconds")).toBe(1);
    expect(await eventCount(ws.workspaceId, "sandbox.warm_cost")).toBe(1);
    // The credit balance is debited by the actual warm-cost.
    const [bal] = await admin<{ b: number }[]>`
      select coalesce(sum(amount_micros), 0)::bigint as b from credit_ledger_entries where account_id = ${ws.accountId}`;
    expect(Number(bal!.b)).toBe(100 - accrue.costMicros);
    expect(Number(bal!.b)).toBeLessThan(0);

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
      billingMode: "credits",
    });
    expect(replay.tick).toBe(1);
    const [bal2] = await admin<{ b: number }[]>`
      select coalesce(sum(amount_micros), 0)::bigint as b from credit_ledger_entries where account_id = ${ws.accountId}`;
    expect(Number(bal2!.b)).toBe(100 - accrue.costMicros); // unchanged — no double-debit
  }, 60_000);

  test("a conflicting debit key rolls back the usage rows and cursor, leaving the tick retryable", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }]);
    await backdateWarmStart(ws.workspaceId, ws.groupId, 4);
    const key = `debit:sandbox.warm_cost:${ws.groupId}:${epoch}:1`;
    await admin`
      insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
      values (${ws.accountId}, 'grant', 1, ${key})`;

    const tick = () =>
      accrueWarmSeconds(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        sandboxGroupId: ws.groupId,
        expectedEpoch: epoch,
        warmRateMicrosPerSecond: 100,
        billingMode: "credits",
      });
    await expect(tick()).rejects.toThrow("idempotency key conflicts");
    expect(await warmSecondsEvents(ws.workspaceId, ws.groupId)).toHaveLength(0);
    expect(await eventCount(ws.workspaceId, "sandbox.warm_cost")).toBe(0);
    expect((await readMeterRow(ws.workspaceId, ws.groupId))?.last_meter_tick).toBe(0);
    await admin`delete from credit_ledger_entries where account_id = ${ws.accountId}
                and idempotency_key = ${key}`;
    expect((await tick()).accrued).toBe(true);
    expect(await eventCount(ws.workspaceId, "sandbox.warm_cost")).toBe(1);
  }, 60_000);

  test("usage_only ignores a configured rate; shadow records an estimate but never debits", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const epoch = await warmGroup(ws, [{ kind: "turn", holderId: "t1" }]);
    await backdateWarmStart(ws.workspaceId, ws.groupId, 5);
    const usage = await accrueWarmSeconds(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 100,
      billingMode: "usage_only",
    });
    expect(usage.costMicros).toBe(0);
    expect(await eventCount(ws.workspaceId, "sandbox.warm_cost")).toBe(0);
    await backdateMeterCursor(ws.workspaceId, ws.groupId, 4);
    const shadow = await accrueWarmSeconds(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      expectedEpoch: epoch,
      warmRateMicrosPerSecond: 100,
      billingMode: "shadow",
    });
    expect(shadow.costMicros).toBeGreaterThanOrEqual(400);
    expect(await eventCount(ws.workspaceId, "sandbox.warm_cost")).toBe(0);
    const [seconds] = await admin<{ context: { warmCostShadowMicros: number } }[]>`
      select initiator_context as context from usage_events
      where workspace_id = ${ws.workspaceId} and event_type = 'sandbox.warm_seconds'
      order by occurred_at desc limit 1`;
    expect(seconds?.context.warmCostShadowMicros).toBe(shadow.costMicros);
    const [ledger] = await admin<{ n: number }[]>`
      select count(*)::int as n from credit_ledger_entries where account_id = ${ws.accountId}`;
    expect(ledger!.n).toBe(0);
  }, 60_000);

  test("final drain meters the last interval once and spares a re-armed or cold epoch", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    await seedBalance(ws.accountId, 1_000);
    const epoch = await warmGroup(ws, [{ kind: "viewer", holderId: "v1" }], {
      mode: "credits",
      rateMicrosPerSecond: 100,
    });
    await backdateWarmStart(ws.workspaceId, ws.groupId, 5);
    await releaseLeaseHolder(db, {
      ...ws,
      sandboxGroupId: ws.groupId,
      kind: "viewer",
      holderId: "v1",
      idleGraceMs: 0,
    });
    expect(
      await markWarmBillingStopCutoff(db, {
        ...ws,
        sandboxGroupId: ws.groupId,
        expectedEpoch: epoch,
      }),
    ).toBeInstanceOf(Date);
    const tick = () =>
      accrueWarmSeconds(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        sandboxGroupId: ws.groupId,
        expectedEpoch: epoch,
        warmRateMicrosPerSecond: 100,
        billingMode: "credits",
        finalDrain: true,
      });
    expect((await tick()).seconds).toBeGreaterThanOrEqual(5);
    expect((await tick()).accrued).toBe(false);
    expect(await eventCount(ws.workspaceId, "sandbox.warm_cost")).toBe(1);
    expect(
      await confirmDrainCold(db, {
        accountId: ws.accountId,
        workspaceId: ws.workspaceId,
        sandboxGroupId: ws.groupId,
        expectedEpoch: epoch,
      }),
    ).toEqual({ wentCold: true });
    expect((await tick()).accrued).toBe(false);
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
