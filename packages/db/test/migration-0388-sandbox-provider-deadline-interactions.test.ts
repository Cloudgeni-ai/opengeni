import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import { createDb, readSandboxRotationBacklog, reapStaleLeaseHoldersGlobal } from "../src";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0388_sandbox_provider_deadline_interactions.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("migration 0388 sandbox provider-deadline interactions", () => {
  let owned: OwnerMigratedTestDatabase | null = null;
  let client: ReturnType<typeof createDb> | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase("sandbox-provider-deadline-interactions");
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

  test("patches only the hard-deadline lifecycle and keeps every sweep bounded", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("acquire_sandbox_reaper_session_tenancy_fences");
    expect(source).toContain("open_session_tenancy_fenced_access");
    expect(source.match(/LIMIT 500\n        FOR UPDATE OF (?:lease|holder)/gu)).toHaveLength(2);
    expect(source).toContain("lease.provider_deadline_at <= pg_catalog.now()");
    expect(source).toContain("operation.state = 'dispatched' THEN 'outcome_unknown'");
    expect(source).toContain("ELSE 'controller_lost'");
    expect(source).toContain("failure_code = 'provider_deadline_rotation'");
    expect(source).toContain("sandbox_rotation_interaction_blocked");
    expect(source).not.toMatch(/last_heartbeat_at\s*</u);
  });

  test("keeps active controllers before the deadline, then terminalizes exact holders at it", async () => {
    if (!owned || !client) return;
    const { admin } = owned;
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const sandboxGroupId = crypto.randomUUID();
    const leaseId = crypto.randomUUID();
    const activeBrowserId = crypto.randomUUID();
    const activeBrowserCreateOperationId = crypto.randomUUID();
    const dispatchedBrowserId = crypto.randomUUID();
    const dispatchedBrowserCreateOperationId = crypto.randomUUID();
    const dispatchedBrowserOperationId = crypto.randomUUID();
    const preparedComputerId = crypto.randomUUID();
    const preparedComputerCreateOperationId = crypto.randomUUID();
    const preparedComputerOperationId = crypto.randomUUID();
    const controllerGeneration = crypto.randomUUID();

    await admin.begin(async (tx) => {
      await tx`
        insert into managed_accounts (id, name)
        values (${accountId}, 'deadline-interaction-account')`;
      await tx`
        insert into workspaces (id, account_id, name)
        values (${workspaceId}, ${accountId}, 'deadline-interaction-workspace')`;
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
          'deadline-interaction-instance', 'modal', 1, now() + interval '1 hour', 3,
          now() - interval '23 hours', now() + interval '1 hour',
          now(), 'operator'
        )`;

      await tx`
        insert into interaction_operations (
          operation_id, account_id, workspace_id, resource_kind, resource_id,
          kind, request_digest, state, controller_generation, actor_subject_id,
          dispatched_at, settled_at
        ) values
          (
            ${activeBrowserCreateOperationId}, ${accountId}, ${workspaceId},
            'browser_session', ${activeBrowserId}, 'create', ${"a".repeat(64)},
            'completed', ${controllerGeneration}, 'deadline-test', now(), now()
          ),
          (
            ${dispatchedBrowserCreateOperationId}, ${accountId}, ${workspaceId},
            'browser_session', ${dispatchedBrowserId}, 'create', ${"b".repeat(64)},
            'completed', ${controllerGeneration}, 'deadline-test', now(), now()
          ),
          (
            ${preparedComputerCreateOperationId}, ${accountId}, ${workspaceId},
            'computer_session', ${preparedComputerId}, 'create', ${"c".repeat(64)},
            'completed', ${controllerGeneration}, 'deadline-test', now(), now()
          )`;

      await tx`
        insert into browser_sessions (
          id, account_id, workspace_id, name, lifecycle, placement_kind,
          sandbox_group_id, controller_host_sandbox_group_id, controller_id,
          controller_generation, placement_instance_id, driver_id, engine,
          headless, capabilities, create_operation_id, created_by_subject_id,
          controller_heartbeat_at
        ) values
          (
            ${activeBrowserId}, ${accountId}, ${workspaceId}, 'Active browser',
            'active', 'sandbox_group', ${sandboxGroupId}, ${sandboxGroupId},
            'browserd:deadline-test', ${controllerGeneration},
            'deadline-interaction-instance', 'opengeni.cdp.v1', 'chromium', true,
            '{}'::jsonb, ${activeBrowserCreateOperationId}, 'deadline-test',
            now() - interval '2 days'
          ),
          (
            ${dispatchedBrowserId}, ${accountId}, ${workspaceId}, 'Suspending browser',
            'suspending', 'sandbox_group', ${sandboxGroupId}, ${sandboxGroupId},
            'browserd:deadline-test', ${controllerGeneration},
            'deadline-interaction-instance', 'opengeni.cdp.v1', 'chromium', true,
            '{}'::jsonb, ${dispatchedBrowserCreateOperationId}, 'deadline-test',
            now() - interval '2 days'
          )`;

      await tx`
        insert into computer_sessions (
          id, account_id, workspace_id, name, lifecycle, placement_kind,
          sandbox_group_id, controller_id, controller_generation,
          placement_instance_id, platform, adapter, seat_id, display_id,
          capabilities, create_operation_id, created_by_subject_id,
          controller_heartbeat_at
        ) values (
          ${preparedComputerId}, ${accountId}, ${workspaceId}, 'Ending computer',
          'ending', 'sandbox_group', ${sandboxGroupId}, 'browserd:deadline-test',
          ${controllerGeneration}, 'deadline-interaction-instance', 'linux',
          'native', 'seat-1', 'display-1', '{}'::jsonb,
          ${preparedComputerCreateOperationId}, 'deadline-test', now() - interval '2 days'
        )`;

      await tx`
        insert into interaction_operations (
          operation_id, account_id, workspace_id, resource_kind, resource_id,
          kind, request_digest, state, controller_generation, actor_subject_id,
          dispatched_at, updated_at
        ) values (
          ${dispatchedBrowserOperationId}, ${accountId}, ${workspaceId},
          'browser_session', ${dispatchedBrowserId}, 'suspend', ${"d".repeat(64)},
          'dispatched', ${controllerGeneration}, 'deadline-test', now(), now()
        )`;
      await tx`
        insert into interaction_operations (
          operation_id, account_id, workspace_id, resource_kind, resource_id,
          kind, request_digest, state, actor_subject_id, updated_at
        ) values (
          ${preparedComputerOperationId}, ${accountId}, ${workspaceId},
          'computer_session', ${preparedComputerId}, 'end', ${"e".repeat(64)},
          'prepared', 'deadline-test', now()
        )`;

      for (const holderId of [
        `browser-session:${activeBrowserId}`,
        `browser-session:${dispatchedBrowserId}`,
        `computer-session:${preparedComputerId}`,
      ]) {
        await tx`
          insert into sandbox_lease_holders (
            account_id, workspace_id, lease_id, kind, holder_id, last_heartbeat_at
          ) values (
            ${accountId}, ${workspaceId}, ${leaseId}, 'interaction', ${holderId},
            now() - interval '2 days'
          )`;
      }
    });

    expect(await readSandboxRotationBacklog(client.db)).toMatchObject({
      requested: 1,
      overdue: 0,
      interactionBlocked: 1,
    });
    expect(
      await reapStaleLeaseHoldersGlobal(client.db, {
        viewerHolderTtlMs: 90_000,
        turnHolderTtlMs: 90_000,
        interactionHolderTtlMs: 90_000,
        idleGraceMs: 0,
      }),
    ).toEqual([]);

    const beforeDeadline = await admin<
      Array<{ kind: string; lifecycle: string; failureCode: string | null }>
    >`
      select 'browser-active' as kind, lifecycle, failure_code as "failureCode"
      from browser_sessions where id = ${activeBrowserId}
      union all
      select 'browser-dispatched', lifecycle, failure_code
      from browser_sessions where id = ${dispatchedBrowserId}
      union all
      select 'computer-prepared', lifecycle, failure_code
      from computer_sessions where id = ${preparedComputerId}
      order by kind`;
    expect([...beforeDeadline]).toEqual([
      { kind: "browser-active", lifecycle: "active", failureCode: null },
      { kind: "browser-dispatched", lifecycle: "suspending", failureCode: null },
      { kind: "computer-prepared", lifecycle: "ending", failureCode: null },
    ]);

    await admin`
      update sandbox_leases
      set provider_deadline_at = now() - interval '1 second'
      where id = ${leaseId}`;

    expect(
      await reapStaleLeaseHoldersGlobal(client.db, {
        viewerHolderTtlMs: 90_000,
        turnHolderTtlMs: 90_000,
        interactionHolderTtlMs: 90_000,
        idleGraceMs: 0,
      }),
    ).toEqual([
      {
        workspaceId,
        sandboxGroupId,
        instanceId: "deadline-interaction-instance",
        leaseEpoch: 1,
      },
    ]);

    const resources = await admin<
      Array<{
        kind: string;
        lifecycle: string;
        failureCode: string;
        controllerGeneration: string;
        placementInstanceId: string;
      }>
    >`
      select 'browser-active' as kind, lifecycle, failure_code as "failureCode",
        controller_generation as "controllerGeneration",
        placement_instance_id as "placementInstanceId"
      from browser_sessions where id = ${activeBrowserId}
      union all
      select 'browser-dispatched', lifecycle, failure_code,
        controller_generation, placement_instance_id
      from browser_sessions where id = ${dispatchedBrowserId}
      union all
      select 'computer-prepared', lifecycle, failure_code,
        controller_generation, placement_instance_id
      from computer_sessions where id = ${preparedComputerId}
      order by kind`;
    expect([...resources]).toEqual([
      {
        kind: "browser-active",
        lifecycle: "lost",
        failureCode: "provider_deadline_rotation",
        controllerGeneration,
        placementInstanceId: "deadline-interaction-instance",
      },
      {
        kind: "browser-dispatched",
        lifecycle: "lost",
        failureCode: "provider_deadline_rotation",
        controllerGeneration,
        placementInstanceId: "deadline-interaction-instance",
      },
      {
        kind: "computer-prepared",
        lifecycle: "lost",
        failureCode: "provider_deadline_rotation",
        controllerGeneration,
        placementInstanceId: "deadline-interaction-instance",
      },
    ]);

    const operations = await admin<
      Array<{
        operationId: string;
        state: string;
        errorCode: string | null;
        errorReason: string | null;
      }>
    >`
      select operation_id as "operationId", state, error_code as "errorCode",
        error_details ->> 'reason' as "errorReason"
      from interaction_operations
      where operation_id in (${dispatchedBrowserOperationId}, ${preparedComputerOperationId})
      order by operation_id`;
    expect(
      Object.fromEntries(operations.map((operation) => [operation.operationId, operation])),
    ).toEqual({
      [dispatchedBrowserOperationId]: {
        operationId: dispatchedBrowserOperationId,
        state: "outcome_unknown",
        errorCode: "outcome_unknown",
        errorReason: "provider_deadline_rotation",
      },
      [preparedComputerOperationId]: {
        operationId: preparedComputerOperationId,
        state: "failed",
        errorCode: "controller_lost",
        errorReason: "provider_deadline_rotation",
      },
    });

    const [lease] = await admin<
      Array<{ liveness: string; refcount: number; holders: number; revision: string }>
    >`
      select lease.liveness, lease.refcount,
        (select count(*)::int from sandbox_lease_holders holder
          where holder.lease_id = lease.id) as holders,
        revision.revision::text as revision
      from sandbox_leases lease
      join workspace_interaction_revisions revision
        on revision.workspace_id = lease.workspace_id
      where lease.id = ${leaseId}`;
    expect(lease).toEqual({ liveness: "draining", refcount: 0, holders: 0, revision: "1" });
    expect(await readSandboxRotationBacklog(client.db)).toMatchObject({
      requested: 1,
      overdue: 1,
      interactionBlocked: 0,
    });
  }, 900_000);
});
