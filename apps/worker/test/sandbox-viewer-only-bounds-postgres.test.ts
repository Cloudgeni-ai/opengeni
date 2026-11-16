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
  planViewerOnlyIdleDrains,
  planViewerOnlyLimitDrains,
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

describe("planViewerOnlyLimitDrains", () => {
  const organizationLimits = (limit: number | undefined) =>
    new Map<string, number | undefined>([["account-a", limit]]);

  test("drains the least recently active quiet boxes over the organization limit, across workspaces", () => {
    const drains = planViewerOnlyLimitDrains(
      [
        lease({ id: "a1", workspaceId: "w1", lastActiveAt: ago(8) }),
        lease({ id: "a2", workspaceId: "w2", lastActiveAt: ago(12) }),
        lease({ id: "a3", workspaceId: "w1", lastActiveAt: ago(1) }),
        lease({ id: "a4", workspaceId: "w2", lastActiveAt: ago(10) }),
        // Open work is never counted against a limit.
        lease({ id: "a5", workspaceId: "w3", openSessionWork: true }),
        // Another organization with no limit.
        lease({ id: "b1", accountId: "account-b", workspaceId: "wb", lastActiveAt: ago(60) }),
      ],
      { maxPerWorkspace: 0, organizationLimits: organizationLimits(2), quietMs: 5 * MINUTE },
    );
    expect(drains.map((drain) => drain.lease.sandboxGroupId)).toEqual(["a2", "a4"]);
    expect(drains[0]).toMatchObject({
      reason: "viewer_organization_limit",
      quietForMs: 5 * MINUTE,
      activeAtOrBefore: ago(12),
    });
  });

  test("drains over the workspace limit within each workspace", () => {
    const drains = planViewerOnlyLimitDrains(
      [
        lease({ id: "a1", workspaceId: "w1", lastActiveAt: ago(8) }),
        lease({ id: "a2", workspaceId: "w2", lastActiveAt: ago(12) }),
        lease({ id: "a3", workspaceId: "w1", lastActiveAt: ago(30) }),
        lease({ id: "a4", workspaceId: "w2", lastActiveAt: ago(10) }),
      ],
      { maxPerWorkspace: 1, organizationLimits: organizationLimits(undefined) },
    );
    expect(drains.map((drain) => [drain.lease.sandboxGroupId, drain.reason])).toEqual([
      ["a3", "viewer_workspace_limit"],
      ["a2", "viewer_workspace_limit"],
    ]);
  });

  test("boxes people are using are never evicted, even far over a limit", () => {
    const leases = Array.from({ length: 11 }, (_, index) =>
      lease({ id: `busy-${index}`, lastActiveAt: ago(index % 4) }),
    );
    expect(
      planViewerOnlyLimitDrains(leases, {
        maxPerWorkspace: 3,
        organizationLimits: organizationLimits(10),
        quietMs: 5 * MINUTE,
      }),
    ).toEqual([]);
  });

  test("a transitioning box counts but is not drained; no limits drain nothing", () => {
    const leases = [
      lease({ id: "moving", lastActiveAt: ago(20), transitioning: true }),
      lease({ id: "older", lastActiveAt: ago(10) }),
      lease({ id: "newer", lastActiveAt: ago(9) }),
    ];
    expect(
      planViewerOnlyLimitDrains(leases, {
        maxPerWorkspace: 0,
        organizationLimits: organizationLimits(2),
        quietMs: 5 * MINUTE,
      }).map((drain) => drain.lease.sandboxGroupId),
    ).toEqual(["older"]);
    expect(
      planViewerOnlyLimitDrains(leases, {
        maxPerWorkspace: 0,
        organizationLimits: organizationLimits(undefined),
      }),
    ).toEqual([]);
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

  test("drains idle and over-limit viewer-only boxes of a free self-serve organization, keeping active people and other holders", async () => {
    const first = await workspace();
    const second = await workspace(first.accountId);
    await admin`insert into organization_plans (account_id, plan_key, status)
      values (${first.accountId}, 'free', 'active')`;

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
    // A turn next to the viewer: never counted or drained.
    const working = await warmViewerBox(second, 120, "turn");

    // Default plan limits: Free keeps 2 viewer-only boxes per organization.
    const settings = testSettings({
      sandboxBackend: "modal",
      sandboxViewerIdleDrainMs: 30 * MINUTE,
      sandboxMaxViewerOnlyBoxesPerWorkspace: 3,
      sandboxPlanLimitsJson: "",
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
    expect(result.drained).toEqual({
      viewer_idle: 1,
      viewer_workspace_limit: 0,
      viewer_organization_limit: 1,
    });
    expect(await liveness(first.workspaceId, idle.groupId)).toBe("draining");
    expect(await liveness(second.workspaceId, older.groupId)).toBe("draining");
    expect(await liveness(first.workspaceId, active.groupId)).toBe("warm");
    expect(await liveness(second.workspaceId, newer.groupId)).toBe("warm");
    expect(await liveness(second.workspaceId, working.groupId)).toBe("warm");

    // Drains run concurrently; compare without order.
    expect(
      counters.map((counter) => `${counter.name}{reason=${counter.labels.reason}}`).sort(),
    ).toEqual([
      "opengeni_sandbox_viewer_only_drains_total{reason=viewer_idle}",
      "opengeni_sandbox_viewer_only_drains_total{reason=viewer_organization_limit}",
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
      reason: "viewer_organization_limit",
      limit: 2,
    });
  }, 180_000);

  test("a free organization with an external-source workspace is outside both bounds", async () => {
    const ids = await workspace();
    await admin`insert into organization_plans (account_id, plan_key, status)
      values (${ids.accountId}, 'free', 'active')`;
    await admin`insert into workspaces (account_id, name, external_source)
      values (${ids.accountId}, 'host', 'federation:test-host')`;
    const boxes = [
      await warmViewerBox(ids, 120),
      await warmViewerBox(ids, 60),
      await warmViewerBox(ids, 30),
      await warmViewerBox(ids, 20),
    ];
    const settings = testSettings({
      sandboxBackend: "modal",
      sandboxViewerIdleDrainMs: 10 * MINUTE,
      sandboxMaxViewerOnlyBoxesPerWorkspace: 1,
      sandboxPlanLimitsJson: "",
    });
    const { observability } = recordingObservability();
    const warm = (await listMeterableWarmLeases(db)).filter(
      (row) => row.accountId === ids.accountId,
    );
    const result = await boundViewerOnlyWarmBoxes(
      { db, settings, observability: observability as never },
      warm,
    );
    expect(result.exemptOrganizations).toBe(1);
    expect(result.drained).toEqual({
      viewer_idle: 0,
      viewer_workspace_limit: 0,
      viewer_organization_limit: 0,
    });
    for (const box of boxes) expect(await liveness(ids.workspaceId, box.groupId)).toBe("warm");
  }, 180_000);

  test("both bounds off leaves every box alone", async () => {
    const ids = await workspace();
    const box = await warmViewerBox(ids, 24 * 60);
    await warmViewerBox(ids, 24 * 60);
    const settings = testSettings({
      sandboxBackend: "modal",
      sandboxViewerIdleDrainMs: 0,
      sandboxMaxViewerOnlyBoxesPerWorkspace: 0,
      sandboxPlanLimitsJson: "{}",
    });
    const { observability } = recordingObservability();
    const warm = (await listMeterableWarmLeases(db)).filter(
      (row) => row.accountId === ids.accountId,
    );
    const result = await boundViewerOnlyWarmBoxes(
      { db, settings, observability: observability as never },
      warm,
    );
    expect(result.inspected).toBe(2);
    expect(result.drained).toEqual({
      viewer_idle: 0,
      viewer_workspace_limit: 0,
      viewer_organization_limit: 0,
    });
    expect(await liveness(ids.workspaceId, box.groupId)).toBe("warm");
  }, 180_000);

  test("the reaper's maintenance sweep applies the bounds", async () => {
    const ids = await workspace();
    const idle = await warmViewerBox(ids, 120);
    const settings = testSettings({
      sandboxBackend: "modal",
      sandboxOwnershipEnabled: true,
      sandboxViewerIdleDrainMs: 30 * MINUTE,
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
