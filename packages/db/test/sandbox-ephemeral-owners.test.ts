import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  acquireLease,
  createDb,
  deactivateSandboxEphemeralOwner,
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

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
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
      { relrowsecurity: boolean; relforcerowsecurity: boolean; required_privileges: string[] }[]
    >`
      select C.relrowsecurity,
             C.relforcerowsecurity,
             array_remove(array[
               case when has_table_privilege('opengeni_app', C.oid, 'SELECT') then 'SELECT' end,
               case when has_table_privilege('opengeni_app', C.oid, 'INSERT') then 'INSERT' end,
               case when has_table_privilege('opengeni_app', C.oid, 'UPDATE') then 'UPDATE' end
             ], null) as required_privileges
      from pg_class C
      join pg_namespace N on N.oid = C.relnamespace
      where C.relname = 'sandbox_ephemeral_owners'
        and N.nspname = current_schema()`;
    expect(table).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
      required_privileges: ["SELECT", "INSERT", "UPDATE"],
    });

    // The shared PostgreSQL harness intentionally grants DELETE on every public
    // table after migrations. Assert the migration's narrower application-role
    // contract from its source rather than conflating it with harness-wide ACLs.
    const migration = await Bun.file(
      new URL("../drizzle/0068_rig_verification_ephemeral_ownership.sql", import.meta.url),
    ).text();
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE ON TABLE %I.sandbox_ephemeral_owners TO opengeni_app",
    );
    expect(migration).not.toMatch(/GRANT[^;]*DELETE[^;]*sandbox_ephemeral_owners/i);

    const [fn] = await admin<
      { prosecdef: boolean; proconfig: string[] | null; executable: boolean }[]
    >`
      select P.prosecdef,
             P.proconfig,
             has_function_privilege(
               'opengeni_app',
               P.oid,
               'EXECUTE'
             ) as executable
      from pg_proc P
      join pg_namespace N on N.oid = P.pronamespace
      where N.nspname = 'opengeni_private'
        and P.proname = 'list_live_modal_sandbox_instances'`;
    expect(fn?.prosecdef).toBe(true);
    expect(fn?.proconfig).toContain("search_path=pg_catalog");
    expect(fn?.executable).toBe(true);

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
    await registerSandboxEphemeralOwner(db, { ...base, instanceId: firstInstanceId });
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
