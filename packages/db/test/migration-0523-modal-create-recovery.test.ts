import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

let fixture: OwnerMigratedTestDatabase;
let app: postgres.Sql;
let owner: postgres.Sql;
const suffix = crypto.randomUUID().replaceAll("-", "");
const appRole = `create_app_${suffix}`;
const hostileRole = `create_hostile_${suffix}`;
const password = crypto.randomUUID();
const groups: string[] = [];
beforeAll(async () => {
  fixture = (await acquireOwnerMigratedTestDatabase("modal-create-owner"))!;
  if (!fixture) throw Error("Real owner PostgreSQL required");
  await fixture.admin`CREATE ROLE ${fixture.admin(hostileRole)} NOSUPERUSER NOBYPASSRLS`;
  owner = postgres(fixture.ownerUrl, { max: 1, onnotice: () => undefined });
  // Apply hostile function defaults only immediately before the new migration.
  await owner.unsafe(`CREATE SCHEMA IF NOT EXISTS opengeni_private;
    CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION opengeni_private.test_create_defaults() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.name='0522_scoped_machine_update_status.sql' THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private GRANT EXECUTE ON FUNCTIONS TO "${hostileRole}"';
      END IF;RETURN NEW;END $$;
    CREATE TRIGGER test_create_defaults AFTER INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION opengeni_private.test_create_defaults();`);
  await migrate(fixture.ownerUrl, "public", { applicationDatabaseRoles: [appRole] });
  await provisionRoles(fixture.adminUrl, {
    appRole,
    appPassword: password,
    rlsStrategy: "force",
    artifactOutboxDispatcherPassword: "",
    artifactMaterializerPassword: "",
    hostExportPassword: "",
    temporalPassword: "",
    temporalDatabases: [],
  });
  const url = new URL(fixture.adminUrl);
  url.username = appRole;
  url.password = password;
  app = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  for (let n = 0; n < 2; n++) {
    const [account] =
      await fixture.admin`insert into managed_accounts(name) values('fixture') returning id`;
    const [workspace] =
      await fixture.admin`insert into workspaces(account_id,name) values(${account!.id},'fixture') returning id`;
    const group = crypto.randomUUID();
    groups.push(group);
    const operationId = crypto.randomUUID();
    const attempt = {
      version: 1,
      operationId,
      leaseEpoch: 1,
      providerBindingKey: "fixture",
      appId: "ap-fixture",
      providerName: `opengeni-create-${operationId}`,
      requestSha256: "a".repeat(64),
      imageId: "im-fixture",
      imageRef: null,
      rematerializationId: null,
      selectedRevision: null,
      startedAt: new Date().toISOString(),
      instanceId: null,
    };
    await fixture.admin`insert into sandbox_leases(account_id,workspace_id,sandbox_group_id,liveness,backend,lease_epoch,expires_at,updated_at,provider_create_attempt)
      values(${account!.id},${workspace!.id},${group},'warming','modal',1,now()-interval '1 minute',now()-interval '1 minute',${fixture.admin.json(attempt)})`;
  }
}, 180_000);
afterAll(async () => {
  await app?.end();
  await owner?.end();
  if (!fixture) return;
  try {
    for (const role of [appRole, hostileRole]) {
      await fixture.admin`DROP OWNED BY ${fixture.admin(role)}`;
      await fixture.admin`DROP ROLE ${fixture.admin(role)}`;
    }
  } finally {
    await fixture.release();
  }
}, 60_000);
test("non-bypass owner inventory sees both tenants only inside its read capability", async () => {
  expect(await owner`select sandbox_group_id from sandbox_leases`).toHaveLength(0);
  expect(await app`select sandbox_group_id from sandbox_leases`).toHaveLength(0);
  const rows = await app`select * from opengeni_private.list_pending_modal_provider_creates()`;
  expect(rows.map((row) => row.sandbox_group_id).sort()).toEqual([...groups].sort());
  expect(await owner`select sandbox_group_id from sandbox_leases`).toHaveLength(0);
  expect(
    await fixture.admin`select * from opengeni_private.modal_inventory_read_capabilities`,
  ).toHaveLength(0);
});
test("hostile defaults and PUBLIC cannot execute the new cross-tenant inventory", async () => {
  expect(
    (
      await fixture.admin`select has_function_privilege(${hostileRole},'opengeni_private.list_pending_modal_provider_creates()','EXECUTE') as allowed`
    )[0]!.allowed,
  ).toBe(false);
  const [row] = await fixture.admin`select count(*)::int as n from pg_proc p,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    where p.oid='opengeni_private.list_pending_modal_provider_creates()'::regprocedure and acl.grantee=0 and acl.privilege_type='EXECUTE'`;
  expect(row!.n).toBe(0);
});
test("the lease trigger grants no authority to PUBLIC or hostile default roles", async () => {
  expect(
    (
      await fixture.admin`select has_function_privilege(${hostileRole},'opengeni_private.guard_unresolved_provider_create()','EXECUTE') as allowed`
    )[0]!.allowed,
  ).toBe(false);
  const [row] = await fixture.admin`select count(*)::int as n from pg_proc p,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    where p.oid='opengeni_private.guard_unresolved_provider_create()'::regprocedure and acl.grantee=0 and acl.privilege_type='EXECUTE'`;
  expect(row!.n).toBe(0);
});
