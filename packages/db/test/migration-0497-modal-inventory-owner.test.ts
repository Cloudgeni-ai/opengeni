import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { createDb } from "../src";
import {
  inspectRuntimeDatabasePosture,
  evaluateRuntimeDatabasePosture,
} from "../src/runtime-posture";

let fixture: OwnerMigratedTestDatabase;
let app: postgres.Sql;
let owner: postgres.Sql;
const suffix = crypto.randomUUID().replaceAll("-", "");
const appRole = `inventory_app_${suffix}`;
const hostileRole = `inventory_hostile_${suffix}`;
const password = crypto.randomUUID();
const tenants: { accountId: string; workspaceId: string }[] = [];
const expected: string[] = [];
const roleOptions = {
  appRole,
  appPassword: password,
  rlsStrategy: "force" as const,
  artifactOutboxDispatcherPassword: "",
  artifactMaterializerPassword: "",
  hostExportPassword: "",
  temporalPassword: "",
  temporalDatabases: [],
};

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("modal-inventory-owner");
  if (!acquired) throw new Error("Real non-bypass owner PostgreSQL required");
  fixture = acquired;
  await fixture.admin`CREATE ROLE ${fixture.admin(hostileRole)} NOSUPERUSER NOBYPASSRLS`;
  owner = postgres(fixture.ownerUrl, { max: 1, onnotice: () => undefined });
  // Inject hostile defaults immediately before this migration, not into
  // unrelated historical schemas. The migration must strip all these grants.
  await owner.unsafe(`
    CREATE SCHEMA IF NOT EXISTS opengeni_private;
    CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION opengeni_private.test_inventory_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.name = '0496_supervised_command_settlement.sql' THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private GRANT ALL ON TABLES TO "${hostileRole}", PUBLIC';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_inventory_defaults AFTER INSERT ON schema_migrations
      FOR EACH ROW EXECUTE FUNCTION opengeni_private.test_inventory_defaults();
  `);
  await migrate(fixture.ownerUrl, "public", { applicationDatabaseRoles: [appRole] });
  await provisionRoles(fixture.adminUrl, roleOptions);
  const appUrl = new URL(fixture.adminUrl);
  appUrl.username = appRole;
  appUrl.password = password;
  app = postgres(appUrl.toString(), { max: 1, onnotice: () => undefined });
  for (const label of ["first", "second"]) {
    const [account] =
      await fixture.admin`insert into managed_accounts(name) values(${label}) returning id`;
    const [workspace] =
      await fixture.admin`insert into workspaces(account_id,name) values(${account!.id},${label}) returning id`;
    tenants.push({ accountId: account!.id, workspaceId: workspace!.id });
  }
  for (const [tenant, liveness, backend, resumeBackend, instanceId, included] of [
    [0, "warm", "modal", null, "live-first", true],
    [1, "warming", "modal", null, null, true],
    [1, "draining", "local", "modal", "live-second", true],
    [0, "cold", "modal", "modal", "excluded-cold", false],
    [1, "warm", "local", null, "excluded-local", false],
  ] as const) {
    const scope = tenants[tenant]!;
    const [lease] =
      await fixture.admin`insert into sandbox_leases(account_id,workspace_id,sandbox_group_id,
      liveness,backend,resume_backend_id,instance_id,lease_epoch,expires_at)
      values(${scope.accountId},${scope.workspaceId},${crypto.randomUUID()},${liveness},${backend},${resumeBackend},${instanceId},1,now()+interval '1 hour') returning id`;
    if (included) expected.push(lease!.id);
  }
}, 180_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  if (!fixture) return;
  try {
    for (const role of [appRole, hostileRole]) {
      if ((await fixture.admin`select 1 from pg_roles where rolname=${role}`).length) {
        await fixture.admin`DROP OWNED BY ${fixture.admin(role)}`;
        await fixture.admin`DROP ROLE ${fixture.admin(role)}`;
      }
    }
  } finally {
    await fixture.release();
  }
}, 60_000);

const inventory = (sql: postgres.Sql | postgres.TransactionSql) =>
  sql`select * from opengeni_private.list_live_modal_sandbox_leases()`;
