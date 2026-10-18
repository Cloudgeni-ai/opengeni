import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  computeSandboxNamed,
  createDb,
  DatabaseWorkDeadlineError,
  listStaleComputeSandboxEnrollments,
  revokeStaleComputeSandboxEnrollment,
  STALE_COMPUTE_ENROLLMENT_PAGE_SIZE,
  type DatabaseWorkBound,
} from "../src";
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
    box: { instanceId?: string; backend?: string; archiveOnly?: boolean } = {},
  ): Promise<void> => {
    // The lease envelope as the worker writes it: the provider state, with the
    // enrollment, under sessionState.providerState. An archive-only envelope
    // (a capture folded onto a lease whose provider state never serialized)
    // carries no provider state at all.
    const resumeState = box.archiveOnly
      ? { sessionState: { workspaceArchiveAt: new Date().toISOString() } }
      : enrollmentId
        ? {
            backendId: "compute",
            sessionState: { providerState: { sandboxId: "sbx-named", enrollmentId } },
          }
        : null;
    await fixture.admin`insert into sandbox_leases(account_id,workspace_id,sandbox_group_id,
      liveness,backend,lease_epoch,expires_at,instance_id,resume_state)
      values(${tenant.accountId},${tenant.workspaceId},${group},${liveness},
        ${box.backend ?? "compute"},1,now()+interval '1 hour',${box.instanceId ?? null},
        ${resumeState ? fixture.admin.json(resumeState) : null})`;
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
  // Kept: a warm lease holds a live compute box, even though a capture left its
  // envelope with archive fields only.
  const live = await enroll(first, { ageMinutes: 30 });
  await lease(first, live.group, "warm", null, { instanceId: "sbx-live", archiveOnly: true });
  kept.push(live.id);
  // Stale: a warm lease whose envelope names a newer enrollment of the group.
  const replaced = await enroll(second, { ageMinutes: 30 });
  await lease(second, replaced.group, "warm", crypto.randomUUID(), { instanceId: "sbx-new" });
  stale.push(replaced.id);
  // Stale: its group moved to another backend's live box.
  const otherBackend = await enroll(second, { ageMinutes: 30 });
  await lease(second, otherBackend.group, "warm", null, {
    instanceId: "sb-modal",
    backend: "modal",
    archiveOnly: true,
  });
  stale.push(otherBackend.id);
  // Kept: younger than the create settle window.
  kept.push((await enroll(first, { ageMinutes: 1 })).id);
}, 180_000);

/** List, then revoke each listed enrollment in turn (as one sweep pass would). */
async function revokeStaleComputeSandboxEnrollments(
  db: Parameters<typeof listStaleComputeSandboxEnrollments>[0],
  bound?: DatabaseWorkBound,
): Promise<{ revoked: { workspaceId: string; enrollmentId: string }[]; failed: number }> {
  const revoked: { workspaceId: string; enrollmentId: string }[] = [];
  let failed = 0;
  let after: string | undefined;
  for (;;) {
    const page = await listStaleComputeSandboxEnrollments(db, after, bound);
    for (const candidate of page.candidates) {
      if (bound && (bound.signal?.aborted || Date.now() >= bound.deadlineAtMs)) break;
      try {
        if (await revokeStaleComputeSandboxEnrollment(db, candidate, bound))
          revoked.push(candidate);
      } catch {
        failed += 1;
      }
    }
    if (!page.more) return { revoked, failed };
    after = page.candidates.at(-1)!.enrollmentId;
  }
}

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
  const rows =
    await app`select * from opengeni_private.list_stale_compute_sandbox_enrollments(null)`;
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

