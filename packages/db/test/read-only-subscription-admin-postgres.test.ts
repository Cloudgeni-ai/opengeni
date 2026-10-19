import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  createDb,
  createSession,
  migrate,
  provisionRoles,
  type DbClient,
  getWorkspaceAllowanceState,
  readSessionUsageLimit,
  maintainWorkspaceAllowances,
  maintainSessionUsageLimits,
  setWorkspaceAllowance,
  grantWorkspaceCredits,
  bootstrapWorkspace,
} from "../src";
import { rawRows } from "../src/database";

let fixture: NonNullable<Awaited<ReturnType<typeof acquireOwnerMigratedTestDatabase>>>;
let client: DbClient;
const accountId = crypto.randomUUID();
const otherAccountId = crypto.randomUUID();
const subject = `user:probe-${crypto.randomUUID()}`;
const membershipId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
let sessionId: string;

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("readonly-subscription-admin");
  if (!acquired) throw new Error("PostgreSQL required");
  fixture = acquired;
  await migrate(fixture.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
  await provisionRoles(fixture.adminUrl, {
    appRole: "opengeni_app",
    appPassword: fixture.appPassword,
    rlsStrategy: "force",
  });
  const url = new URL(fixture.adminUrl);
  url.username = "opengeni_app";
  url.password = fixture.appPassword;
  client = createDb(url.toString());
  await fixture.admin`insert into managed_accounts(id,name) values(${accountId},'Admin probe'),(${otherAccountId},'Other')`;
  await fixture.admin`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Personal')`;
  await fixture.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${workspaceId},${accountId})`;
  await fixture.admin`insert into organization_memberships(id,account_id,subject_id,personal_workspace_id,role,status)
    values(${membershipId},${accountId},${subject},${workspaceId},'owner','active')`;
  await fixture.admin`insert into subscription_connections(account_id,provider,credential_encrypted,ownership,scope_kind)
    values(${accountId},'codex','synthetic','shared','organization')`;
  sessionId = (
    await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "Read fixture",
      model: "test",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: subject },
    })
  ).id;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await fixture?.release();
});

async function probe(contextAccount = accountId, targetAccount = accountId, actor = subject) {
  return client.db.transaction(
    async (tx) => {
      await tx.execute(
        sql`select set_config('opengeni.account_id',${contextAccount},true),set_config('opengeni.subject_id',${actor},true)`,
      );
      const [result] = await rawRows<{ allowed: boolean; xid: string | null }>(
        tx,
        sql`select opengeni_private.subscription_organization_admin(${targetAccount}::uuid) as allowed,
        pg_current_xact_id_if_assigned()::text as xid`,
      );
      return result!;
    },
    { accessMode: "read only" },
  );
}

test("admin probe and subscription RLS SELECT need no capability write or transaction ID", async () => {
  expect(await probe()).toEqual({ allowed: true, xid: null });
  await client.db.transaction(
    async (tx) => {
      await tx.execute(
        sql`select set_config('opengeni.account_id',${accountId},true),set_config('opengeni.subject_id',${subject},true)`,
      );
      const rows = await rawRows<{ id: string }>(
        tx,
        sql`select id from subscription_connections where account_id=${accountId}::uuid`,
      );
      expect(rows).toHaveLength(1);
      const [transaction] = await rawRows<{ xid: string | null }>(
        tx,
        sql`select pg_current_xact_id_if_assigned()::text as xid`,
      );
      expect(transaction!.xid).toBeNull();
    },
    { accessMode: "read only" },
  );
  await expect(
    Promise.resolve(client.db.execute(sql`select * from organization_memberships`)),
  ).rejects.toThrow();
  await expect(
    Promise.resolve(
      client.db.execute(
        sql`insert into opengeni_private.subscription_runtime_capabilities default values`,
      ),
    ),
  ).rejects.toThrow();
});

test("wrong account, absent actor, changed role and revocation remain live", async () => {
  expect((await probe(otherAccountId)).allowed).toBe(false);
  expect((await probe(accountId, otherAccountId)).allowed).toBe(false);
  expect((await probe(accountId, accountId, "")).allowed).toBe(false);
  await fixture.admin`update organization_memberships set role='member' where id=${membershipId}`;
  expect((await probe()).allowed).toBe(false);
  await fixture.admin`update organization_memberships set role='admin' where id=${membershipId}`;
  expect((await probe()).allowed).toBe(true);
  await fixture.admin`update organization_memberships set status='revoked',revoked_at=now() where id=${membershipId}`;
  expect((await probe()).allowed).toBe(false);
});

test("existing allowance state and session limit read without transaction IDs", async () => {
  await client.db.transaction(
    async (tx) => {
      expect(await getWorkspaceAllowanceState(tx, { accountId, workspaceId })).toEqual({
        version: 0,
        config: null,
      });
      const limit = await readSessionUsageLimit(tx, { accountId, workspaceId, sessionId });
      expect(limit).not.toBeNull();
      const [row] = await rawRows<{ xid: string | null }>(
        tx,
        sql`select pg_current_xact_id_if_assigned()::text as xid`,
      );
      expect(row!.xid).toBeNull();
    },
    { accessMode: "read only" },
  );
});

test("scoped owner reads grant neither counter writes nor cross-tenant reads", async () => {
  const owner = postgres(fixture.ownerUrl, { max: 1 });
  try {
    await owner.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id',${accountId},true),set_config('opengeni.workspace_id',${workspaceId},true)`;
      expect(
        await tx`select root_session_id from opengeni_private.session_usage_limit_roots`,
      ).toHaveLength(1);
      expect(
        await tx`update opengeni_private.session_usage_limit_roots set known_micros=999 returning root_session_id`,
      ).toHaveLength(0);
      await tx`select set_config('opengeni.account_id',${otherAccountId},true)`;
      expect(
        await tx`select root_session_id from opengeni_private.session_usage_limit_roots`,
      ).toHaveLength(0);
    });
  } finally {
    await owner.end();
  }
});

