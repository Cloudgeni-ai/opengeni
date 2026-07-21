import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  acquireLease,
  createDb,
  deactivateSandboxEphemeralOwner,
  findLiveModalSandboxInstanceAttribution,
  listLiveModalSandboxInstanceAttributions,
  registerSandboxEphemeralOwner,
  type Database,
  type DbClient,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
let appDatabaseUrl = "";
let ownsAdmin = false;
let sequence = 0;

async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
}> {
  sequence += 1;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name)
    values (${"sandbox-ephemeral-owner-account-" + sequence})
    returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${"sandbox-ephemeral-owner-workspace-" + sequence})
    returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("sandbox-ephemeral-owners");
  if (!shared) {
    const directAdminUrl = process.env.OPENGENI_TEST_ADMIN_DATABASE_URL;
    const directAppUrl = process.env.OPENGENI_TEST_APP_DATABASE_URL;
    if (directAdminUrl && directAppUrl) {
      admin = postgres(directAdminUrl, { max: 4 });
      appDatabaseUrl = directAppUrl;
      ownsAdmin = true;
    } else if (requireRealDatabase) {
      throw new Error(
        "[sandbox-ephemeral-owners] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    } else {
      available = false;
      // eslint-disable-next-line no-console
      console.warn("[sandbox-ephemeral-owners] real PostgreSQL unavailable, skipping");
      return;
    }
  } else {
    admin = shared.admin;
    appDatabaseUrl = shared.appUrl;
  }
  client = createDb(appDatabaseUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  if (shared) {
    await shared.release();
  } else if (ownsAdmin) {
    await admin?.end().catch(() => undefined);
  }
}, 180_000);

