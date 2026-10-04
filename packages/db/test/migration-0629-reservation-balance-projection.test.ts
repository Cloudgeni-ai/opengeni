import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  migrate,
  provisionRoles,
  createDb,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
  createSession,
  transitionSessionVisibility,
  withSessionRlsActorContext,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

setDefaultTimeout(180_000);
let fixture: OwnerMigratedTestDatabase;
let owner: postgres.Sql;
let app: postgres.Sql;
let appUrl: string;
const account = crypto.randomUUID();
const workspace = crypto.randomUUID();
const otherWorkspace = crypto.randomUUID();
const migration = "0629_usage_reservation_balance_projection.sql";

beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("reservation-projection");
  if (!acquired) throw new Error("Real PostgreSQL owner fixture required");
  fixture = acquired;
  owner = postgres(fixture.ownerUrl, { max: 1 });
  await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
  await owner`insert into schema_migrations(name) values(${migration})`;
  await migrate(fixture.ownerUrl);
  await fixture.admin`insert into managed_accounts(id,name) values(${account},'Projection fixture')`;
  await fixture.admin`insert into workspaces(id,account_id,name) values
    (${workspace},${account},'First'),(${otherWorkspace},${account},'Second')`;
  // Existing unresolved holds must survive a non-bypass migration owner backfill.
  await insert("old", 80, workspace, new Date("2020-01-01"));
  await insert("old", -10, workspace);
  await owner`delete from schema_migrations where name=${migration}`;
  await owner`alter default privileges in schema opengeni_private grant all on tables to opengeni_app`;
  await owner`alter default privileges in schema opengeni_private grant execute on functions to opengeni_app`;
  await migrate(fixture.ownerUrl);
  await provisionRoles(fixture.adminUrl, {
    appPassword: fixture.appPassword,
    rlsStrategy: "force",
  });
  const url = new URL(fixture.ownerUrl);
  url.username = "opengeni_app";
  url.password = fixture.appPassword;
  appUrl = url.toString();
  app = postgres(appUrl, {
    max: 1,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
}, 180_000);
afterAll(async () => {
  await app?.end();
  await owner?.end();
  await fixture?.release();
}, 180_000);

