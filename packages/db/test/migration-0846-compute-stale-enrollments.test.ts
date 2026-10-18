import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { computeSandboxNamed, createDb, revokeStaleComputeSandboxEnrollments } from "../src";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

let fixture: OwnerMigratedTestDatabase;
let app: postgres.Sql;
let owner: postgres.Sql;
const suffix = crypto.randomUUID().replaceAll("-", "");
const appRole = `compute_inventory_app_${suffix}`;
const hostileRole = `compute_inventory_hostile_${suffix}`;
const password = crypto.randomUUID();
const stale: string[] = [];
const kept: string[] = [];

function appUrl(): string {
  const url = new URL(fixture.adminUrl);
  url.username = appRole;
  url.password = password;
  return url.toString();
}

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("compute-enrollment-inventory");
  if (!acquired) throw new Error("Real non-bypass owner PostgreSQL required");
  fixture = acquired;
  await fixture.admin`CREATE ROLE ${fixture.admin(hostileRole)} NOSUPERUSER NOBYPASSRLS`;
  owner = postgres(fixture.ownerUrl, { max: 1, onnotice: () => undefined });
  // Hostile function defaults applied just before the new migration must not
  // reach its cross-workspace inventory.
  await owner.unsafe(`CREATE SCHEMA IF NOT EXISTS opengeni_private;
    CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
    CREATE FUNCTION opengeni_private.test_compute_inventory_defaults() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.name='0845_compute_lease_group_end_and_sleep.sql' THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_private GRANT EXECUTE ON FUNCTIONS TO "${hostileRole}"';
      END IF;RETURN NEW;END $$;
    CREATE TRIGGER test_compute_inventory_defaults AFTER INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION opengeni_private.test_compute_inventory_defaults();`);
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
  app = postgres(appUrl(), { max: 1, onnotice: () => undefined });

  const enroll = async (
    tenant: { accountId: string; workspaceId: string },
    input: { ageMinutes: number; group?: string },
  ): Promise<{ id: string; group: string }> => {
    const id = crypto.randomUUID();
    const group = input.group ?? crypto.randomUUID();
    await fixture.admin`insert into enrollments(id,account_id,workspace_id,kind,sandbox_group_id,
      pubkey,exposure,status,created_at)
      values(${id},${tenant.accountId},${tenant.workspaceId},'sandbox',${group},null,
        'whole-machine','active',now() - make_interval(mins => ${input.ageMinutes}))`;
    return { id, group };
  };
  const lease = async (
    tenant: { accountId: string; workspaceId: string },
    group: string,
    liveness: string,
    enrollmentId: string | null,
  ): Promise<void> => {
    const resumeState = enrollmentId ? { sessionState: { enrollmentId } } : null;
    await fixture.admin`insert into sandbox_leases(account_id,workspace_id,sandbox_group_id,
      liveness,backend,lease_epoch,expires_at,resume_state)
      values(${tenant.accountId},${tenant.workspaceId},${group},${liveness},'compute',1,
        now()+interval '1 hour',${resumeState ? fixture.admin.json(resumeState) : null})`;
  };
  const tenants: { accountId: string; workspaceId: string }[] = [];
  for (const label of ["first", "second"]) {
    const [account] =
      await fixture.admin`insert into managed_accounts(name) values(${label}) returning id`;
    const [workspace] =
      await fixture.admin`insert into workspaces(account_id,name) values(${account!.id},${label}) returning id`;
    tenants.push({ accountId: account!.id, workspaceId: workspace!.id });
  }
  const [first, second] = tenants as [(typeof tenants)[0], (typeof tenants)[0]];
  // Stale: its group has no lease any more (a deleted chat's group).
  stale.push((await enroll(first, { ageMinutes: 30 })).id);
  // Stale: its group's lease moved on to another box.
  const movedOn = await enroll(second, { ageMinutes: 30 });
  await lease(second, movedOn.group, "cold", crypto.randomUUID());
  stale.push(movedOn.id);
  // Kept: the lease names it (asleep or idle, it is still the group's box).
  const named = await enroll(first, { ageMinutes: 30 });
  await lease(first, named.group, "cold", named.id);
  kept.push(named.id);
  // Kept: a creator is warming its group.
  const warming = await enroll(second, { ageMinutes: 30 });
  await lease(second, warming.group, "warming", null);
  kept.push(warming.id);
  // Kept: younger than the create settle window.
  kept.push((await enroll(first, { ageMinutes: 1 })).id);
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