describe("sandbox ephemeral ownership (real PostgreSQL + FORCE RLS)", () => {
  test("migration installs FORCE RLS, least-privilege grants, and a pinned definer path", async () => {
    if (!available) return;
    const [table] = await admin<
      {
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        granted_privileges: string[];
        denied_privileges: string[];
      }[]
    >`
      select C.relrowsecurity,
             C.relforcerowsecurity,
             array_remove(array[
               case when has_table_privilege('opengeni_app', C.oid, 'SELECT') then 'SELECT' end,
               case when has_table_privilege('opengeni_app', C.oid, 'INSERT') then 'INSERT' end,
               case when has_table_privilege('opengeni_app', C.oid, 'UPDATE') then 'UPDATE' end,
               case when has_table_privilege('opengeni_app', C.oid, 'DELETE') then 'DELETE' end,
               case when has_table_privilege('opengeni_app', C.oid, 'TRUNCATE') then 'TRUNCATE' end,
               case when has_table_privilege('opengeni_app', C.oid, 'REFERENCES') then 'REFERENCES' end,
               case when has_table_privilege('opengeni_app', C.oid, 'TRIGGER') then 'TRIGGER' end
             ], null) as granted_privileges,
             array_remove(array[
               case when not has_table_privilege('opengeni_app', C.oid, 'INSERT') then 'INSERT' end,
               case when not has_table_privilege('opengeni_app', C.oid, 'UPDATE') then 'UPDATE' end,
               case when not has_table_privilege('opengeni_app', C.oid, 'DELETE') then 'DELETE' end,
               case when not has_table_privilege('opengeni_app', C.oid, 'TRUNCATE') then 'TRUNCATE' end,
               case when not has_table_privilege('opengeni_app', C.oid, 'REFERENCES') then 'REFERENCES' end,
               case when not has_table_privilege('opengeni_app', C.oid, 'TRIGGER') then 'TRIGGER' end
             ], null) as denied_privileges
      from pg_class C
      join pg_namespace N on N.oid = C.relnamespace
      where C.relname = 'sandbox_ephemeral_owners'
        and N.nspname = current_schema()`;
    expect(table).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
      granted_privileges: ["SELECT"],
      denied_privileges: ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
    });

    const functions = await admin<
      {
        proname: string;
        prosecdef: boolean;
        proconfig: string[] | null;
        executable: boolean;
      }[]
    >`
      select P.proname,
             P.prosecdef,
             P.proconfig,
             has_function_privilege(
               'opengeni_app',
               P.oid,
               'EXECUTE'
             ) as executable
      from pg_proc P
      join pg_namespace N on N.oid = P.pronamespace
      where N.nspname = 'opengeni_private'
        and P.proname in (
          'register_sandbox_ephemeral_owner',
          'deactivate_sandbox_ephemeral_owner',
          'list_live_modal_sandbox_instances'
        )
      order by P.proname`;
    expect(functions.map((fn) => fn.proname)).toEqual([
      "deactivate_sandbox_ephemeral_owner",
      "list_live_modal_sandbox_instances",
      "register_sandbox_ephemeral_owner",
    ]);
    for (const fn of functions) {
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toContain("search_path=pg_catalog");
      expect(fn.executable).toBe(true);
    }

    const [tenantConstraint] = await admin<{ definition: string }[]>`
      select pg_get_constraintdef(C.oid) as definition
      from pg_constraint C
      join pg_class T on T.oid = C.conrelid
      join pg_namespace N on N.oid = T.relnamespace
      where C.conname = 'sandbox_ephemeral_owners_workspace_account_fk'
        and T.relname = 'sandbox_ephemeral_owners'
        and N.nspname = current_schema()`;
    expect(tenantConstraint?.definition).toContain(
      "FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE",
    );
  });

  test("the app role can read and use fenced lifecycle APIs but cannot mutate the table directly", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const executionId = crypto.randomUUID();
    const instanceId = `modal-acl-${executionId}`;
    await registerSandboxEphemeralOwner(db, {
      executionId,
      ...workspace,
      kind: "rig_verification",
      backend: "modal",
      instanceId,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    const app = postgres(appDatabaseUrl, { max: 1 });
    const inScope = async <T>(operation: (tx: postgres.TransactionSql) => Promise<T>) =>
      await app.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
        return await operation(tx);
      });
    try {
      const visible = await inScope(async (tx) => {
        const [row] = await tx<{ count: number }[]>`
          select count(*)::int as count
          from sandbox_ephemeral_owners
          where execution_id = ${executionId}`;
        return row!.count;
      });
      expect(visible).toBe(1);

      await expect(
        inScope(async (tx) => {
          await tx`
            insert into sandbox_ephemeral_owners (
              execution_id, account_id, workspace_id, kind, backend, instance_id, expires_at
            ) values (
              ${crypto.randomUUID()}, ${workspace.accountId}, ${workspace.workspaceId},
              'rig_verification', 'modal', ${`modal-direct-insert-${crypto.randomUUID()}`},
              now() + interval '10 minutes'
            )`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        inScope(async (tx) => {
          await tx`
            update sandbox_ephemeral_owners
            set active = false
            where execution_id = ${executionId}`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        inScope(async (tx) => {
          await tx`delete from sandbox_ephemeral_owners where execution_id = ${executionId}`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        inScope(async (tx) => {
          await tx`truncate table sandbox_ephemeral_owners`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
    }

    const [stillActive] = await admin<{ active: boolean }[]>`
      select active from sandbox_ephemeral_owners where execution_id = ${executionId}`;
    expect(stillActive).toEqual({ active: true });
    await expect(
      deactivateSandboxEphemeralOwner(db, {
        executionId,
        ...workspace,
        kind: "rig_verification",
        backend: "modal",
        instanceId,
      }),
    ).resolves.toBe(true);
  });

  test("PostgreSQL rejects an account paired with another tenant's workspace", async () => {
    if (!available) return;
    const first = await freshWorkspace();
    const second = await freshWorkspace();
    const error = await admin`
      insert into sandbox_ephemeral_owners (
        execution_id,
        account_id,
        workspace_id,
        kind,
        backend,
        instance_id,
        expires_at
      ) values (
        ${crypto.randomUUID()},
        ${first.accountId},
        ${second.workspaceId},
        'rig_verification',
        'modal',
        ${`modal-cross-tenant-${crypto.randomUUID()}`},
        ${new Date(Date.now() + 10 * 60_000)}
      )`
      .then(() => null)
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "23503",
      constraint_name: "sandbox_ephemeral_owners_workspace_account_fk",
    });
  });

  test("unified projection includes a live lease and an active exact verifier", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const groupId = crypto.randomUUID();
    const acquired = await acquireLease(db, {
      ...workspace,
      sandboxGroupId: groupId,
      kind: "turn",
      holderId: crypto.randomUUID(),
      backend: "modal",
      leaseTtlMs: 60_000,
    });
    const executionId = crypto.randomUUID();
    const instanceId = `modal-verifier-active-${executionId}`;
    const verifier = await registerSandboxEphemeralOwner(db, {
      executionId,
      ...workspace,
      kind: "rig_verification",
      backend: "modal",
      instanceId,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    expect(verifier.active).toBe(true);

    const attributions = await listLiveModalSandboxInstanceAttributions(db);
    expect(attributions).toContainEqual({
      ownerKind: "lease",
      ownerId: acquired.lease.id,
      workspaceId: workspace.workspaceId,
      instanceId: null,
      sandboxGroupId: groupId,
      liveness: "warming",
      expiresAt: null,
    });
    expect(attributions).toContainEqual({
      ownerKind: "rig_verification",
      ownerId: executionId,
      workspaceId: workspace.workspaceId,
      instanceId,
      sandboxGroupId: null,
      liveness: null,
      expiresAt: verifier.expiresAt,
    });
    await expect(findLiveModalSandboxInstanceAttribution(db, instanceId)).resolves.toEqual({
      ownerKind: "rig_verification",
      ownerId: executionId,
      workspaceId: workspace.workspaceId,
      instanceId,
      sandboxGroupId: null,
      liveness: null,
      expiresAt: verifier.expiresAt,
    });
    await expect(
      findLiveModalSandboxInstanceAttribution(db, `modal-missing-${executionId}`),
    ).resolves.toBeNull();
  });

  test("workspace RLS hides foreign ownership and rejects a colliding foreign execution", async () => {
    if (!available) return;
    const first = await freshWorkspace();
    const second = await freshWorkspace();
    const executionId = crypto.randomUUID();
    const firstInstanceId = `modal-rls-first-${executionId}`;
    await registerSandboxEphemeralOwner(db, {
      executionId,
      ...first,
      kind: "rig_verification",
      backend: "modal",
      instanceId: firstInstanceId,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    const app = postgres(appDatabaseUrl, { max: 1 });
    try {
      const visible = await app.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${second.accountId}, true)`;
        await tx`select set_config('opengeni.workspace_id', ${second.workspaceId}, true)`;
        const [row] = await tx<{ count: number }[]>`
          select count(*)::int as count
          from sandbox_ephemeral_owners
          where execution_id = ${executionId}`;
        return row!.count;
      });
      expect(visible).toBe(0);
    } finally {
      await app.end();
    }

    await expect(
      registerSandboxEphemeralOwner(db, {
        executionId,
        ...second,
        kind: "rig_verification",
        backend: "modal",
        instanceId: `modal-rls-second-${executionId}`,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      }),
    ).rejects.toBeDefined();
    await expect(
      deactivateSandboxEphemeralOwner(db, {
        executionId,
        ...second,
        kind: "rig_verification",
        backend: "modal",
        instanceId: firstInstanceId,
      }),
    ).resolves.toBe(false);
  });

  test("deactivation requires the current exact instance and removes live protection", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const executionId = crypto.randomUUID();
    const currentInstanceId = `modal-exact-current-${executionId}`;
    await registerSandboxEphemeralOwner(db, {
      executionId,
      ...workspace,
      kind: "rig_verification",
      backend: "modal",
      instanceId: currentInstanceId,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });

    await expect(
      deactivateSandboxEphemeralOwner(db, {
        executionId,
        ...workspace,
        kind: "rig_verification",
        backend: "modal",
        instanceId: `modal-wrong-instance-${executionId}`,
      }),
    ).resolves.toBe(false);
    expect(
      (await listLiveModalSandboxInstanceAttributions(db)).some(
        (row) => row.ownerKind === "rig_verification" && row.ownerId === executionId,
      ),
    ).toBe(true);

    await expect(
      deactivateSandboxEphemeralOwner(db, {
        executionId,
        ...workspace,
        kind: "rig_verification",
        backend: "modal",
        instanceId: currentInstanceId,
      }),
    ).resolves.toBe(true);
    expect(
      (await listLiveModalSandboxInstanceAttributions(db)).some(
        (row) => row.ownerKind === "rig_verification" && row.ownerId === executionId,
      ),
    ).toBe(false);
    await expect(
      findLiveModalSandboxInstanceAttribution(db, currentInstanceId),
    ).resolves.toBeNull();
  });

  test("process death is bounded by expiry without explicit deactivation", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const executionId = crypto.randomUUID();
    const instanceId = `modal-expired-process-death-${executionId}`;
    await registerSandboxEphemeralOwner(db, {
      executionId,
      ...workspace,
      kind: "rig_verification",
      backend: "modal",
      instanceId,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const [durable] = await admin<{ active: boolean; deactivated_at: Date | null }[]>`
      select active, deactivated_at
      from sandbox_ephemeral_owners
      where execution_id = ${executionId}`;
    expect(durable).toEqual({ active: true, deactivated_at: null });
    expect(
      (await listLiveModalSandboxInstanceAttributions(db)).some(
        (row) => row.ownerKind === "rig_verification" && row.ownerId === executionId,
      ),
    ).toBe(false);
  });

  test("two active executions cannot claim one exact provider instance", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const instanceId = `modal-unique-active-instance-${crypto.randomUUID()}`;
    await registerSandboxEphemeralOwner(db, {
      executionId: crypto.randomUUID(),
      ...workspace,
      kind: "rig_verification",
      backend: "modal",
      instanceId,
      expiresAt,
    });
    await expect(
      registerSandboxEphemeralOwner(db, {
        executionId: crypto.randomUUID(),
        ...workspace,
        kind: "rig_verification",
        backend: "modal",
        instanceId,
        expiresAt,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
  });

  test("one active execution may rebind, but a deactivated execution never resurrects", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const executionId = crypto.randomUUID();
    const firstInstanceId = `modal-rebind-first-${executionId}`;
    const secondInstanceId = `modal-rebind-second-${executionId}`;
    const thirdInstanceId = `modal-rebind-third-${executionId}`;
    const base = {
      executionId,
      ...workspace,
      kind: "rig_verification" as const,
      backend: "modal",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    };
    await registerSandboxEphemeralOwner(db, {
      ...base,
      instanceId: firstInstanceId,
    });
    const rebound = await registerSandboxEphemeralOwner(db, {
      ...base,
      instanceId: secondInstanceId,
    });
    expect(rebound.instanceId).toBe(secondInstanceId);
    await expect(
      deactivateSandboxEphemeralOwner(db, {
        executionId,
        ...workspace,
        kind: "rig_verification",
        backend: "modal",
        instanceId: firstInstanceId,
      }),
    ).resolves.toBe(false);
    await expect(
      deactivateSandboxEphemeralOwner(db, {
        executionId,
        ...workspace,
        kind: "rig_verification",
        backend: "modal",
        instanceId: secondInstanceId,
      }),
    ).resolves.toBe(true);
    await expect(
      registerSandboxEphemeralOwner(db, {
        ...base,
        instanceId: thirdInstanceId,
      }),
    ).rejects.toThrow("inactive or belongs to a different identity");

    const [row] = await admin<{ active: boolean; instance_id: string }[]>`
      select active, instance_id
      from sandbox_ephemeral_owners
      where execution_id = ${executionId}`;
    expect(row).toEqual({ active: false, instance_id: secondInstanceId });
  });
});
