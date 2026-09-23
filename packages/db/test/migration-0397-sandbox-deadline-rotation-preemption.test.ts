import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import { createDb, reapStaleLeaseHoldersGlobal } from "../src";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0397_sandbox_deadline_rotation_preemption.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0397 sandbox deadline rotation preemption", () => {
  let owned: OwnerMigratedTestDatabase | null = null;
  let client: ReturnType<typeof createDb> | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("sandbox-deadline-rotation-preemption");
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

  async function seedActiveBrowser(rotationReason: "provider_deadline" | "operator") {
    if (!owned) throw new Error("owner-migrated database unavailable");
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const sandboxGroupId = crypto.randomUUID();
    const leaseId = crypto.randomUUID();
    const browserId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const controllerGeneration = crypto.randomUUID();
    const instanceId = `${rotationReason}-preemption-instance`;
    await owned.admin.begin(async (tx) => {
      await tx`
        insert into managed_accounts (id, name)
        values (${accountId}, ${`${rotationReason}-preemption-account`})`;
      await tx`
        insert into workspaces (id, account_id, name)
        values (${workspaceId}, ${accountId}, ${`${rotationReason}-preemption-workspace`})`;
      await tx`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${accountId})`;
      await tx`
        insert into workspace_interaction_revisions (workspace_id, account_id)
        values (${workspaceId}, ${accountId})`;
      await tx`
        insert into sandbox_leases (
          id, account_id, workspace_id, sandbox_group_id, liveness,
          instance_id, backend, lease_epoch, expires_at, refcount,
          provider_created_at, provider_deadline_at,
          rotation_requested_at, rotation_reason
        ) values (
          ${leaseId}, ${accountId}, ${workspaceId}, ${sandboxGroupId}, 'warm',
          ${instanceId}, 'modal', 1, now() + interval '1 hour', 1,
          now() - interval '23 hours', now() + interval '1 hour',
          now(), ${rotationReason}
        )`;
      await tx`
        insert into interaction_operations (
          operation_id, account_id, workspace_id, resource_kind, resource_id,
          kind, request_digest, state, controller_generation, actor_subject_id,
          dispatched_at, settled_at
        ) values (
          ${operationId}, ${accountId}, ${workspaceId}, 'browser_session', ${browserId},
          'create', ${"a".repeat(64)}, 'completed', ${controllerGeneration},
          'rotation-preemption-test', now(), now()
        )`;
      await tx`
        insert into browser_sessions (
          id, account_id, workspace_id, name, lifecycle, placement_kind,
          sandbox_group_id, controller_host_sandbox_group_id, controller_id,
          controller_generation, placement_instance_id, driver_id, engine,
          headless, capabilities, create_operation_id, created_by_subject_id,
          controller_heartbeat_at
        ) values (
          ${browserId}, ${accountId}, ${workspaceId}, 'Rotation preemption browser',
          'active', 'sandbox_group', ${sandboxGroupId}, ${sandboxGroupId},
          'browserd:rotation-preemption', ${controllerGeneration}, ${instanceId},
          'opengeni.cdp.v1', 'chromium', true, '{}'::jsonb, ${operationId},
          'rotation-preemption-test', now()
        )`;
      await tx`
        insert into sandbox_lease_holders (
          account_id, workspace_id, lease_id, kind, holder_id, last_heartbeat_at
        ) values (
          ${accountId}, ${workspaceId}, ${leaseId}, 'interaction',
          ${`browser-session:${browserId}`}, now()
        )`;
    });
    return { workspaceId, sandboxGroupId, leaseId, browserId, instanceId };
  }

  test("patches automatic rotations at the lead boundary while retaining the hard-deadline fallback", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("0397 deadline rotation preemption");
    expect(source).toContain("lease.rotation_reason = ''provider_deadline''");
    expect(source).toContain("OR lease.provider_deadline_at <= pg_catalog.now()");
    expect(source).toContain("Interaction controller yielded for sandbox provider rotation");
  });

  test("automatic deadline rotation releases persistent interaction holders before provider destruction", async () => {
    if (!owned || !client) return;
    const automatic = await seedActiveBrowser("provider_deadline");
    const operator = await seedActiveBrowser("operator");

    const drainable = await reapStaleLeaseHoldersGlobal(client.db, {
      viewerHolderTtlMs: 90_000,
      turnHolderTtlMs: 90_000,
      interactionHolderTtlMs: 90_000,
      idleGraceMs: 0,
    });
    expect(drainable).toContainEqual({
      workspaceId: automatic.workspaceId,
      sandboxGroupId: automatic.sandboxGroupId,
      instanceId: automatic.instanceId,
      leaseEpoch: 1,
    });
    expect(drainable).not.toContainEqual({
      workspaceId: operator.workspaceId,
      sandboxGroupId: operator.sandboxGroupId,
      instanceId: operator.instanceId,
      leaseEpoch: 1,
    });

    const resources = await owned.admin<
      Array<{ kind: string; lifecycle: string; failureCode: string | null; holders: number }>
    >`
      select 'automatic' as kind, browser.lifecycle,
        browser.failure_code as "failureCode",
        (select count(*)::int from sandbox_lease_holders holder
          where holder.lease_id = ${automatic.leaseId}) as holders
      from browser_sessions browser where browser.id = ${automatic.browserId}
      union all
      select 'operator', browser.lifecycle, browser.failure_code,
        (select count(*)::int from sandbox_lease_holders holder
          where holder.lease_id = ${operator.leaseId})
      from browser_sessions browser where browser.id = ${operator.browserId}
      order by kind`;
    expect([...resources]).toEqual([
      {
        kind: "automatic",
        lifecycle: "lost",
        failureCode: "provider_deadline_rotation",
        holders: 0,
      },
      { kind: "operator", lifecycle: "active", failureCode: null, holders: 1 },
    ]);
  }, 900_000);
});