test("not-due configured maintenance performs no writes under a strict owner", async () => {
  await fixture.admin`update organization_memberships set status='active',revoked_at=null where id=${membershipId}`;
  await setWorkspaceAllowance(client.db, {
    accountId,
    workspaceId,
    actorSubjectId: subject,
    includedCredits: 100,
    period: "monthly",
    expectedVersion: 0,
  });
  expect(await maintainWorkspaceAllowances(client.db)).toBe(1);
  const [scheduled] = await fixture.admin`select maintenance_next_at=active_end_at as at_boundary
    from opengeni_private.workspace_usage_allowances where workspace_id=${workspaceId}`;
  expect(scheduled!.at_boundary).toBe(true);
  await client.db.transaction(
    async (tx) => {
      expect(await maintainWorkspaceAllowances(tx)).toBe(0);
      expect((await maintainSessionUsageLimits(tx)).processed).toBe(0);
      const [row] = await rawRows<{ xid: string | null }>(
        tx,
        sql`select pg_current_xact_id_if_assigned()::text as xid`,
      );
      expect(row!.xid).toBeNull();
    },
    { accessMode: "read only" },
  );
  await expect(
    Promise.resolve(client.db.execute(sql`select * from opengeni_private.usage_maintenance_due`)),
  ).rejects.toThrow();
  await fixture.admin`update opengeni_private.workspace_usage_allowances set maintenance_next_at=now()-interval '1 second' where workspace_id=${workspaceId}`;
  expect(await maintainWorkspaceAllowances(client.db)).toBe(1);
});