test("a bounded call ends its database work at the deadline and never commits late", async () => {
  const [source] = await fixture.admin`select account_id, workspace_id from enrollments
    where id = ${stale[0]!}`;
  const workspaceId = source!.workspace_id as string;
  const enrollmentId = crypto.randomUUID();
  await fixture.admin`insert into enrollments(id,account_id,workspace_id,kind,sandbox_group_id,
    pubkey,exposure,status,created_at)
    values(${enrollmentId},${source!.account_id},${workspaceId},'sandbox',${crypto.randomUUID()},
      null,'whole-machine','active',now() - interval '30 minutes')`;
  const tenancy = await fixture.admin.reserve();
  const row = await fixture.admin.reserve();
  // A one-connection pool, held by the revoke itself: the deadline needs no
  // other connection, because the server enforces it.
  const client = createDb(appUrl(), { max: 1 });
  try {
    // The tenancy lock is released after 210 ms, inside the 300 ms deadline;
    // the revoke's UPDATE then waits on the enrollment's row lock, which is
    // released only after the deadline. Without a deadline-wide cancel the
    // UPDATE ran on and committed late.
    await tenancy`select pg_advisory_lock(hashtextextended(${`session-tenancy:${workspaceId}`}::text, 0))`;
    await row`begin`;
    await row`select id from enrollments where id = ${enrollmentId} for update`;
    setTimeout(() => {
      void tenancy`select pg_advisory_unlock(hashtextextended(${`session-tenancy:${workspaceId}`}::text, 0))`.execute();
    }, 210);
    const releaseRow = new Promise<void>((resolve) => {
      setTimeout(() => {
        void row`rollback`.then(() => resolve());
      }, 700);
    });
    const started = Date.now();
    const error = await revokeStaleComputeSandboxEnrollment(
      client.db,
      { workspaceId, enrollmentId },
      { deadlineAtMs: started + 300 },
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(480);
    // The server is no longer running the revoke's statement.
    // (The admin pool's connections are both reserved above, so ask on one of them.)
    const active = await tenancy`select pid from pg_stat_activity
      where usename = ${appRole} and state = 'active' and query ilike '%update enrollments%'`;
    expect(active).toHaveLength(0);
    await releaseRow;
    const [still] = await tenancy`select status from enrollments where id = ${enrollmentId}`;
    expect(still!.status).toBe("active");
    // A call whose bound has already passed does nothing at all.
    await expect(
      revokeStaleComputeSandboxEnrollment(
        client.db,
        { workspaceId, enrollmentId },
        { deadlineAtMs: Date.now() - 1 },
      ),
    ).rejects.toBeInstanceOf(DatabaseWorkDeadlineError);
    // Unbounded by locks, the same revoke completes.
    expect(
      await revokeStaleComputeSandboxEnrollment(
        client.db,
        { workspaceId, enrollmentId },
        { deadlineAtMs: Date.now() + 30_000 },
      ),
    ).toBe(true);
  } finally {
    tenancy.release();
    row.release();
    await client.close();
  }
}, 60_000);

test("PUBLIC and hostile default roles cannot execute the inventory, and posture holds", async () => {
  expect(
    (
      await fixture.admin`select has_function_privilege(${hostileRole},'opengeni_private.list_stale_compute_sandbox_enrollments(uuid)','EXECUTE') as allowed`
    )[0]!.allowed,
  ).toBe(false);
  const [row] = await fixture.admin`select count(*)::int as n from pg_proc p,
    lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    where p.oid='opengeni_private.list_stale_compute_sandbox_enrollments(uuid)'::regprocedure
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

test("the inventory is read a page at a time after a cursor, so every stale enrollment is reached", async () => {
  const [source] = await fixture.admin`select account_id, workspace_id from enrollments
    where id = ${stale[0]!}`;
  const many: string[] = [];
  for (let index = 0; index < STALE_COMPUTE_ENROLLMENT_PAGE_SIZE + 5; index += 1) {
    const id = crypto.randomUUID();
    many.push(id);
    await fixture.admin`insert into enrollments(id,account_id,workspace_id,kind,sandbox_group_id,
      pubkey,exposure,status,created_at)
      values(${id},${source!.account_id},${source!.workspace_id},'sandbox',${crypto.randomUUID()},
        null,'whole-machine','active',now() - interval '30 minutes')`;
  }
  const client = createDb(appUrl());
  try {
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await listStaleComputeSandboxEnrollments(client.db, after);
      pages += 1;
      const ids = page.candidates.map((candidate) => candidate.enrollmentId);
      // In id order, strictly after the cursor.
      expect(ids).toEqual([...ids].sort());
      if (after !== undefined) expect(ids.every((id) => id > after!)).toBe(true);
      seen.push(...ids);
      if (!page.more) break;
      expect(ids).toHaveLength(STALE_COMPUTE_ENROLLMENT_PAGE_SIZE);
      after = ids.at(-1);
    }
    expect(pages).toBeGreaterThan(1);
    for (const id of many) expect(seen).toContain(id);
  } finally {
    await client.close();
    await fixture.admin`update enrollments set status = 'revoked' where id in ${fixture.admin(many)}`;
  }
});
