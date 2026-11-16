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
import {
  boundViewerOnlyWarmBoxes,
  planViewerOnlyDrains,
  viewerOnlyCapGateMs,
} from "../src/activities/sandbox-viewer-only-bounds";

// The reaper's bounds on warm boxes held only by viewers (docs/run-lifecycle.md,
// "Boxes held only by viewers"): the pure planner, and one full maintenance
// pass against real PostgreSQL with the decisions observable as structured
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
    interactionReported: true,
    openSessionWork: false,
    transitioning: false,
    ...rest,
  };
}

describe("planViewerOnlyDrains", () => {
  test("drains idle boxes and keeps active, open-work and transitioning ones", () => {
    const plan = planViewerOnlyDrains(
      [
        lease({ id: "idle", lastActiveAt: new Date(NOW - 31 * MINUTE) }),
        lease({ id: "active", lastActiveAt: new Date(NOW - 2 * MINUTE) }),
        lease({
          id: "open",
          lastActiveAt: new Date(NOW - 90 * MINUTE),
          openSessionWork: true,
        }),
        lease({
          id: "moving",
          lastActiveAt: new Date(NOW - 90 * MINUTE),
          transitioning: true,
        }),
      ],
      { nowMs: NOW, idleDrainMs: 30 * MINUTE, maxPerAccount: 0 },
    );
    expect(plan.drains.map((drain) => [drain.lease.sandboxGroupId, drain.reason])).toEqual([
      ["idle", "viewer_idle"],
    ]);
    expect(plan.drains[0]!.activeAtOrBefore.getTime()).toBe(NOW - 30 * MINUTE);
    expect(plan.cappedWorkspaces).toEqual([]);
  });

  test("an idle drain of 0 disables idle draining", () => {
    const plan = planViewerOnlyDrains(
      [lease({ id: "old", lastActiveAt: new Date(NOW - 24 * 60 * MINUTE) })],
      { nowMs: NOW, idleDrainMs: 0, maxPerAccount: 0 },
    );
    expect(plan.drains).toEqual([]);
  });

  test("the cap drains the least recently active over it, per account across workspaces", () => {
    const plan = planViewerOnlyDrains(
      [
        lease({
          id: "a1",
          workspaceId: "w1",
          lastActiveAt: new Date(NOW - 5 * MINUTE),
        }),
        lease({
          id: "a2",
          workspaceId: "w2",
          lastActiveAt: new Date(NOW - 9 * MINUTE),
        }),
        lease({
          id: "a3",
          workspaceId: "w1",
          lastActiveAt: new Date(NOW - 1 * MINUTE),
        }),
        lease({
          id: "a4",
          workspaceId: "w2",
          lastActiveAt: new Date(NOW - 7 * MINUTE),
        }),
        // Open work is never counted against the cap.
        lease({ id: "a5", workspaceId: "w3", openSessionWork: true }),
        // Another account under its cap.
        lease({ id: "b1", accountId: "account-b", workspaceId: "wb" }),
      ],
      { nowMs: NOW, idleDrainMs: 30 * MINUTE, maxPerAccount: 2 },
    );
    expect(plan.drains.map((drain) => [drain.lease.sandboxGroupId, drain.reason])).toEqual([
      ["a2", "viewer_account_cap"],
      ["a4", "viewer_account_cap"],
    ]);
    // A cap drain only proceeds if nothing happened since the ranked activity.
    expect(plan.drains[0]!.activeAtOrBefore.getTime()).toBe(NOW - 9 * MINUTE);
    expect(plan.cappedWorkspaces).toEqual([
      { accountId: "account-a", workspaceId: "w1" },
      { accountId: "account-a", workspaceId: "w2" },
    ]);
  });

  test("idle drains count first; a transitioning box counts but is not drained", () => {
    const plan = planViewerOnlyDrains(
      [
        lease({ id: "idle", lastActiveAt: new Date(NOW - 60 * MINUTE) }),
        lease({
          id: "moving",
          lastActiveAt: new Date(NOW - 20 * MINUTE),
          transitioning: true,
        }),
        lease({ id: "older", lastActiveAt: new Date(NOW - 10 * MINUTE) }),
        lease({ id: "newer", lastActiveAt: new Date(NOW - 1 * MINUTE) }),
      ],
      { nowMs: NOW, idleDrainMs: 30 * MINUTE, maxPerAccount: 2 },
    );
    expect(plan.drains.map((drain) => [drain.lease.sandboxGroupId, drain.reason])).toEqual([
      ["idle", "viewer_idle"],
      ["older", "viewer_account_cap"],
    ]);
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
    const newer = await warmViewerBox(second, 5);
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

    // The account is at its cap: both workspaces are gated for a short while.
    expect(result.cappedWorkspaces).toBe(2);
    const gates = await admin<{ id: string; gated: boolean }[]>`
        select id, sandbox_viewer_only_cap_until > now() as gated from workspaces
        where id in (${first.workspaceId}, ${second.workspaceId})`;
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
});