test("membership facts re-arm maintenance, irrelevant edits and rolled-back changes do not", async () => {
  const pending = async () =>
    (
      await fixture.admin`select exists(select 1 from opengeni_private.usage_maintenance_due
      where kind='allowance' and workspace_id=${workspaceId} and due_at<=clock_timestamp())
      or exists(select 1 from opengeni_private.usage_allowance_membership_changes c
        join opengeni_private.usage_maintenance_due p using(data_schema,account_id)
        where p.workspace_id=${workspaceId} and p.membership_ready and c.revision>p.seen_membership_revision) as due`
    )[0]!.due;
  expect(await pending()).toBe(false);
  await fixture.admin`update organization_memberships set role='member' where id=${membershipId}`;
  expect(await pending()).toBe(false);
  await fixture.admin`update organization_memberships set status='revoked',revoked_at=now() where id=${membershipId}`;
  expect(await pending()).toBe(true);
  expect(await maintainWorkspaceAllowances(client.db)).toBe(1);
  await fixture.admin`update organization_memberships set status='active',revoked_at=null,role='owner' where id=${membershipId}`;
  expect(await pending()).toBe(true);
  expect(await maintainWorkspaceAllowances(client.db)).toBe(1);
  await expect(
    fixture.admin.begin(async (tx) => {
      await tx`update organization_memberships set status='revoked',revoked_at=now() where id=${membershipId}`;
      throw new Error("rollback membership fixture");
    }),
  ).rejects.toThrow("rollback membership fixture");
  expect(await pending()).toBe(false);
});

test("nonrenewing policies sleep until work or an unspent grant expiry", async () => {
  await setWorkspaceAllowance(client.db, {
    accountId,
    workspaceId,
    actorSubjectId: subject,
    includedCredits: 100,
    period: "none",
    expectedVersion: 1,
  });
  expect(await maintainWorkspaceAllowances(client.db)).toBe(1);
  expect(
    await fixture.admin`select * from opengeni_private.usage_maintenance_due
    where kind='allowance' and workspace_id=${workspaceId} and due_at is not null`,
  ).toHaveLength(0);
  await client.db.transaction(
    async (tx) => {
      expect(await maintainWorkspaceAllowances(tx)).toBe(0);
    },
    { accessMode: "read only" },
  );
  const expiresAt = new Date(Date.now() + 3600000).toISOString();
  await grantWorkspaceCredits(client.db, {
    accountId,
    workspaceId,
    actorSubjectId: subject,
    operationId: crypto.randomUUID(),
    credits: 10,
    expiresAt,
  });
  expect(await maintainWorkspaceAllowances(client.db)).toBe(1);
  const [due] = await fixture.admin`select due_at=${expiresAt}::timestamptz as at_expiry
    from opengeni_private.usage_maintenance_due where kind='allowance' and workspace_id=${workspaceId}`;
  expect(due!.at_expiry).toBe(true);
});

test("legacy initialization retains its write capability and subsequent reads need none", async () => {
  await fixture.admin`delete from opengeni_private.session_usage_limit_roots where root_session_id=${sessionId}`;
  expect(
    await readSessionUsageLimit(client.db, { accountId, workspaceId, sessionId }),
  ).not.toBeNull();
  const rows =
    await fixture.admin`select history_state from opengeni_private.session_usage_limit_roots where root_session_id=${sessionId}`;
  expect(rows[0]!.history_state).toBe("preparing");
  expect(
    await fixture.admin`select * from opengeni_private.session_usage_limit_capabilities`,
  ).toHaveLength(0);
  await client.db.transaction(
    async (tx) => {
      expect(await readSessionUsageLimit(tx, { accountId, workspaceId, sessionId })).not.toBeNull();
    },
    { accessMode: "read only" },
  );
});