const ids = (rows: postgres.RowList<postgres.Row[]>) => rows.map((row) => row.lease_id).sort();
async function inventoryPostureViolations() {
  const url = new URL(fixture.adminUrl);
  url.username = appRole;
  url.password = password;
  const client = createDb(url.toString());
  try {
    const options = {
      expectedRole: appRole,
      rlsStrategy: "force" as const,
      organizationTenancyCanonicalActivationEnabled: true,
    };
    const posture = await inspectRuntimeDatabasePosture(client.db, options);
    return evaluateRuntimeDatabasePosture(posture, options).filter((message) =>
      message.startsWith("Modal inventory"),
    );
  } finally {
    await client.close();
  }
}

test("global inventory preserves exact filters across tenants under a FORCE-RLS non-bypass owner", async () => {
  const [posture] = await fixture.admin`select r.rolsuper,r.rolbypassrls,c.relforcerowsecurity
    from pg_proc p join pg_roles r on r.oid=p.proowner
    join pg_class c on c.oid='sandbox_leases'::regclass
    where p.oid='opengeni_private.list_live_modal_sandbox_leases()'::regprocedure`;
  expect(posture).toEqual({ rolsuper: false, rolbypassrls: false, relforcerowsecurity: true });
  expect(await inventoryPostureViolations()).toEqual([]);
  expect(ids(await inventory(app))).toEqual([...expected].sort());
  expect((await inventory(app)).find((row) => row.instance_id === null)?.liveness).toBe("warming");
  for (const tenant of [
    ...tenants,
    { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() },
  ]) {
    await app.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id',${tenant.accountId},true),set_config('opengeni.workspace_id',${tenant.workspaceId},true)`;
      const before =
        await tx`select id from sandbox_leases where workspace_id<>${tenant.workspaceId}`;
      expect(before).toHaveLength(0);
      expect(ids(await inventory(tx))).toEqual([...expected].sort());
      expect(ids(await inventory(tx))).toEqual([...expected].sort());
      expect(
        await tx`select id from sandbox_leases where workspace_id<>${tenant.workspaceId}`,
      ).toHaveLength(0);
      expect(
        await tx`update sandbox_leases set instance_id='forbidden' where workspace_id<>${tenant.workspaceId} returning id`,
      ).toHaveLength(0);
      expect((await tx`select modal_inventory_read_capability_active() as active`)[0]!.active).toBe(
        false,
      );
    });
  }
  expect(
    await fixture.admin`select * from opengeni_private.modal_inventory_read_capabilities`,
  ).toHaveLength(0);
});

test("runtime cannot mint capabilities or forge them with GUCs; hostile defaults and reprovision stay closed", async () => {
  for (const role of [appRole, hostileRole])
    for (const privilege of [
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
    ]) {
      expect(
        (
          await fixture.admin`select has_table_privilege(${role},'opengeni_private.modal_inventory_read_capabilities',${privilege}) as allowed`
        )[0]!.allowed,
      ).toBe(false);
    }
  await app.begin(async (tx) => {
    await tx`select set_config('opengeni.modal_inventory_read','1',true),set_config('opengeni.modal_inventory_owner',${fixture.ownerRole},true)`;
    expect((await tx`select modal_inventory_read_capability_active() as active`)[0]!.active).toBe(
      false,
    );
    for (const query of [
      "select * from opengeni_private.modal_inventory_read_capabilities",
      "insert into opengeni_private.modal_inventory_read_capabilities values(pg_backend_pid(),pg_current_xact_id(),'public')",
      "delete from opengeni_private.modal_inventory_read_capabilities",
    ])
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint.unsafe(query);
        }),
      ).rejects.toMatchObject({ code: "42501" });
  });
  await fixture.admin`GRANT ALL ON opengeni_private.modal_inventory_read_capabilities TO ${fixture.admin(appRole)}, PUBLIC`;
  await fixture.admin`GRANT UPDATE (backend_pid,transaction_id,data_schema) ON opengeni_private.modal_inventory_read_capabilities TO ${fixture.admin(appRole)}, PUBLIC`;
  expect(await inventoryPostureViolations()).toHaveLength(1);
  await provisionRoles(fixture.adminUrl, roleOptions);
  expect(await inventoryPostureViolations()).toEqual([]);
  expect(
    (
      await app`select has_table_privilege(current_user,'opengeni_private.modal_inventory_read_capabilities','SELECT') as allowed`
    )[0]!.allowed,
  ).toBe(false);
  expect(
    (
      await app`select has_column_privilege(current_user,'opengeni_private.modal_inventory_read_capabilities','backend_pid','UPDATE') as allowed`
    )[0]!.allowed,
  ).toBe(false);
  await expect(
    Promise.resolve(
      app`insert into opengeni_private.modal_inventory_read_capabilities values(pg_backend_pid(),pg_current_xact_id(),'public')`,
    ),
  ).rejects.toMatchObject({ code: "42501" });
  expect(ids(await inventory(app))).toEqual([...expected].sort());
});