test("the runtime role lists stale sandbox enrollments of every workspace, and only those", async () => {
  // Neither the runtime role nor the owner reads enrollments across workspaces.
  expect(await app`select id from enrollments`).toHaveLength(0);
  expect(await owner`select id from enrollments`).toHaveLength(0);
  const rows = await app`select * from opengeni_private.list_stale_compute_sandbox_enrollments()`;
  expect(rows.map((row) => row.enrollment_id).sort()).toEqual([...stale].sort());
  // The capability ends with the inventory.
  expect(await owner`select id from enrollments`).toHaveLength(0);
  expect(
    await fixture.admin`select * from opengeni_private.modal_inventory_read_capabilities`,
  ).toHaveLength(0);
});

test("revoking stale enrollments revokes exactly those, under workspace RLS, once", async () => {
  const client = createDb(appUrl());
  try {
    const first = await revokeStaleComputeSandboxEnrollments(client.db);
    expect(first.failed).toBe(0);
    expect(first.revoked.map((row) => row.enrollmentId).sort()).toEqual([...stale].sort());
    const statuses = await fixture.admin`select id, status from enrollments
      where id in ${fixture.admin([...stale, ...kept])}`;
    for (const row of statuses) {
      expect(row.status).toBe(stale.includes(row.id) ? "revoked" : "active");
    }
    expect(await revokeStaleComputeSandboxEnrollments(client.db)).toEqual({
      revoked: [],
      failed: 0,
    });
  } finally {
    await client.close();
  }
});

test("bounded sweep queries end by their deadline or stop, lock waits included", async () => {
  const [source] = await fixture.admin`select account_id, workspace_id from enrollments
    where id = ${stale[0]!}`;
  const workspaceId = source!.workspace_id as string;
  const enrollmentId = crypto.randomUUID();
  const group = crypto.randomUUID();
  await fixture.admin`insert into enrollments(id,account_id,workspace_id,kind,sandbox_group_id,
    pubkey,exposure,status,created_at)
    values(${enrollmentId},${source!.account_id},${workspaceId},'sandbox',${group},null,
      'whole-machine','active',now() - interval '30 minutes')`;
  // A workspace deletion holds the tenancy lock every workspace-scoped write waits on.
  const holder = await fixture.admin.reserve();
  const client = createDb(appUrl());
  try {
    await holder`select pg_advisory_lock(hashtextextended(${`session-tenancy:${workspaceId}`}::text, 0))`;
    let started = Date.now();
    const timedOut = await revokeStaleComputeSandboxEnrollments(client.db, {
      deadlineAtMs: Date.now() + 400,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(timedOut.revoked).toEqual([]);
    expect(timedOut.failed).toBe(1);

    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    started = Date.now();
    const stopped = await revokeStaleComputeSandboxEnrollments(client.db, {
      deadlineAtMs: Date.now() + 60_000,
      signal: stop.signal,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(stopped.revoked).toEqual([]);

    started = Date.now();
    await expect(
      computeSandboxNamed(
        client.db,
        { workspaceId, sandboxGroupId: group, enrollmentId, sandboxId: "sbx" },
        { deadlineAtMs: Date.now() + 400 },
      ),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    // A stopped or timed-out revoke committed nothing.
    const [still] = await fixture.admin`select status from enrollments where id = ${enrollmentId}`;
    expect(still!.status).toBe("active");

    await holder`select pg_advisory_unlock(hashtextextended(${`session-tenancy:${workspaceId}`}::text, 0))`;
    const after = await revokeStaleComputeSandboxEnrollments(client.db, {
      deadlineAtMs: Date.now() + 30_000,
    });
    expect(after.revoked.map((row) => row.enrollmentId)).toEqual([enrollmentId]);
  } finally {
    holder.release();
    await client.close();
  }
}, 60_000);

test("PUBLIC and hostile default roles cannot execute the inventory, and posture holds", async () => {
  expect(
    (
      await fixture.admin`select has_function_privilege(${hostileRole},'opengeni_private.list_stale_compute_sandbox_enrollments()','EXECUTE') as allowed`
    )[0]!.allowed,
  ).toBe(false);
  const [row] = await fixture.admin`select count(*)::int as n from pg_proc p,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    where p.oid='opengeni_private.list_stale_compute_sandbox_enrollments()'::regprocedure
      and acl.grantee=0 and acl.privilege_type='EXECUTE'`;
  expect(row!.n).toBe(0);
  const client = createDb(appUrl());
  try {
    const options = { expectedRole: appRole, rlsStrategy: "force" as const };
    const posture = await inspectRuntimeDatabasePosture(client.db, options);
    expect(
      evaluateRuntimeDatabasePosture(posture, options).filter(
        (message) => message.startsWith("Compute") || message.startsWith("Modal inventory"),
      ),
    ).toEqual([]);
  } finally {
    await client.close();
  }
});
