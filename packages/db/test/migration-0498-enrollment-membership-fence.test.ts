import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type { Database } from "../src/database";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  approveDeviceEnrollmentRequest,
  createDeviceEnrollmentRequest,
  createDb,
  finalizeEnrollmentByToken,
} from "../src/index";

let shared: OwnerMigratedTestDatabase;
let app: postgres.Sql;
let client: ReturnType<typeof createDb>;
const appRole = `enrollment_app_${crypto.randomUUID().replaceAll("-", "")}`;
const password = crypto.randomUUID();
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("enrollment-membership-fence");
  if (!acquired) throw new Error("Real non-bypass owner PostgreSQL is required");
  shared = acquired;
  // Shared template clones retain the superuser migration owner. Exercise the
  // SECURITY DEFINER functions with the production-style non-bypass owner.
  await migrate(shared.ownerUrl, "public", { applicationDatabaseRoles: [appRole] });
  await provisionRoles(shared.adminUrl, {
    appRole,
    appPassword: password,
    rlsStrategy: "force",
    artifactOutboxDispatcherPassword: "",
    artifactMaterializerPassword: "",
    hostExportPassword: "",
    temporalPassword: "",
    temporalDatabases: [],
  });
  const appUrl = new URL(shared.adminUrl);
  appUrl.username = appRole;
  appUrl.password = password;
  app = postgres(appUrl.toString(), { max: 4 });
  client = createDb(appUrl.toString());
}, 180_000);
afterAll(async () => {
  try {
    try {
      await client?.close();
    } finally {
      await app?.end();
    }
  } finally {
    if (shared) {
      try {
        if ((await shared.admin`select 1 from pg_roles where rolname=${appRole}`).length) {
          await shared.admin`DROP OWNED BY ${shared.admin(appRole)}`;
          await shared.admin`DROP ROLE ${shared.admin(appRole)}`;
        }
      } finally {
        await shared.release();
      }
    }
  }
}, 60_000);

async function fixture() {
  const subject = `member:${crypto.randomUUID()}`;
  const actor = `owner:${crypto.randomUUID()}`;
  const [a] =
    await shared.admin`insert into managed_accounts(name) values('enrollment fence') returning id`;
  const [personal] =
    await shared.admin`insert into workspaces(account_id,name) values(${a!.id},'personal') returning id`;
  const [ws] =
    await shared.admin`insert into workspaces(account_id,name) values(${a!.id},'shared') returning id`;
  const [ownerWs] =
    await shared.admin`insert into workspaces(account_id,name) values(${a!.id},'owner') returning id`;
  for (const id of [personal!.id, ws!.id, ownerWs!.id])
    await shared.admin`insert into workspace_inference_controls(account_id,workspace_id) values(${a!.id},${id})`;
  const [member] =
    await shared.admin`insert into organization_memberships(account_id,subject_id,status,role,personal_workspace_id,authorization_revision)
    values(${a!.id},${subject},'active','member',${personal!.id},1) returning id`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,status,role,personal_workspace_id,authorization_revision)
    values(${a!.id},${actor},'active','owner',${ownerWs!.id},1)`;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id,permissions) values
    (${a!.id},${ws!.id},${subject},'[]'::jsonb),(${a!.id},${ws!.id},${actor},'["workspace:admin"]'::jsonb)`;
  await shared.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by)
    values(${a!.id},1,${"0".repeat(64)},${"1".repeat(64)},'test')`;
  return {
    accountId: a!.id as string,
    workspaceId: ws!.id as string,
    personalWorkspaceId: personal!.id as string,
    subject,
    actor,
    membershipId: member!.id as string,
  };
}

test("public user approval succeeds under a non-bypass owner and replay does not rotate credentials", async () => {
  const f = await fixture();
  const [owner] =
    await shared.admin`select r.rolsuper,r.rolbypassrls from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid='finalize_scoped_enrollment(uuid,uuid,text,text,boolean,boolean,text,text,text,boolean)'::regprocedure`;
  expect(owner).toMatchObject({ rolsuper: false, rolbypassrls: false });
  const request = await createDeviceEnrollmentRequest(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    deviceCode: crypto.randomUUID(),
    userCode: crypto.randomUUID(),
    pubkey: `ed25519:${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + 600000),
  });
  const input = {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    requestId: request.id,
    scope: "user" as const,
    allowScreenControl: false,
    approvedBySubjectId: f.subject,
    sandboxName: "test machine",
  };
  const first = await approveDeviceEnrollmentRequest(client.db, input);
  expect(first.approved).toBe(true);
  expect(first.enrollment?.scope).toBe("user");
  const replay = await approveDeviceEnrollmentRequest(client.db, input);
  expect(replay.enrollment?.id).toBe(first.enrollment?.id);
  expect(replay.enrollment?.credentialGeneration).toBe(first.enrollment?.credentialGeneration);
  const [count] =
    await shared.admin`select count(*)::int as count from enrollments where account_id=${f.accountId}`;
  expect(count!.count).toBe(1);
  const fresh = await createDeviceEnrollmentRequest(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    deviceCode: crypto.randomUUID(),
    userCode: crypto.randomUUID(),
    pubkey: request.pubkey,
    expiresAt: new Date(Date.now() + 600000),
  });
  const rotated = await approveDeviceEnrollmentRequest(client.db, {
    ...input,
    requestId: fresh.id,
  });
  expect(rotated.enrollment?.id).toBe(first.enrollment?.id);
  expect(rotated.enrollment?.credentialGeneration).toBe(first.enrollment!.credentialGeneration + 1);
}, 30000);