async function insert(
  source: string | null,
  quantity: number,
  space = workspace,
  date = new Date(),
) {
  const [row] = await fixture.admin`insert into usage_events
    (account_id,workspace_id,event_type,quantity,unit,source_resource_type,source_resource_id,idempotency_key,occurred_at)
    values(${account},${space},'model.cost.reserved',${quantity},'usd_micros','model_call_reservation',${source},${crypto.randomUUID()},${date}) returning id`;
  return String(row!.id);
}
async function read(space: string | null) {
  return await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id',${account},true),set_config('opengeni.workspace_id',${space ?? ""},true),
      set_config('opengeni.subject_id','',true),set_config('opengeni.initiating_human_subject_id','',true)`;
    const [row] = space
      ? await tx`select opengeni_private.workspace_open_usage_reservations(${account},${space},'model.cost.reserved')::text as total`
      : await tx`select opengeni_private.account_open_usage_reservations(${account},'model.cost.reserved',now(),now())::text as total`;
    return Number(row!.total);
  });
}
async function compare() {
  for (const space of [null, workspace, otherWorkspace]) {
    const [expected] =
      await fixture.admin`select coalesce(sum(greatest(net,0)),0)::text as total from
      (select sum(quantity) as net from usage_events where account_id=${account}
       and (${space}::uuid is null or workspace_id=${space}) and event_type='model.cost.reserved' group by source_resource_id) grouped`;
    expect(await read(space)).toBe(Number(expected!.total));
  }
}

test("non-bypass backfill, cross-workspace offsets, financial mutation, deletes and rollback retain exact ledger net", async () => {
  const [role] =
    await fixture.admin`select rolsuper,rolbypassrls from pg_roles where rolname=${fixture.ownerRole}`;
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
  expect(await read(null)).toBe(70);
  const changed = await insert("offset", 20);
  const release = await insert("offset", -35, otherWorkspace);
  await insert(null, 5);
  await insert("null", 7);
  await compare();
  await fixture.admin`update usage_events set quantity=40 where id=${changed}`;
  await compare();
  await fixture.admin`update usage_events set source_resource_id='new-source',workspace_id=${workspace} where id=${release}`;
  await compare();
  await fixture.admin`delete from usage_events where id=${changed}`;
  await compare();
  const before = await read(null);
  await expect(
    fixture.admin.begin(async (tx) => {
      await tx`update usage_events set quantity=quantity+100 where account_id=${account}`;
      throw new Error("rollback fixture");
    }),
  ).rejects.toThrow("rollback fixture");
  expect(await read(null)).toBe(before);
  await compare();
});

test("projection is owner-only after provisioning and scoped reads refuse tenant mismatch", async () => {
  const [posture] =
    await fixture.admin`select c.relrowsecurity as enabled,c.relforcerowsecurity as forced,
    has_table_privilege('opengeni_app',c.oid,'SELECT') as readable,
    has_function_privilege('opengeni_app','opengeni_private.adjust_usage_reservation_balance(uuid,uuid,uuid,text,text,numeric)','EXECUTE') as writable,
    has_function_privilege('opengeni_app','opengeni_private.project_usage_reservation_balance()','EXECUTE') as trigger
    from pg_class c where c.oid='opengeni_private.usage_reservation_balances'::regclass`;
  expect(posture).toMatchObject({
    enabled: true,
    forced: true,
    readable: false,
    writable: false,
    trigger: false,
  });
  await expect(
    (async () =>
      await app`select opengeni_private.workspace_open_usage_reservations(${account},${workspace},'model.cost.reserved')`)(),
  ).rejects.toThrow("exact tenant context");
});

test("settled history leaves only unresolved sources in the admission index", async () => {
  await fixture.admin`insert into usage_events(account_id,workspace_id,event_type,quantity,unit,source_resource_type,source_resource_id,idempotency_key,occurred_at)
    select ${account},${workspace},'model.cost.reserved',sign*10,'usd_micros','model_call_reservation',
      'completed:'||n::text,'completed:'||n::text||':'||sign::text,now() from generate_series(1,10000) n cross join (values(1),(-1)) signs(sign)`;
  await fixture.admin`analyze opengeni_private.usage_reservation_balances`;
  await compare();
  const plan =
    await fixture.admin`explain (analyze, buffers, format json) select sum(greatest(net_quantity,0))
    from opengeni_private.usage_reservation_balances where account_id=${account} and scope_kind='account'
    and scope_id=${account} and event_type='model.cost.reserved' and net_quantity<>0`;
  const root = plan[0]!["QUERY PLAN"][0].Plan;
  const nodes: Array<Record<string, any>> = [];
  function walk(node: Record<string, any>) {
    nodes.push(node);
    for (const child of node.Plans ?? []) walk(child);
  }
  walk(root);
  expect(nodes.some((node) => node["Index Name"] === "usage_reservation_balances_open_idx")).toBe(
    true,
  );
  const scanned = nodes.find(
    (node) => node["Index Name"] === "usage_reservation_balances_open_idx",
  )!;
  expect(scanned["Actual Rows"]).toBeLessThan(10);
});

test("null-to-private attribution and cross-session release preserve visibility before netting", async () => {
  const client = createDb(appUrl, { max: 1 });
  try {
    const user = `projection-owner-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId: user,
      email: `${user}@example.test`,
      name: "Projection visibility",
    });
    const grant = access.workspaceGrants[0]!;
    await fixture.admin`insert into session_tenancy_activations(account_id,activation_version,inventory_digest,parity_digest,activated_by)
      values(${grant.accountId},1,${"0".repeat(64)},${"1".repeat(64)},'database-test') on conflict(account_id) do nothing`;
    const settings = await getOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: grant.subjectId,
    });
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: grant.accountId,
      actorSubjectId: grant.subjectId,
      enabled: true,
      expectedVersion: settings.version,
      operationId: crypto.randomUUID(),
    });
    const session = await withSessionRlsActorContext({ subjectId: grant.subjectId }, () =>
      createSession(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        initialMessage: "private projection fixture",
        resources: [],
        metadata: {},
        model: "fixture",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: grant.subjectId },
        createdByContext: {},
      }),
    );
    await transitionSessionVisibility(client.db, {
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      actorSubjectId: grant.subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: crypto.randomUUID(),
    });
    const source = crypto.randomUUID();
    const [hold] =
      await fixture.admin`insert into usage_events(account_id,workspace_id,event_type,quantity,unit,source_resource_id,idempotency_key,occurred_at)
      values(${grant.accountId},${grant.workspaceId},'model.cost.reserved',80,'usd_micros',${source},${source},now()) returning id`;
    const query = async (subject: string) =>
      await app.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id',${grant.accountId},true),set_config('opengeni.workspace_id',${grant.workspaceId!},true),
        set_config('opengeni.subject_id',${subject},true),set_config('opengeni.initiating_human_subject_id','',true)`;
        const [row] =
          await tx`select opengeni_private.workspace_open_usage_reservations(${grant.accountId},${grant.workspaceId},'model.cost.reserved')::text as actual,
        (select coalesce(sum(greatest(net,0)),0) from (select sum(quantity) as net from usage_events where account_id=${grant.accountId}
          and workspace_id=${grant.workspaceId} and event_type='model.cost.reserved' group by source_resource_id) grouped)::text as expected`;
        expect(row!.actual).toBe(row!.expected);
        return Number(row!.actual);
      });
    expect(await query("user:unrelated")).toBe(80);
    await fixture.admin`update usage_events set session_id=${session.id} where id=${hold!.id}`;
    expect(await query("user:unrelated")).toBe(0);
    expect(await query(grant.subjectId)).toBe(80);
    await fixture.admin`insert into usage_events(account_id,workspace_id,event_type,quantity,unit,source_resource_id,idempotency_key,occurred_at)
      values(${grant.accountId},${grant.workspaceId},'model.cost.reserved',-30,'usd_micros',${source},${source + ":release"},now())`;
    expect(await query(grant.subjectId)).toBe(50);
    expect(await query("user:unrelated")).toBe(0);
    await fixture.admin`delete from usage_events where id=${hold!.id}`;
    expect(await query(grant.subjectId)).toBe(0);
  } finally {
    await client.close();
  }
});
