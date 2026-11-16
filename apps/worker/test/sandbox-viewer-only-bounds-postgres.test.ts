import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import type { Settings } from "@opengeni/config";
import {
  acquireLease as acquireLeaseUnscoped,
  commitWarmingToWarm,
  createDb,
  heartbeatLeaseHolderStatus,
  listMeterableWarmLeases,
  withCreditDebitAttribution,
  type Database,
  type DbClient,
  type ViewerOnlyWarmLease,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { createObservability } from "@opengeni/observability";
import { createSandboxLeaseActivities } from "../src/activities/sandbox-lease";
import type { ActivityServices } from "../src/activities/types";
import {
  boundViewerOnlyWarmBoxes,
  planViewerOnlyCapDrains,
  planViewerOnlyIdleDrains,
  viewerOnlyCapGateMs,
} from "../src/activities/sandbox-viewer-only-bounds";

// The reaper's bounds on warm boxes held only by viewers (docs/run-lifecycle.md,
// "Boxes held only by viewers"): the pure planners, and full maintenance
// passes against real PostgreSQL with the decisions observable as structured
// logs and opengeni_sandbox_viewer_only_drains_total{reason}.

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-16T12:00:00Z");

function lease(overrides: Partial<ViewerOnlyWarmLease> & { id: string }): ViewerOnlyWarmLease {
  const { id, ...rest } = overrides;
  return {
    accountId: "account-a",
    workspaceId: "workspace-a",
    sandboxGroupId: id,
    leaseEpoch: 1,
    viewerHolders: 1,
    lastActiveAt: new Date(NOW - MINUTE),
    observedAt: new Date(NOW),
    interactionReported: true,
    openSessionWork: false,
    transitioning: false,
    ...rest,
  };
}

const ago = (minutes: number) => new Date(NOW - minutes * MINUTE);

describe("planViewerOnlyIdleDrains", () => {
  test("drains idle boxes and keeps active, open-work and transitioning ones", () => {
    const drains = planViewerOnlyIdleDrains(
      [
        lease({ id: "idle", lastActiveAt: ago(31) }),
        lease({ id: "active", lastActiveAt: ago(2) }),
        lease({ id: "open", lastActiveAt: ago(90), openSessionWork: true }),
        lease({ id: "moving", lastActiveAt: ago(90), transitioning: true }),
      ],
      { idleDrainMs: 30 * MINUTE },
    );
    expect(drains).toEqual([
      expect.objectContaining({ reason: "viewer_idle", quietForMs: 30 * MINUTE }),
    ]);
    expect(drains[0]!.lease.sandboxGroupId).toBe("idle");
  });

  test("an idle window of 0 disables idle draining", () => {
    expect(
      planViewerOnlyIdleDrains([lease({ id: "old", lastActiveAt: ago(24 * 60) })], {
        idleDrainMs: 0,
      }),
    ).toEqual([]);
  });
});

describe("planViewerOnlyCapDrains", () => {
  test("drains the least recently active quiet boxes over the cap, per account across workspaces", () => {
    const plan = planViewerOnlyCapDrains(
      [
        lease({ id: "a1", workspaceId: "w1", lastActiveAt: ago(8) }),
        lease({ id: "a2", workspaceId: "w2", lastActiveAt: ago(12) }),
        lease({ id: "a3", workspaceId: "w1", lastActiveAt: ago(1) }),
        lease({ id: "a4", workspaceId: "w2", lastActiveAt: ago(10) }),
        // Open work is never counted against the cap.
        lease({ id: "a5", workspaceId: "w3", openSessionWork: true }),
        // Another account under its cap.
        lease({ id: "b1", accountId: "account-b", workspaceId: "wb" }),
      ],
      { maxPerAccount: 2, quietMs: 5 * MINUTE },
    );
    expect(plan.drains.map((drain) => drain.lease.sandboxGroupId)).toEqual(["a2", "a4"]);
    expect(plan.drains[0]).toMatchObject({
      reason: "viewer_account_cap",
      quietForMs: 5 * MINUTE,
      activeAtOrBefore: ago(12),
    });
    expect(plan.cappedAccounts).toEqual([{ accountId: "account-a", workspaceId: "w2" }]);
  });

  test("boxes people are using are never evicted, even far over the cap", () => {
    const leases = Array.from({ length: 11 }, (_, index) =>
      lease({ id: `busy-${index}`, lastActiveAt: ago(index % 4) }),
    );
    const plan = planViewerOnlyCapDrains(leases, { maxPerAccount: 10, quietMs: 5 * MINUTE });
    expect(plan.drains).toEqual([]);
    // Still at the cap: further viewer-only warming is gated instead.
    expect(plan.cappedAccounts).toHaveLength(1);
  });

  test("a transitioning box counts but is not drained; 0 disables the cap", () => {
    const leases = [
      lease({ id: "moving", lastActiveAt: ago(20), transitioning: true }),
      lease({ id: "older", lastActiveAt: ago(10) }),
      lease({ id: "newer", lastActiveAt: ago(9) }),
    ];
    expect(
      planViewerOnlyCapDrains(leases, { maxPerAccount: 2, quietMs: 5 * MINUTE }).drains.map(
        (drain) => drain.lease.sandboxGroupId,
      ),
    ).toEqual(["older"]);
    expect(planViewerOnlyCapDrains(leases, { maxPerAccount: 0 })).toEqual({
      drains: [],
      cappedAccounts: [],
    });
  });

  test("the cap gate outlives the gap to the next pass", () => {
    expect(viewerOnlyCapGateMs(30_000)).toBe(120_000);
    expect(viewerOnlyCapGateMs(60_000)).toBe(180_000);
  });
});

describe("boundViewerOnlyWarmBoxes (real PostgreSQL)", () => {
  let shared: SharedTestDatabase | null = null;
  let admin: postgres.Sql;
  let client: DbClient;
  let db: Database;

  beforeAll(async () => {
    shared = await acquireSharedTestDatabase("worker-viewer-only-bounds");
    if (!shared) throw new Error("Real PostgreSQL required for viewer-only bounds");
    admin = shared.admin;
    client = createDb(shared.appUrl);
    db = client.db;
  }, 180_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await shared?.release();
  }, 180_000);

  const acquireLease: typeof acquireLeaseUnscoped = (database, input) =>
    withCreditDebitAttribution({ kind: "service" }, () => acquireLeaseUnscoped(database, input));

  async function workspace(accountId?: string) {
    let account = accountId;
    if (!account) {
      const [row] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('acct') returning id`;
      account = row!.id;
    }
    const [row] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account}, 'ws') returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${row!.id}, ${account})`;
    return { accountId: account, workspaceId: row!.id };
  }

  async function warmViewerBox(
    ids: { accountId: string; workspaceId: string },
    attachedMinutesAgo: number,
    extraHolder?: "turn" | "direct",
  ) {
    const groupId = crypto.randomUUID();
    const holderId = `tab-${groupId}`;
    for (const kind of ["viewer", ...(extraHolder ? [extraHolder] : [])] as const) {
      await acquireLease(db, {
        ...ids,
        sandboxGroupId: groupId,
        kind,
        holderId: kind === "viewer" ? holderId : `${kind}-${groupId}`,
        backend: "modal",
        leaseTtlMs: 90_000,
      });
    }
    const committed = await commitWarmingToWarm(db, {
      ...ids,
      sandboxGroupId: groupId,
      expectedEpoch: 0,
      instanceId: "box",
      leaseTtlMs: 90_000,
    });
    await admin`
      update sandbox_lease_holders holder set
        created_at = now() - (${String(attachedMinutesAgo)} || ' minutes')::interval
      from sandbox_leases lease
      where holder.lease_id = lease.id
        and lease.workspace_id = ${ids.workspaceId} and lease.sandbox_group_id = ${groupId}`;
    return { groupId, holderId, epoch: committed.lease!.leaseEpoch };
  }

  async function liveness(workspaceId: string, groupId: string) {
    const [row] = await admin<{ liveness: string }[]>`
      select liveness from sandbox_leases
      where workspace_id = ${workspaceId} and sandbox_group_id = ${groupId}`;
    return row!.liveness;
  }

  function recordingObservability() {
    const logs: {
      level: string;
      message: string;
      fields: Record<string, unknown>;
    }[] = [];
    const counters: { name: string; labels: Record<string, string> }[] = [];
    const record =
      (level: string) =>
      (message: string, fields: Record<string, unknown> = {}) =>
        logs.push({ level, message, fields });
    const observability = {
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      debug: record("debug"),
      incrementCounter: (input: { name: string; labels?: Record<string, string> }) =>
        counters.push({ name: input.name, labels: input.labels ?? {} }),
    };
    return { observability, logs, counters };
  }

  test("drains idle and over-cap viewer-only boxes, keeps active people and other holders, and gates the account", async () => {
    const first = await workspace();
    const second = await workspace(first.accountId);

    // Old client, attached 2 hours ago, never reported interaction: idle.
    const idle = await warmViewerBox(first, 120);
    // Active person: attached long ago but just interacted.
    const active = await warmViewerBox(first, 120);
    await heartbeatLeaseHolderStatus(db, {
      ...first,
      sandboxGroupId: active.groupId,
      kind: "viewer",
      holderId: active.holderId,
      leaseTtlMs: 90_000,
      expectedEpoch: active.epoch,
      interactionAgeMs: 2_000,
    });
    // Two more recent viewer-only boxes in the sibling workspace.
    const older = await warmViewerBox(second, 20);
    const newer = await warmViewerBox(second, 1);
    // A workspace of the same account with no viewer-only box.
    const empty = await workspace(first.accountId);
    // A turn next to the viewer: never counted or drained.
    const working = await warmViewerBox(second, 120, "turn");

    const settings = testSettings({
      sandboxBackend: "modal",
      sandboxViewerIdleDrainMs: 30 * MINUTE,
      sandboxMaxViewerOnlyWarmPerAccount: 2,
      sandboxLeaseReaperPeriodMs: 30_000,
    }) satisfies Settings;
    const { observability, logs, counters } = recordingObservability();
    const warm = (await listMeterableWarmLeases(db)).filter(
      (row) => row.accountId === first.accountId,
    );
    const result = await boundViewerOnlyWarmBoxes(
      { db, settings, observability: observability as never },
      warm,
    );

    expect(result.inspected).toBe(4);
    expect(result.drained).toEqual({ viewer_idle: 1, viewer_account_cap: 1 });
    expect(await liveness(first.workspaceId, idle.groupId)).toBe("draining");
    expect(await liveness(second.workspaceId, older.groupId)).toBe("draining");
    expect(await liveness(first.workspaceId, active.groupId)).toBe("warm");
    expect(await liveness(second.workspaceId, newer.groupId)).toBe("warm");
    expect(await liveness(second.workspaceId, working.groupId)).toBe("warm");

    // Drains run concurrently; compare without order.
    expect(
      counters.map((counter) => `${counter.name}{reason=${counter.labels.reason}}`).sort(),
    ).toEqual([
      "opengeni_sandbox_viewer_only_drains_total{reason=viewer_account_cap}",
      "opengeni_sandbox_viewer_only_drains_total{reason=viewer_idle}",
    ]);
    const drainedLogs = logs.filter(
      (log) => log.message === "sandbox reaper: drained viewer-only box",
    );
    const drainedBy = new Map(drainedLogs.map((log) => [log.fields.sandboxGroupId, log.fields]));
    expect(drainedBy.size).toBe(2);
    expect(drainedBy.get(idle.groupId)).toMatchObject({
      reason: "viewer_idle",
      interactionReported: false,
    });
    expect(drainedBy.get(older.groupId)).toMatchObject({
      reason: "viewer_account_cap",
    });

    // The account is at its cap: every workspace of it is gated for a short while.
    expect(result.cappedAccounts).toBe(1);
    const gates = await admin<{ id: string; gated: boolean }[]>`
        select id, sandbox_viewer_only_cap_until > now() as gated from workspaces
        where id in (${first.workspaceId}, ${second.workspaceId}, ${empty.workspaceId})`;
    expect(gates).toHaveLength(3);
    expect(gates.every((gate) => gate.gated)).toBe(true);
    await expect(
      acquireLease(db, {
        ...first,
        sandboxGroupId: crypto.randomUUID(),
        kind: "viewer",
        holderId: "tab-new",
        backend: "modal",
        leaseTtlMs: 90_000,
        viewerOnlyWarmCap: 2,
      }),
    ).rejects.toMatchObject({ reason: "viewer_only_cap" });
  }, 180_000);

  test("both bounds off leaves every box alone", async () => {
    const ids = await workspace();
    const box = await warmViewerBox(ids, 24 * 60);
    const settings = testSettings({
      sandboxBackend: "modal",
      sandboxViewerIdleDrainMs: 0,
      sandboxMaxViewerOnlyWarmPerAccount: 0,
    });
    const { observability } = recordingObservability();
    const warm = (await listMeterableWarmLeases(db)).filter(
      (row) => row.accountId === ids.accountId,
    );
    const result = await boundViewerOnlyWarmBoxes(
      { db, settings, observability: observability as never },
      warm,
    );
    expect(result.inspected).toBe(0);
    expect(await liveness(ids.workspaceId, box.groupId)).toBe("warm");
  }, 180_000);
  test("the reaper's maintenance sweep applies the bounds", async () => {
    const ids = await workspace();
    const idle = await warmViewerBox(ids, 120);
    const settings = testSettings({
      sandboxBackend: "modal",
      sandboxOwnershipEnabled: true,
      sandboxViewerIdleDrainMs: 30 * MINUTE,
      sandboxMaxViewerOnlyWarmPerAccount: 10,
    });
    const services = async (): Promise<ActivityServices> => ({
      settings,
      db,
      bus: null as never,
      runtime: null as never,
      objectStorage: null,
      documentServices: null as never,
      observability: createObservability(settings, { component: "worker-test" }),
      wakeSessionWorkflow: null,
    });
    const activities = createSandboxLeaseActivities(services, {
      sweepModalOrphans: async () => 0,
      inspectOpenSandboxKubernetesInventory: async () => null as never,
    });
    const result = await activities.maintainSandboxLeaseSweep({
      examined: 0,
      started: 0,
      alreadyRunning: 0,
      startFailed: 0,
      rotationsRequested: 0,
    });
    expect(result.forceDrained).toBeGreaterThanOrEqual(1);
    expect(await liveness(ids.workspaceId, idle.groupId)).toBe("draining");
  }, 180_000);
});