test("membership changes never wait on a maintenance-held allowance row and cannot be lost", async () => {
  const gate = 918473;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await fixture.admin
    .unsafe(`create function allowance_test_gate() returns trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(${gate}); return null; end $$;
    create trigger allowance_test_gate after update of membership_revision
      on opengeni_private.workspace_usage_allowances for each row execute function allowance_test_gate();`);
  const holder = fixture.admin.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${gate})`;
    held.resolve();
    await release.promise;
  });
  let maintenance: Promise<number> | undefined;
  let membershipWrite: Promise<unknown> | undefined;
  try {
    await held.promise;
    await fixture.admin`update organization_memberships set status='revoked',revoked_at=now() where id=${membershipId}`;
    maintenance = maintainWorkspaceAllowances(client.db);
    const deadline = Date.now() + 3000;
    for (;;) {
      const [blocked] = await fixture.admin`select exists(select 1 from pg_locks
        where locktype='advisory' and objid=${gate} and not granted) as waiting`;
      if (blocked!.waiting) break;
      if (Date.now() > deadline) throw new Error("Maintenance did not reach test gate");
      await Bun.sleep(10);
    }
    // If the membership trigger took an allowance row, this statement would
    // wait behind the maintenance transaction that is held at the gate.
    const markerHeld = Promise.withResolvers<void>();
    membershipWrite = fixture.admin.begin(async (tx) => {
      await tx`set local statement_timeout='2s'`;
      await tx`update organization_memberships set status='active',revoked_at=null where id=${membershipId}`;
      markerHeld.resolve();
      // Usage settlement in the same transaction needs this existing fence.
      // Maintenance must finish without trying to lock our account marker.
      await tx`select pg_advisory_xact_lock(hashtextextended('usage-allowance:'||${workspaceId}::text,0))`;
    });
    await markerHeld.promise;
  } finally {
    release.resolve();
    await holder;
    await maintenance;
    await membershipWrite;
    await fixture.admin`drop trigger allowance_test_gate on opengeni_private.workspace_usage_allowances`;
    await fixture.admin`drop function allowance_test_gate()`;
  }
  const [marker] = await fixture.admin`select c.revision>p.seen_membership_revision as pending
    from opengeni_private.usage_allowance_membership_changes c
    join opengeni_private.usage_maintenance_due p using(data_schema,account_id)
    where p.workspace_id=${workspaceId} and p.kind='allowance'`;
  expect(marker!.pending).toBe(true);
  expect(await maintainWorkspaceAllowances(client.db)).toBe(1);
  expect(await maintainWorkspaceAllowances(client.db)).toBe(0);
});

test("membership paging checkpoints its revision and restarts for a new earlier member", async () => {
  const pageWorkspace = crypto.randomUUID();
  await fixture.admin`insert into workspaces(id,account_id,name) values(${pageWorkspace},${accountId},'Paged')`;
  await fixture.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${pageWorkspace},${accountId})`;
  const addMember = async (id: string) => {
    const personal = crypto.randomUUID();
    await fixture.admin`insert into workspaces(id,account_id,name) values(${personal},${accountId},'Personal')`;
    await fixture.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
      values(${accountId},${id},'member','active',${personal})`;
    await fixture.admin`insert into workspace_memberships(account_id,workspace_id,subject_id)
      values(${accountId},${pageWorkspace},${id})`;
  };
  await addMember("user:paging-b");
  await addMember("user:paging-c");
  await addMember("user:paging-d");
  await setWorkspaceAllowance(client.db, {
    accountId,
    workspaceId: pageWorkspace,
    actorSubjectId: subject,
    includedCredits: 100,
    period: "none",
    expectedVersion: 0,
  });
  await maintainWorkspaceAllowances(client.db, { memberLimit: 1 });
  const [first] =
    await fixture.admin`select maintenance_cursor,membership_revision,maintenance_membership_revision
    from opengeni_private.workspace_usage_allowances where workspace_id=${pageWorkspace}`;
  expect(first!.maintenance_cursor).toBe("user:paging-b");
  expect(Number(first!.membership_revision)).toBeLessThan(
    Number(first!.maintenance_membership_revision),
  );
  await addMember("user:paging-a");
  await maintainWorkspaceAllowances(client.db, { memberLimit: 1 });
  const [restarted] = await fixture.admin`select maintenance_cursor
    from opengeni_private.workspace_usage_allowances where workspace_id=${pageWorkspace}`;
  expect(restarted!.maintenance_cursor).toBe("user:paging-a");
  for (let i = 0; i < 3; i++) {
    await fixture.admin`update opengeni_private.workspace_usage_allowances set maintenance_next_at=now()-interval '1 second'
      where workspace_id=${pageWorkspace}`;
    await maintainWorkspaceAllowances(client.db, { memberLimit: 1 });
  }
  const [complete] =
    await fixture.admin`select maintenance_cursor,membership_revision=maintenance_membership_revision as caught_up
    from opengeni_private.workspace_usage_allowances where workspace_id=${pageWorkspace}`;
  expect(complete!.maintenance_cursor).toBeNull();
  expect(complete!.caught_up).toBe(true);
  await client.db.transaction(
    async (tx) => {
      expect(await maintainWorkspaceAllowances(tx)).toBe(0);
    },
    { accessMode: "read only" },
  );
});

test("account changes drain across bounded batches without starving later workspaces", async () => {
  for (let i = 0; i < 3; i++) {
    const id = crypto.randomUUID();
    await fixture.admin`insert into workspaces(id,account_id,name) values(${id},${accountId},'Batch workspace')`;
    await fixture.admin`insert into workspace_inference_controls(workspace_id,account_id) values(${id},${accountId})`;
    await setWorkspaceAllowance(client.db, {
      accountId,
      workspaceId: id,
      actorSubjectId: subject,
      includedCredits: 100,
      period: "monthly",
      expectedVersion: 0,
    });
  }
  await maintainWorkspaceAllowances(client.db);
  await fixture.admin`update organization_memberships set status='revoked',revoked_at=now() where id=${membershipId}`;
  let processed = 0;
  for (let i = 0; i < 5; i++)
    processed += await maintainWorkspaceAllowances(client.db, { limit: 1 });
  expect(processed).toBe(5);
  const [marker] =
    await fixture.admin`select bool_and(c.revision=p.seen_membership_revision) as settled
    from opengeni_private.usage_allowance_membership_changes c
    join opengeni_private.usage_maintenance_due p using(data_schema,account_id)
    where c.account_id=${accountId} and p.kind='allowance'`;
  expect(marker!.settled).toBe(true);
  await client.db.transaction(
    async (tx) => {
      expect(await maintainWorkspaceAllowances(tx)).toBe(0);
    },
    { accessMode: "read only" },
  );
});

test("all eligibility sources re-arm their account and account deletion cleans the marker", async () => {
  const account = crypto.randomUUID(),
    workspace = crypto.randomUUID(),
    member = crypto.randomUUID();
  const identity = crypto.randomUUID(),
    actor = `external_user:${identity}`;
  await fixture.admin`insert into managed_accounts(id,name) values(${account},'Eligibility')`;
  await fixture.admin`insert into workspaces(id,account_id,name) values(${workspace},${account},'Personal')`;
  await fixture.admin`insert into organization_memberships(id,account_id,subject_id,personal_workspace_id,role,status)
    values(${member},${account},${actor},${workspace},'member','active')`;
  const revision = async () =>
    Number(
      (
        await fixture.admin`select revision from opengeni_private.usage_allowance_membership_changes where account_id=${account}`
      )[0]!.revision,
    );
  let before = await revision();
  await fixture.admin`insert into workspace_memberships(account_id,workspace_id,subject_id) values(${account},${workspace},${actor})`;
  expect(await revision()).toBeGreaterThan(before);
  before = await revision();
  await fixture.admin`insert into external_identities(id,account_id,source,external_id,subject_id,organization_membership_id,personal_workspace_id)
    values(${identity},${account},'fixture','actor',${actor},${member},${workspace})`;
  expect(await revision()).toBeGreaterThan(before);
  before = await revision();
  await fixture.admin`update external_identities set status='revoked' where id=${identity}`;
  expect(await revision()).toBeGreaterThan(before);
  before = await revision();
  await fixture.admin`update managed_accounts set external_source='opengeni:local',external_id='default' where id=${account}`;
  expect(await revision()).toBeGreaterThan(before);
  before = await revision();
  await fixture.admin`update workspace_memberships set subject_label='Changed label' where account_id=${account}`;
  expect(await revision()).toBe(before);
  await fixture.admin`delete from external_identities where account_id=${account}`;
  await fixture.admin`delete from managed_accounts where id=${account}`;
  expect(
    await fixture.admin`select * from opengeni_private.usage_allowance_membership_changes where account_id=${account}`,
  ).toHaveLength(0);
});

test("upgrade backfills configured policies and pending imports under a non-bypass owner", async () => {
  const prior = await acquireOwnerMigratedTestDatabase("readonly-probe-upgrade");
  if (!prior) throw new Error("PostgreSQL required");
  const owner = postgres(prior.ownerUrl, { max: 1 });
  let app: DbClient | undefined;
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    await owner`insert into schema_migrations(name) values('0847_read_only_runtime_probes.sql')`;
    await migrate(prior.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
    await provisionRoles(prior.adminUrl, {
      appRole: "opengeni_app",
      appPassword: prior.appPassword,
      rlsStrategy: "force",
    });
    const url = new URL(prior.adminUrl);
    url.username = "opengeni_app";
    url.password = prior.appPassword;
    app = createDb(url.toString());
    const actor = `user:upgrade-${crypto.randomUUID()}`;
    const access = await bootstrapWorkspace(app.db, {
      accountExternalSource: "upgrade-test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Upgrade",
      workspaceExternalSource: "upgrade-test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Upgrade",
      subjectId: actor,
    });
    const grant = access.workspaceGrants[0]!;
    const scope = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      actorSubjectId: actor,
    };
    const personal = crypto.randomUUID();
    await prior.admin`insert into workspaces(id,account_id,name) values(${personal},${scope.accountId},'Personal')`;
    await prior.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
      values(${scope.accountId},${actor},'owner','active',${personal})`;
    await setWorkspaceAllowance(app.db, {
      ...scope,
      includedCredits: 100,
      period: "monthly",
      expectedVersion: 0,
    });
    const session = await createSession(app.db, {
      ...scope,
      initialMessage: "Import fixture",
      model: "test",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: actor },
    });
    const future = new Date(Date.now() + 3600000).toISOString();
    await prior.admin`update opengeni_private.workspace_usage_allowances set maintenance_next_at=${future} where workspace_id=${scope.workspaceId}`;
    await prior.admin`update opengeni_private.session_usage_limit_roots set history_state='preparing',import_next_at=${future}
      where root_session_id=${session.id}`;
    await owner`delete from schema_migrations where name='0847_read_only_runtime_probes.sql'`;
    await migrate(prior.ownerUrl, undefined, { applicationDatabaseRoles: ["opengeni_app"] });
    const projections =
      await prior.admin`select kind,due_at=${future}::timestamptz as exact_time from opengeni_private.usage_maintenance_due
      where workspace_id=${scope.workspaceId} order by kind`;
    expect(projections.map((row) => row.kind)).toEqual(["allowance", "session_import"]);
    expect(projections.every((row) => row.exact_time)).toBe(true);
    await app.db.transaction(
      async (tx) => {
        expect(await maintainWorkspaceAllowances(tx)).toBe(0);
        await maintainSessionUsageLimits(tx);
        const [state] = await rawRows<{ xid: string | null }>(
          tx,
          sql`select pg_current_xact_id_if_assigned()::text as xid`,
        );
        expect(state!.xid).toBeNull();
      },
      { accessMode: "read only" },
    );
  } finally {
    await app?.close();
    await owner.end();
    await prior.release();
  }
}, 180_000);
