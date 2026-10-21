import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import { createDb, reapStaleLeaseHoldersGlobal } from "../src";
import { migrate } from "../src/migrate";

const migrationUrl = new URL("../drizzle/0883_retired_instance_interactions.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const sweepInput = {
  viewerHolderTtlMs: 90_000,
  turnHolderTtlMs: 90_000,
  interactionHolderTtlMs: 90_000,
  idleGraceMs: 0,
};

describe("migration 0883 retired-instance interactions", () => {
  let owned: OwnerMigratedTestDatabase | null = null;
  let client: ReturnType<typeof createDb> | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("retired-instance-interactions");
    if (!owned) {
      if (requireRealDatabase) throw new Error("real database required but unavailable");
      return;
    }
    await migrate(owned.ownerUrl);
    client = createDb(owned.ownerUrl, { max: 2 });
  }, 900_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await owned?.release();
  }, 120_000);

  test("is a bounded, idempotent rolling patch of the interaction reaper", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(
      source.match(/LIMIT 500\n        FOR UPDATE OF (?:lease|holder) SKIP LOCKED/gu),
    ).toHaveLength(2);
    expect(source).toContain("prerequisite drift");
    expect(source).not.toMatch(/last_heartbeat_at\s*</u);
    if (!owned) return;
    const [row] = await owned.admin<Array<{ definition: string }>>`
      select pg_get_functiondef(
        'opengeni_private.reap_stale_interaction_transitions(bigint)'::regprocedure
      ) as definition`;
    expect(row!.definition.match(/0883 retired placement instance/gu)).toHaveLength(1);
    // Replaying the migration leaves the routine unchanged.
    await owned.admin.unsafe(source);
    const [again] = await owned.admin<Array<{ definition: string }>>`
      select pg_get_functiondef(
        'opengeni_private.reap_stale_interaction_transitions(bigint)'::regprocedure
      ) as definition`;
    expect(again!.definition).toBe(row!.definition);
  });

  test("closes browsers and desktops whose instance is gone so their sandbox drains", async () => {
    if (!owned || !client) return;
    const { admin } = owned;
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    // A warm sandbox whose browser and desktop still name the instance it ran
    // before the provider lost it.
    const replacedGroupId = crypto.randomUUID();
    const replacedLeaseId = crypto.randomUUID();
    // A sandbox that went cold with its browser still marked active.
    const coldGroupId = crypto.randomUUID();
    const coldLeaseId = crypto.randomUUID();
    // A healthy sandbox: a browser on its current instance and one still starting.
    const liveGroupId = crypto.randomUUID();
    const liveLeaseId = crypto.randomUUID();

    const retiredBrowserId = crypto.randomUUID();
    const retiredComputerId = crypto.randomUUID();
    const preparedComputerOperationId = crypto.randomUUID();
    const coldBrowserId = crypto.randomUUID();
    const liveBrowserId = crypto.randomUUID();
    const startingBrowserId = crypto.randomUUID();
    const generation = crypto.randomUUID();
    const createOperationIds = new Map<string, string>(
      [retiredBrowserId, retiredComputerId, coldBrowserId, liveBrowserId, startingBrowserId].map(
        (id) => [id, crypto.randomUUID()] as const,
      ),
    );

    await admin.begin(async (tx) => {
      await tx`
        insert into managed_accounts (id, name)
        values (${accountId}, 'retired-instance-account')`;
      await tx`
        insert into workspaces (id, account_id, name)
        values (${workspaceId}, ${accountId}, 'retired-instance-workspace')`;
      await tx`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${accountId})`;
      await tx`
        insert into workspace_interaction_revisions (workspace_id, account_id)
        values (${workspaceId}, ${accountId})`;
      await tx`
        insert into sandbox_leases (
          id, account_id, workspace_id, sandbox_group_id, liveness,
          instance_id, backend, lease_epoch, expires_at, refcount
        ) values
          (
            ${replacedLeaseId}, ${accountId}, ${workspaceId}, ${replacedGroupId}, 'warm',
            'box-replacement', 'docker', 3, now() + interval '1 hour', 2
          ),
          (
            ${coldLeaseId}, ${accountId}, ${workspaceId}, ${coldGroupId}, 'cold',
            null, 'docker', 4, now() + interval '1 hour', 1
          ),
          (
            ${liveLeaseId}, ${accountId}, ${workspaceId}, ${liveGroupId}, 'warm',
            'box-live', 'docker', 1, now() + interval '1 hour', 2
          )`;

      for (const [resourceId, operationId] of createOperationIds) {
        await tx`
          insert into interaction_operations (
            operation_id, account_id, workspace_id, resource_kind, resource_id,
            kind, request_digest, state, controller_generation, actor_subject_id,
            dispatched_at, settled_at
          ) values (
            ${operationId}, ${accountId}, ${workspaceId},
            ${resourceId === retiredComputerId ? "computer_session" : "browser_session"},
            ${resourceId}, 'create', ${"a".repeat(64)},
            ${resourceId === startingBrowserId ? "prepared" : "completed"},
            ${resourceId === startingBrowserId ? null : generation}, 'retired-test',
            ${resourceId === startingBrowserId ? null : new Date()},
            ${resourceId === startingBrowserId ? null : new Date()}
          )`;
      }

      const browser = (
        id: string,
        groupId: string,
        lifecycle: string,
        instanceId: string | null,
      ) => tx`
        insert into browser_sessions (
          id, account_id, workspace_id, name, lifecycle, placement_kind,
          sandbox_group_id, controller_host_sandbox_group_id, controller_id,
          controller_generation, placement_instance_id, driver_id, engine,
          headless, capabilities, create_operation_id, created_by_subject_id,
          controller_heartbeat_at
        ) values (
          ${id}, ${accountId}, ${workspaceId}, 'Browser', ${lifecycle}, 'sandbox_group',
          ${groupId}, ${groupId},
          ${instanceId ? "browserd:retired-test" : null},
          ${instanceId ? generation : null}, ${instanceId}, 'opengeni.cdp.v1',
          'chromium', true, '{}'::jsonb, ${createOperationIds.get(id)!}, 'retired-test',
          ${instanceId ? new Date() : null}
        )`;
      await browser(retiredBrowserId, replacedGroupId, "active", "box-lost");
      await browser(coldBrowserId, coldGroupId, "active", "box-drained");
      await browser(liveBrowserId, liveGroupId, "active", "box-live");
      await browser(startingBrowserId, liveGroupId, "starting", null);

      await tx`
        insert into computer_sessions (
          id, account_id, workspace_id, name, lifecycle, placement_kind,
          sandbox_group_id, controller_id, controller_generation,
          placement_instance_id, platform, adapter, seat_id, display_id,
          capabilities, create_operation_id, created_by_subject_id,
          controller_heartbeat_at
        ) values (
          ${retiredComputerId}, ${accountId}, ${workspaceId}, 'Desktop', 'active',
          'sandbox_group', ${replacedGroupId}, 'browserd:retired-test', ${generation},
          'box-lost', 'linux', 'native', 'seat-1', 'display-1', '{}'::jsonb,
          ${createOperationIds.get(retiredComputerId)!}, 'retired-test', now()
        )`;
      await tx`
        insert into interaction_operations (
          operation_id, account_id, workspace_id, resource_kind, resource_id,
          kind, request_digest, state, actor_subject_id, updated_at
        ) values (
          ${preparedComputerOperationId}, ${accountId}, ${workspaceId},
          'computer_session', ${retiredComputerId}, 'end', ${"e".repeat(64)},
          'prepared', 'retired-test', now()
        )`;

      for (const [leaseId, holderId] of [
        [replacedLeaseId, `browser-session:${retiredBrowserId}`],
        [replacedLeaseId, `computer-session:${retiredComputerId}`],
        [coldLeaseId, `browser-session:${coldBrowserId}`],
        [liveLeaseId, `browser-session:${liveBrowserId}`],
        [liveLeaseId, `browser-session:${startingBrowserId}`],
      ] as const) {
        // Heartbeats are recent: the decision is the instance, not age.
        await tx`
          insert into sandbox_lease_holders (
            account_id, workspace_id, lease_id, kind, holder_id, last_heartbeat_at
          ) values (
            ${accountId}, ${workspaceId}, ${leaseId}, 'interaction', ${holderId}, now()
          )`;
      }
    });

    // First sweep: the stranded resources close and the replaced sandbox,
    // now holderless, starts its idle drain.
    expect(await reapStaleLeaseHoldersGlobal(client.db, sweepInput)).toEqual([]);

    const resources = await admin<
      Array<{
        id: string;
        lifecycle: string;
        failureCode: string | null;
        placementInstanceId: string | null;
        controllerGeneration: string | null;
      }>
    >`
      select id, lifecycle, failure_code as "failureCode",
        placement_instance_id as "placementInstanceId",
        controller_generation as "controllerGeneration"
      from browser_sessions where workspace_id = ${workspaceId}
      union all
      select id, lifecycle, failure_code, placement_instance_id, controller_generation
      from computer_sessions where workspace_id = ${workspaceId}`;
    const byId = Object.fromEntries(resources.map((resource) => [resource.id, resource]));
    for (const id of [retiredBrowserId, retiredComputerId, coldBrowserId]) {
      expect(byId[id]).toEqual({
        id,
        lifecycle: "lost",
        failureCode: "placement_instance_lost",
        placementInstanceId: null,
        controllerGeneration: null,
      });
    }
    expect(byId[liveBrowserId]).toMatchObject({
      lifecycle: "active",
      failureCode: null,
      placementInstanceId: "box-live",
    });
    expect(byId[startingBrowserId]).toMatchObject({ lifecycle: "starting", failureCode: null });

    const [operation] = await admin<
      Array<{ state: string; errorCode: string | null; reason: string | null }>
    >`
      select state, error_code as "errorCode", error_details ->> 'reason' as reason
      from interaction_operations where operation_id = ${preparedComputerOperationId}`;
    expect(operation).toEqual({
      state: "failed",
      errorCode: "controller_lost",
      reason: "placement_instance_retired",
    });

    const leases = await admin<
      Array<{ id: string; liveness: string; refcount: number; holders: number }>
    >`
      select lease.id, lease.liveness, lease.refcount,
        (select count(*)::int from sandbox_lease_holders holder
          where holder.lease_id = lease.id) as holders
      from sandbox_leases lease where lease.workspace_id = ${workspaceId}`;
    expect(Object.fromEntries(leases.map((lease) => [lease.id, lease]))).toEqual({
      [replacedLeaseId]: { id: replacedLeaseId, liveness: "draining", refcount: 0, holders: 0 },
      // A cold lease's refcount is recomputed when it is next acquired.
      [coldLeaseId]: { id: coldLeaseId, liveness: "cold", refcount: 1, holders: 0 },
      [liveLeaseId]: { id: liveLeaseId, liveness: "warm", refcount: 2, holders: 2 },
    });
    const [revision] = await admin<Array<{ revision: string }>>`
      select revision::text from workspace_interaction_revisions
      where workspace_id = ${workspaceId}`;
    expect(revision!.revision).toBe("1");

    // Second sweep: the idle grace (zero here) has passed and the replaced
    // sandbox is handed to the ordinary drain. The healthy one stays warm.
    expect(await reapStaleLeaseHoldersGlobal(client.db, sweepInput)).toEqual([
      {
        workspaceId,
        sandboxGroupId: replacedGroupId,
        instanceId: "box-replacement",
        leaseEpoch: 3,
      },
    ]);
    const [live] = await admin<Array<{ liveness: string; lifecycle: string }>>`
      select lease.liveness, browser.lifecycle
      from sandbox_leases lease, browser_sessions browser
      where lease.id = ${liveLeaseId} and browser.id = ${liveBrowserId}`;
    expect(live).toEqual({ liveness: "warm", lifecycle: "active" });
  }, 900_000);
});