test("legacy token lane remains workspace-owned", async () => {
  const f = await fixture();
  const result = await finalizeEnrollmentByToken(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    pubkey: `ed25519:${crypto.randomUUID()}`,
    hasDisplay: false,
    allowScreenControl: false,
    os: "linux",
    arch: "x86_64",
    sandboxName: "legacy",
  });
  expect(result.enrollment.scope).toBe("workspace");
});

test("maintenance declares drain and patches no policies or workspace row locks", async () => {
  const source = await readFile(
    new URL("../drizzle/0498_enrollment_membership_fence.sql", import.meta.url),
    "utf8",
  );
  expect(source.startsWith("-- deployment-mode: maintenance")).toBe(true);
  expect(source).toContain("pg_stat_activity");
  expect(source).not.toMatch(/CREATE POLICY|ALTER POLICY|BYPASSRLS/);
  const [fn] =
    await shared.admin`select pg_get_functiondef('finalize_scoped_enrollment(uuid,uuid,text,text,boolean,boolean,text,text,text,boolean)'::regprocedure) as definition`;
  expect(fn!.definition).toContain("pg_try_advisory_xact_lock");
  expect(fn!.definition).toContain(
    "workspace_membership.subject_id = caller_subject FOR KEY SHARE",
  );
  expect(fn!.definition).not.toContain("membership.revoked_at IS NULL FOR SHARE");
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function scope(tx: postgres.TransactionSql, f: Fixture, actor = f.subject) {
  await tx`select set_config('opengeni.account_id',${f.accountId},true),
    set_config('opengeni.workspace_id',${f.workspaceId},true),
    set_config('opengeni.subject_id',${actor},true),
    set_config('opengeni.initiating_human_subject_id',${actor},true)`;
}
async function finalize(tx: postgres.TransactionSql, f: Fixture) {
  return await tx`select * from finalize_scoped_enrollment(${f.accountId}::uuid,${f.workspaceId}::uuid,
    'user',${`ed25519:${crypto.randomUUID()}`},false,false,'linux','x86_64','race',false)`;
}
async function revoke(
  tx: postgres.TransactionSql,
  f: Fixture,
  kind: "suspend" | "offboard" | "workspace",
) {
  await scope(tx, f, f.actor);
  if (kind !== "workspace") {
    await tx`select set_config('opengeni.workspace_id','',true)`;
    const command = tx.json({
      action: kind,
      organizationId: f.accountId,
      actorSubjectId: f.actor,
      membershipId: f.membershipId,
      expectedAuthorizationRevision: 1,
      operationId: crypto.randomUUID(),
    });
    // Match the supported lifecycle: this fixture has no pending protocols.
    const [prepared] =
      await tx`select prepare_organization_membership_protocol_settlements(${command}::jsonb) as settlements`;
    expect(prepared!.settlements).toEqual([]);
    return await tx`select organization_membership_command(${command}::jsonb)`;
  }
  const command = tx.json({
    action: "remove",
    organizationId: f.accountId,
    workspaceId: f.workspaceId,
    actorSubjectId: f.actor,
    targetSubjectId: f.subject,
    operationId: crypto.randomUUID(),
  });
  // Supported outer workspace-removal callers enter the organization fence
  // first; preparation/command re-enter it. Direct preparation also fails
  // closed on contention, covered separately below.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${f.accountId}`},0))`;
  const [prepared] =
    await tx`select prepare_workspace_membership_removal_settlements(${command}::jsonb) as settlements`;
  expect(prepared!.settlements).toEqual([]);
  return await tx`select workspace_membership_removal_command(${command}::jsonb)`;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function assertBlocked(pid: number) {
  for (let i = 0; i < 500; i++) {
    const [r] = await shared.admin`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`;
    if (r!.blocked) {
      expect(r!.blocked).toBe(true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No actual PostgreSQL lock wait observed for ${pid}`);
}

for (const kind of ["suspend", "offboard", "workspace"] as const) {
  test(`${kind}: enrollment first holds revocation until commit`, async () => {
    const f = await fixture();
    const held = deferred<void>(),
      release = deferred<void>(),
      waiter = deferred<number>();
    const enrolling = app.begin(async (tx) => {
      await scope(tx, f);
      await finalize(tx, f);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const revoking = app.begin(async (tx) => {
      const [p] = await tx`select pg_backend_pid() as pid`;
      waiter.resolve(p!.pid);
      await revoke(tx, f, kind);
    });
    // Attach a handler before polling so a failed command cannot be unhandled.
    const result = revoking.then(
      () => null,
      (e) => e,
    );
    try {
      await assertBlocked(await waiter.promise);
    } finally {
      release.resolve();
    }
    await enrolling;
    expect(await result).toBeNull();
    await expect(
      app.begin(async (tx) => {
        await scope(tx, f);
        await finalize(tx, f);
      }),
    ).rejects.toMatchObject({ code: kind === "workspace" ? "42501" : "P0002" });
  }, 30000);

  test(`${kind}: revocation first prevents enrollment before and after commit`, async () => {
    const f = await fixture();
    const held = deferred<void>(),
      release = deferred<void>();
    const revoking = app.begin(async (tx) => {
      await revoke(tx, f, kind);
      held.resolve();
      await release.promise;
    });
    const result = revoking.then(
      () => null,
      (e) => {
        held.resolve();
        return e;
      },
    );
    await held.promise;
    try {
      await expect(
        app.begin(async (tx) => {
          await scope(tx, f);
          await finalize(tx, f);
        }),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      release.resolve();
    }
    expect(await result).toBeNull();
    await expect(
      app.begin(async (tx) => {
        await scope(tx, f);
        await finalize(tx, f);
      }),
    ).rejects.toMatchObject({ code: kind === "workspace" ? "42501" : "P0002" });
    const [r] =
      await shared.admin`select count(*)::int as count from enrollments where account_id=${f.accountId}`;
    expect(r!.count).toBe(0);
  }, 30000);
}

test("raw runtime DELETE waits behind enrollment workspace key-share", async () => {
  const f = await fixture();
  const held = deferred<void>(),
    release = deferred<void>(),
    waiter = deferred<number>();
  const enrolling = app.begin(async (tx) => {
    await scope(tx, f);
    await finalize(tx, f);
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const deleting = app.begin(async (tx) => {
    const [p] = await tx`select pg_backend_pid() as pid`;
    waiter.resolve(p!.pid);
    await tx`delete from workspace_memberships where workspace_id=${f.workspaceId} and subject_id=${f.subject}`;
  });
  const result = deleting.then(
    () => null,
    (e) => e,
  );
  try {
    await assertBlocked(await waiter.promise);
  } finally {
    release.resolve();
  }
  await enrolling;
  expect(await result).toBeNull();
  await expect(
    app.begin(async (tx) => {
      await scope(tx, f);
      await finalize(tx, f);
    }),
  ).rejects.toMatchObject({ code: "42501" });
}, 30000);

test("raw runtime DELETE first makes waiting enrollment reject after commit", async () => {
  const f = await fixture();
  const held = deferred<void>(),
    release = deferred<void>(),
    waiter = deferred<number>();
  const deleting = app.begin(async (tx) => {
    await tx`delete from workspace_memberships where workspace_id=${f.workspaceId} and subject_id=${f.subject}`;
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const enrolling = app.begin(async (tx) => {
    const [p] = await tx`select pg_backend_pid() as pid`;
    waiter.resolve(p!.pid);
    await scope(tx, f);
    await finalize(tx, f);
  });
  const result = enrolling.then(
    () => null,
    (e) => e,
  );
  try {
    await assertBlocked(await waiter.promise);
  } finally {
    release.resolve();
  }
  await deleting;
  expect(await result).toMatchObject({ code: "42501" });
}, 30000);

test("old tenancy-first caller fails fast instead of deadlocking against an organization-first writer", async () => {
  const f = await fixture();
  const held = deferred<void>(),
    tryFinalize = deferred<void>(),
    orgHeld = deferred<number>();
  const old = app.begin(async (tx) => {
    await scope(tx, f);
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${`session-tenancy:${f.workspaceId}`},0))`;
    held.resolve();
    await tryFinalize.promise;
    await finalize(tx, f);
  });
  const oldResult = old.then(
    () => null,
    (e) => e,
  );
  await held.promise;
  const lifecycle = app.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${f.accountId}`},0))`;
    const [p] = await tx`select pg_backend_pid() as pid`;
    orgHeld.resolve(p!.pid);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`session-tenancy:${f.workspaceId}`},0))`;
  });
  const result = lifecycle.then(
    () => null,
    (e) => e,
  );
  try {
    await assertBlocked(await orgHeld.promise);
  } finally {
    tryFinalize.resolve();
  }
  expect(await oldResult).toMatchObject({ code: "55P03" });
  expect(await result).toBeNull();
}, 30000);

test("public approval rejects organization contention before waiting on the request row", async () => {
  const f = await fixture();
  const request = await createDeviceEnrollmentRequest(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    deviceCode: crypto.randomUUID(),
    userCode: crypto.randomUUID(),
    pubkey: `ed25519:${crypto.randomUUID()}`,
    expiresAt: new Date(Date.now() + 600000),
  });
  const held = deferred<void>(),
    release = deferred<void>();
  const locking = app.begin(async (tx) => {
    await scope(tx, f);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${f.accountId}`},0))`;
    await tx`select id from device_enrollment_requests where id=${request.id} for update`;
    held.resolve();
    await release.promise;
  });
  await held.promise;
  try {
    await expect(
      client.db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout='1s'`);
        return approveDeviceEnrollmentRequest(tx as unknown as Database, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          scope: "user",
          requestId: request.id,
          approvedBySubjectId: f.subject,
          allowScreenControl: false,
          sandboxName: "contended",
        });
      }),
    ).rejects.toMatchObject({ code: "55P03" });
  } finally {
    release.resolve();
    await locking;
  }
  const [row] =
    await shared.admin`select status,enrollment_id from device_enrollment_requests where id=${request.id}`;
  expect(row).toMatchObject({ status: "pending", enrollment_id: null });
});

