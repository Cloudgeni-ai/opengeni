import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { createDb, readSandboxRotationBacklog, reapStaleLeaseHoldersGlobal } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationUrl = new URL(
  "../drizzle/0391_sandbox_provider_deadline_interaction_followup.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
setDefaultTimeout(900_000);

type WorkspaceFixture = {
  accountId: string;
  workspaceId: string;
};

describe("migration 0391 provider-deadline interaction follow-up", () => {
  let owned: OwnerMigratedTestDatabase | null = null;
  let client: ReturnType<typeof createDb> | null = null;

  beforeAll(async () => {
    owned = await acquireOwnerMigratedTestDatabase(
      "sandbox-provider-deadline-interaction-followup",
    );
    if (!owned) {
      if (requireRealDatabase) throw new Error("real database required but unavailable");
      return;
    }
    await migrate(owned.ownerUrl);
    await provisionRoles(owned.adminUrl, {
      appPassword: owned.appPassword,
      rlsStrategy: "force",
    });
    const appUrl = new URL(owned.ownerUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = owned.appPassword;
    client = createDb(appUrl.toString(), { max: 4, rlsStrategy: "force" });
  }, 900_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await owned?.release();
  }, 180_000);

  async function seedWorkspace(label: string): Promise<WorkspaceFixture> {
    if (!owned) throw new Error("owner-migrated database unavailable");
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    await owned.admin.begin(async (tx) => {
      await tx`
        insert into managed_accounts (id, name)
        values (${accountId}, ${`${label}-account`})`;
      await tx`
        insert into workspaces (id, account_id, name)
        values (${workspaceId}, ${accountId}, ${`${label}-workspace`})`;
      await tx`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${accountId})`;
      await tx`
        insert into workspace_interaction_revisions (workspace_id, account_id)
        values (${workspaceId}, ${accountId})`;
    });
    return { accountId, workspaceId };
  }

  async function seedActiveModalBrowser(input: {
    fixture: WorkspaceFixture;
    label: string;
    liveness: "warm" | "draining";
    providerDeadlineAt: Date;
    leaseUpdatedAt?: Date;
  }) {
    if (!owned) throw new Error("owner-migrated database unavailable");
    const leaseId = crypto.randomUUID();
    const sandboxGroupId = crypto.randomUUID();
    const browserId = crypto.randomUUID();
    const createOperationId = crypto.randomUUID();
    const controllerGeneration = crypto.randomUUID();
    const instanceId = `${input.label}-instance`;
    await owned.admin.begin(async (tx) => {
      await tx`
        insert into sandbox_leases (
          id, account_id, workspace_id, sandbox_group_id, liveness,
          instance_id, backend, lease_epoch, expires_at, refcount,
          provider_created_at, provider_deadline_at,
          rotation_requested_at, rotation_reason, updated_at
        ) values (
          ${leaseId}, ${input.fixture.accountId}, ${input.fixture.workspaceId},
          ${sandboxGroupId}, ${input.liveness}, ${instanceId}, 'modal', 1,
          now() + interval '1 hour', 1, now() - interval '23 hours',
          ${input.providerDeadlineAt}, now() - interval '2 hours', 'operator',
          ${input.leaseUpdatedAt ?? new Date()}
        )`;
      await tx`
        insert into interaction_operations (
          operation_id, account_id, workspace_id, resource_kind, resource_id,
          kind, request_digest, state, controller_generation, actor_subject_id,
          dispatched_at, settled_at
        ) values (
          ${createOperationId}, ${input.fixture.accountId}, ${input.fixture.workspaceId},
          'browser_session', ${browserId}, 'create', ${"a".repeat(64)},
          'completed', ${controllerGeneration}, 'deadline-followup-test', now(), now()
        )`;
      await tx`
        insert into browser_sessions (
          id, account_id, workspace_id, name, lifecycle, placement_kind,
          sandbox_group_id, controller_host_sandbox_group_id, controller_id,
          controller_generation, placement_instance_id, driver_id, engine,
          headless, capabilities, create_operation_id, created_by_subject_id,
          controller_heartbeat_at
        ) values (
          ${browserId}, ${input.fixture.accountId}, ${input.fixture.workspaceId},
          ${input.label}, 'active', 'sandbox_group', ${sandboxGroupId},
          ${sandboxGroupId}, 'browserd:deadline-followup', ${controllerGeneration},
          ${instanceId}, 'opengeni.cdp.v1', 'chromium', true, '{}'::jsonb,
          ${createOperationId}, 'deadline-followup-test', now()
        )`;
      await tx`
        insert into sandbox_lease_holders (
          account_id, workspace_id, lease_id, kind, holder_id, last_heartbeat_at
        ) values (
          ${input.fixture.accountId}, ${input.fixture.workspaceId}, ${leaseId},
          'interaction', ${`browser-session:${browserId}`}, now()
        )`;
    });
    return { leaseId, sandboxGroupId, browserId, instanceId };
  }

  test("adds only due lease-free interaction workspaces to the canonical fence inventory", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("CREATE POLICY session_tenancy_fence_inventory_read");
    expect(source).toContain(
      "acquire_sandbox_reaper_session_tenancy_fences(\n  p_interaction_holder_ttl_ms bigint",
    );
    expect(source).toContain("operation.state = 'dispatched'");
    expect(source).toContain("p_interaction_holder_ttl_ms / 1000.0");
    expect(source).toContain("ORDER BY candidate.workspace_id");
    expect(source).toContain("lease.liveness IN (''warming'', ''warm'', ''draining'')");
    expect(source).toContain("interaction_holder.kind = ''interaction''");
    expect(source).toContain("Lease-free prepared operations remain replayable");
    expect(source).toContain(
      "ALTER FUNCTION %I.acquire_sandbox_reaper_session_tenancy_fences(bigint) ",
    );
    expect(source).toContain("SET search_path = pg_catalog, %I, pg_temp");
    expect(source).not.toMatch(/last_heartbeat_at\s*</u);

    const policyBlock = source.slice(
      source.indexOf("DO $interaction_reaper_inventory_policies$"),
      source.indexOf("$interaction_reaper_inventory_policies$;") +
        "$interaction_reaper_inventory_policies$;".length,
    );
    expect(policyBlock).toContain("current_user::text, %L::text, %s::oid, workspace_id, true");
    for (const table of ["browser_sessions", "computer_sessions", "interaction_operations"]) {
      expect(policyBlock).toContain(`'${table}'`);
    }
    expect(policyBlock).not.toContain("workspace_interaction_revisions");
  });

  test("pins the inventory helper search path before caller temp schemas", async () => {
    if (!owned) return;
    const owner = postgres(owned.ownerUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    try {
      await owner.begin(async (tx) => {
        await tx.unsafe("create temporary table sandbox_leases (workspace_id uuid, liveness text)");
        await tx.unsafe("create temporary table sandbox_lease_holders (lease_id uuid)");
        const [result] = await tx<Array<{ locked: number }>>`
          select acquire_sandbox_reaper_session_tenancy_fences(${90_000}) as locked`;
        expect(result?.locked).toEqual(expect.any(Number));
      });
    } finally {
      await owner.end({ timeout: 5 });
    }
  });

  test("reaps lease-free Connected Machine and attached-device transitions under FORCE RLS", async () => {
    if (!owned || !client) return;
    const browser = await seedWorkspace("lease-free-browser");
    const computer = await seedWorkspace("lease-free-computer");
    const browserId = crypto.randomUUID();
    const browserOperationId = crypto.randomUUID();
    const browserGeneration = crypto.randomUUID();
    const computerId = crypto.randomUUID();
    const computerOperationId = crypto.randomUUID();
    const computerGeneration = crypto.randomUUID();

    await owned.admin.begin(async (tx) => {
      await tx`
        insert into interaction_operations (
          operation_id, account_id, workspace_id, resource_kind, resource_id,
          kind, request_digest, state, controller_generation, actor_subject_id,
          dispatched_at, updated_at
        ) values (
          ${browserOperationId}, ${browser.accountId}, ${browser.workspaceId},
          'browser_session', ${browserId}, 'create', ${"b".repeat(64)},
          'dispatched', ${browserGeneration}, 'lease-free-test',
          now() - interval '2 days', now() - interval '2 days'
        )`;
      await tx`
        insert into browser_sessions (
          id, account_id, workspace_id, name, lifecycle, placement_kind,
          connected_sandbox_id, controller_id, controller_generation,
          placement_instance_id, driver_id, engine, headless, capabilities,
          create_operation_id, created_by_subject_id, controller_heartbeat_at
        ) values (
          ${browserId}, ${browser.accountId}, ${browser.workspaceId},
          'Lease-free Connected Machine browser', 'starting', 'connected_machine',
          ${crypto.randomUUID()}, 'browserd:connected-machine', ${browserGeneration},
          'connected-machine-generation', 'opengeni.cdp.v1', 'chromium', true,
          '{}'::jsonb, ${browserOperationId}, 'lease-free-test',
          now() - interval '2 days'
        )`;

      await tx`
        insert into interaction_operations (
          operation_id, account_id, workspace_id, resource_kind, resource_id,
          kind, request_digest, state, controller_generation, actor_subject_id,
          dispatched_at, updated_at
        ) values (
          ${computerOperationId}, ${computer.accountId}, ${computer.workspaceId},
          'computer_session', ${computerId}, 'create', ${"c".repeat(64)},
          'dispatched', ${computerGeneration}, 'lease-free-test',
          now() - interval '2 days', now() - interval '2 days'
        )`;
      await tx`
        insert into computer_sessions (
          id, account_id, workspace_id, name, lifecycle, placement_kind,
          device_id, controller_id, controller_generation, placement_instance_id,
          create_operation_id, created_by_subject_id, controller_heartbeat_at
        ) values (
          ${computerId}, ${computer.accountId}, ${computer.workspaceId},
          'Lease-free attached device computer', 'starting', 'attached_device',
          ${crypto.randomUUID()}, 'browserd:attached-device', ${computerGeneration},
          'attached-device-generation', ${computerOperationId}, 'lease-free-test',
          now() - interval '2 days'
        )`;
    });

    expect(
      await reapStaleLeaseHoldersGlobal(client.db, {
        viewerHolderTtlMs: 90_000,
        turnHolderTtlMs: 90_000,
        interactionHolderTtlMs: 90_000,
        idleGraceMs: 0,
      }),
    ).toEqual([]);

    const resources = await owned.admin<
      Array<{ kind: string; lifecycle: string; failureCode: string | null; revision: string }>
    >`
      select 'browser' as kind, browser.lifecycle,
        browser.failure_code as "failureCode", revision.revision::text as revision
      from browser_sessions browser
      join workspace_interaction_revisions revision
        on revision.workspace_id = browser.workspace_id
      where browser.id = ${browserId}
      union all
      select 'computer', computer.lifecycle, computer.failure_code,
        revision.revision::text
      from computer_sessions computer
      join workspace_interaction_revisions revision
        on revision.workspace_id = computer.workspace_id
      where computer.id = ${computerId}
      order by kind`;
    expect([...resources]).toEqual([
      {
        kind: "browser",
        lifecycle: "lost",
        failureCode: "controller_transition_expired",
        revision: "1",
      },
      {
        kind: "computer",
        lifecycle: "lost",
        failureCode: "controller_transition_expired",
        revision: "1",
      },
    ]);

    const operations = await owned.admin<
      Array<{ operationId: string; state: string; errorCode: string | null }>
    >`
      select operation_id as "operationId", state, error_code as "errorCode"
      from interaction_operations
      where operation_id in (${browserOperationId}, ${computerOperationId})
      order by operation_id`;
    expect(
      Object.fromEntries(operations.map((operation) => [operation.operationId, operation])),
    ).toEqual({
      [browserOperationId]: {
        operationId: browserOperationId,
        state: "outcome_unknown",
        errorCode: "outcome_unknown",
      },
      [computerOperationId]: {
        operationId: computerOperationId,
        state: "outcome_unknown",
        errorCode: "outcome_unknown",
      },
    });
  });

  test("does not starve an interaction deadline behind 501 unrelated overdue leases", async () => {
    if (!owned || !client) return;
    const fixture = await seedWorkspace("deadline-batch-fairness");
    await owned.admin.begin(async (tx) => {
      await tx`
        with blocker_leases as (
          insert into sandbox_leases (
            id, account_id, workspace_id, sandbox_group_id, liveness,
            instance_id, backend, lease_epoch, expires_at, refcount,
            provider_created_at, provider_deadline_at,
            rotation_requested_at, rotation_reason, updated_at
          )
          select gen_random_uuid(), ${fixture.accountId}, ${fixture.workspaceId},
            gen_random_uuid(), 'warm', 'deadline-blocker-' || series::text,
            'modal', 1, now() + interval '1 hour', 1,
            now() - interval '23 hours', now() - interval '2 hours',
            now() - interval '3 hours', 'operator', now()
          from generate_series(1, 501) series
          returning id, account_id, workspace_id
        )
        insert into sandbox_lease_holders (
          account_id, workspace_id, lease_id, kind, holder_id, last_heartbeat_at
        )
        select account_id, workspace_id, id, 'direct', 'direct:' || id::text, now()
        from blocker_leases`;
    });
    const target = await seedActiveModalBrowser({
      fixture,
      label: "deadline-fairness-target",
      liveness: "warm",
      providerDeadlineAt: new Date(Date.now() - 60 * 60 * 1000),
      leaseUpdatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });

    expect(await readSandboxRotationBacklog(client.db)).toMatchObject({
      requested: 502,
      overdue: 502,
      directBlocked: 501,
      interactionBlocked: 1,
    });
    expect(
      await reapStaleLeaseHoldersGlobal(client.db, {
        viewerHolderTtlMs: 90_000,
        turnHolderTtlMs: 90_000,
        interactionHolderTtlMs: 90_000,
        idleGraceMs: 0,
      }),
    ).toContainEqual({
      workspaceId: fixture.workspaceId,
      sandboxGroupId: target.sandboxGroupId,
      instanceId: target.instanceId,
      leaseEpoch: 1,
    });

    const [resource] = await owned.admin<
      Array<{ lifecycle: string; failureCode: string | null; holders: number }>
    >`
      select browser.lifecycle, browser.failure_code as "failureCode",
        (select count(*)::int from sandbox_lease_holders holder
          where holder.lease_id = ${target.leaseId}) as holders
      from browser_sessions browser
      where browser.id = ${target.browserId}`;
    expect(resource).toEqual({
      lifecycle: "lost",
      failureCode: "provider_deadline_rotation",
      holders: 0,
    });
    expect(await readSandboxRotationBacklog(client.db)).toMatchObject({
      directBlocked: 501,
      interactionBlocked: 0,
    });
  });

  test("cleans an interaction lease that entered draining before its deadline", async () => {
    if (!owned || !client) return;
    const fixture = await seedWorkspace("deadline-draining");
    const target = await seedActiveModalBrowser({
      fixture,
      label: "deadline-draining-target",
      liveness: "warm",
      providerDeadlineAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const targetDrainable = {
      workspaceId: fixture.workspaceId,
      sandboxGroupId: target.sandboxGroupId,
      instanceId: target.instanceId,
      leaseEpoch: 1,
    };

    expect(
      await reapStaleLeaseHoldersGlobal(client.db, {
        viewerHolderTtlMs: 90_000,
        turnHolderTtlMs: 90_000,
        interactionHolderTtlMs: 90_000,
        idleGraceMs: 0,
      }),
    ).not.toContainEqual(targetDrainable);
    await owned.admin`
      update sandbox_leases
      set liveness = 'draining', expires_at = now() + interval '1 hour'
      where id = ${target.leaseId}`;
    expect(await readSandboxRotationBacklog(client.db)).toMatchObject({ interactionBlocked: 1 });
    expect(
      await reapStaleLeaseHoldersGlobal(client.db, {
        viewerHolderTtlMs: 90_000,
        turnHolderTtlMs: 90_000,
        interactionHolderTtlMs: 90_000,
        idleGraceMs: 0,
      }),
    ).not.toContainEqual(targetDrainable);

    await owned.admin`
      update sandbox_leases
      set provider_deadline_at = now() - interval '1 second'
      where id = ${target.leaseId}`;
    await reapStaleLeaseHoldersGlobal(client.db, {
      viewerHolderTtlMs: 90_000,
      turnHolderTtlMs: 90_000,
      interactionHolderTtlMs: 90_000,
      idleGraceMs: 0,
    });

    const [state] = await owned.admin<
      Array<{ lifecycle: string; failureCode: string | null; liveness: string; holders: number }>
    >`
      select browser.lifecycle, browser.failure_code as "failureCode", lease.liveness,
        (select count(*)::int from sandbox_lease_holders holder
          where holder.lease_id = lease.id) as holders
      from browser_sessions browser
      join sandbox_leases lease on lease.id = ${target.leaseId}
      where browser.id = ${target.browserId}`;
    expect(state).toEqual({
      lifecycle: "lost",
      failureCode: "provider_deadline_rotation",
      liveness: "draining",
      holders: 0,
    });
    expect(await readSandboxRotationBacklog(client.db)).toMatchObject({ interactionBlocked: 0 });
  });

  test("replays safely and preserves owner-role, FORCE-RLS, and runtime grants", async () => {
    if (!owned) return;
    const source = await readFile(migrationUrl, "utf8");
    const owner = postgres(owned.ownerUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    try {
      await owner.begin(async (tx) => {
        await tx.unsafe(source);
      });
    } finally {
      await owner.end({ timeout: 5 });
    }

    const [contract] = await owned.admin<
      Array<{
        reaperOwner: string;
        reaperSecurityDefiner: boolean;
        appCanReap: boolean;
        appCanAcquire: boolean;
        helperOwner: string;
        helperSecurityDefiner: boolean;
        helperConfig: string[] | null;
        forcedTables: number;
        inventoryPolicies: number;
        markerCount: number;
      }>
    >`
      select
        pg_get_userbyid(reaper.proowner) as "reaperOwner",
        reaper.prosecdef as "reaperSecurityDefiner",
        has_function_privilege(
          'opengeni_app',
          'opengeni_private.reap_stale_interaction_transitions(bigint)',
          'EXECUTE'
        ) as "appCanReap",
        has_function_privilege(
          'opengeni_app',
          'acquire_sandbox_reaper_session_tenancy_fences(bigint)',
          'EXECUTE'
        ) as "appCanAcquire",
        pg_get_userbyid(helper.proowner) as "helperOwner",
        helper.prosecdef as "helperSecurityDefiner",
        helper.proconfig as "helperConfig",
        (
          select count(*)::int
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
          where namespace.nspname = current_schema()
            and relation.relname in (
              'browser_sessions', 'computer_sessions', 'interaction_operations',
              'workspace_interaction_revisions'
            )
            and relation.relrowsecurity
            and relation.relforcerowsecurity
        ) as "forcedTables",
        (
          select count(*)::int
          from pg_policies policy
          where policy.schemaname = current_schema()
            and policy.tablename in (
              'browser_sessions', 'computer_sessions', 'interaction_operations'
            )
            and policy.policyname = 'session_tenancy_fence_inventory_read'
            and policy.cmd = 'SELECT'
        ) as "inventoryPolicies",
        (
          select count(*)::int
          from regexp_matches(
            pg_get_functiondef(reaper.oid),
            '0391 provider-deadline interaction follow-up',
            'g'
          )
        ) as "markerCount"
      from pg_proc reaper
      join pg_namespace reaper_namespace on reaper_namespace.oid = reaper.pronamespace
      cross join pg_proc helper
      join pg_namespace helper_namespace on helper_namespace.oid = helper.pronamespace
      where reaper_namespace.nspname = 'opengeni_private'
        and reaper.proname = 'reap_stale_interaction_transitions'
        and pg_get_function_identity_arguments(reaper.oid) = 'p_interaction_holder_ttl_ms bigint'
        and helper_namespace.nspname = current_schema()
        and helper.proname = 'acquire_sandbox_reaper_session_tenancy_fences'
        and pg_get_function_identity_arguments(helper.oid) = 'p_interaction_holder_ttl_ms bigint'`;
    expect(contract).toEqual({
      reaperOwner: owned.ownerRole,
      reaperSecurityDefiner: true,
      appCanReap: true,
      appCanAcquire: false,
      helperOwner: owned.ownerRole,
      helperSecurityDefiner: true,
      helperConfig: ["search_path=pg_catalog, public, pg_temp"],
      forcedTables: 4,
      inventoryPolicies: 3,
      markerCount: 1,
    });
  });
});