test("column-only capability grants are detected and reprovisioned closed", async () => {
  for (const privilege of ["SELECT", "INSERT", "UPDATE"] as const) {
    await fixture.admin.unsafe(
      `GRANT ${privilege} (backend_pid,transaction_id,data_schema) ON opengeni_private.modal_inventory_read_capabilities TO "${appRole}"`,
    );
    const [permissions] = await app`select
      has_table_privilege(current_user,'opengeni_private.modal_inventory_read_capabilities',${privilege}) as table_allowed,
      has_any_column_privilege(current_user,'opengeni_private.modal_inventory_read_capabilities',${privilege}) as column_allowed`;
    expect(permissions).toEqual({ table_allowed: false, column_allowed: true });
    expect(await inventoryPostureViolations()).toHaveLength(1);
    if (privilege === "INSERT") {
      const rollback = new Error("rollback column-only capability probe");
      await expect(
        app.begin(async (tx) => {
          await tx`insert into opengeni_private.modal_inventory_read_capabilities values(pg_backend_pid(),pg_current_xact_id(),'public')`;
          expect(
            (await tx`select modal_inventory_read_capability_active() as active`)[0]!.active,
          ).toBe(true);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
    await provisionRoles(fixture.adminUrl, roleOptions);
    expect(await inventoryPostureViolations()).toEqual([]);
    expect(
      (
        await app`select has_any_column_privilege(current_user,'opengeni_private.modal_inventory_read_capabilities',${privilege}) as allowed`
      )[0]!.allowed,
    ).toBe(false);
    await expect(
      Promise.resolve(
        app`insert into opengeni_private.modal_inventory_read_capabilities values(pg_backend_pid(),pg_current_xact_id(),'public')`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
  }
  expect(
    await fixture.admin`select * from opengeni_private.modal_inventory_read_capabilities`,
  ).toHaveLength(0);
});

test("materialization failure cleans up and nested owner calls preserve only pre-existing authority", async () => {
  await app.begin(async (tx) => {
    await expect(
      tx.savepoint(async (savepoint) => {
        await savepoint`set local row_security=off`;
        await inventory(savepoint);
      }),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await tx`select modal_inventory_read_capability_active() as active`)[0]!.active).toBe(
      false,
    );
    expect(await tx`select id from sandbox_leases`).toHaveLength(0);
    expect(ids(await inventory(tx))).toEqual([...expected].sort());
  });
  await owner.begin(async (tx) => {
    await tx`insert into opengeni_private.modal_inventory_read_capabilities values(pg_backend_pid(),pg_current_xact_id(),'public')`;
    expect(ids(await inventory(tx))).toEqual([...expected].sort());
    expect(
      await tx`select * from opengeni_private.modal_inventory_read_capabilities where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()`,
    ).toHaveLength(1);
    await tx`delete from opengeni_private.modal_inventory_read_capabilities where backend_pid=pg_backend_pid() and transaction_id=pg_current_xact_id()`;
    expect((await tx`select modal_inventory_read_capability_active() as active`)[0]!.active).toBe(
      false,
    );
  });
  expect(
    await fixture.admin`select * from opengeni_private.modal_inventory_read_capabilities`,
  ).toHaveLength(0);
});