test("wrong-tenant finalization and direct organization membership DML remain denied", async () => {
  const f = await fixture(),
    other = await fixture();
  await expect(
    app.begin(async (tx) => {
      await scope(tx, f);
      await finalize(tx, { ...f, accountId: other.accountId });
    }),
  ).rejects.toMatchObject({ code: "42501" });
  await expect(
    (async () =>
      await app`update organization_memberships set status='active' where id=${f.membershipId}`)(),
  ).rejects.toMatchObject({ code: "42501" });
});

test("maintenance replay refuses a live declared application role before touching functions", async () => {
  const source = await readFile(
    new URL("../drizzle/0498_enrollment_membership_fence.sql", import.meta.url),
    "utf8",
  );
  const [role] = await app`select current_user as name`;
  await expect(
    shared.admin.begin(async (tx) => {
      await tx`select set_config('opengeni.migration_application_roles',${JSON.stringify([role!.name])},true)`;
      await tx.unsafe(source);
    }),
  ).rejects.toMatchObject({
    code: "55000",
    message: "enrollment membership migration requires stopped application roles",
  });
});

test("normal and rejected operations leave FORCE-RLS intact, no capability residue, and no deadlocks", async () => {
  const [posture] =
    await shared.admin`select relrowsecurity,relforcerowsecurity from pg_class where oid='organization_memberships'::regclass`;
  expect(posture).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  const [capabilities] =
    await shared.admin`select count(*)::int as count from opengeni_private.scoped_compute_capabilities`;
  expect(capabilities!.count).toBe(0);
  await shared.admin`select pg_stat_clear_snapshot()`;
  const [stats] =
    await shared.admin`select deadlocks from pg_stat_database where datname=current_database()`;
  expect(Number(stats!.deadlocks)).toBe(0);
});

test("direct workspace preparation fails before downstream rows when the organization fence is held", async () => {
  const f = await fixture();
  const held = deferred<void>(),
    release = deferred<void>();
  const locking = app.begin(async (tx) => {
    await scope(tx, f, f.actor);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${f.accountId}`},0))`;
    await tx`select workspace_id from workspace_inference_controls where workspace_id=${f.workspaceId} for update`;
    held.resolve();
    await release.promise;
  });
  await held.promise;
  try {
    await expect(
      app.begin(async (tx) => {
        await scope(tx, f, f.actor);
        await tx`set local statement_timeout='1s'`;
        await tx`select prepare_workspace_membership_removal_settlements(${tx.json({
          action: "remove",
          organizationId: f.accountId,
          workspaceId: f.workspaceId,
          actorSubjectId: f.actor,
          targetSubjectId: f.subject,
          operationId: crypto.randomUUID(),
        })}::jsonb)`;
      }),
    ).rejects.toMatchObject({ code: "55P03" });
  } finally {
    release.resolve();
    await locking;
  }
});
