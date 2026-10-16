import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const enabled = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let database: OwnerMigratedTestDatabase | null = null;
let app: postgres.Sql | null = null;
const migrations = ["0793_private_site_sessions.sql", "0794_site_ai_insights.sql"];
beforeAll(async () => {
  if (!enabled) return;
  database = await acquireOwnerMigratedTestDatabase("site-private-upgrade");
  if (!database) throw new Error("Real PostgreSQL required");
  const owner = postgres(database.ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of (await readdir(join(import.meta.dir, "../drizzle"))).filter(
      (entry) => entry.endsWith(".sql") && entry >= migrations[0]!,
    ))
      await owner`insert into schema_migrations(name) values(${name})`;
    await migrate(database.ownerUrl);
    await provisionRoles(database.adminUrl, { appPassword: database.appPassword });
  } finally {
    await owner.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  app = postgres(url.toString(), { max: 2, onnotice: () => {} });
}, 180_000);
afterAll(async () => {
  await app?.end();
  await database?.release();
});

test.skipIf(!enabled)(
  "owner-role upgrade backfills only proven Site audiences and exact costs, restores FORCE RLS, and fences old writers",
  async () => {
    const admin = database!.admin;
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const siteId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const guest = crypto.randomUUID();
    const member = crypto.randomUUID();
    const child = crypto.randomUUID();
    const legacy = crypto.randomUUID();
    const principal = "user:external_user:legacy-member";
    // Exact old storage shape; this fixture deliberately precedes the new ORM columns.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role=replica`;
      await tx`insert into managed_accounts(id,name) values(${accountId},'Upgrade')`;
      await tx`insert into workspaces(id,account_id,name) values(${workspaceId},${accountId},'Upgrade')`;
      await tx`insert into workspace_inference_controls(workspace_id,account_id) values(${workspaceId},${accountId})`;
      await tx`insert into workspace_artifacts(id,account_id,workspace_id,slug,title,current_version_id,created_by_subject_id)
      values(${siteId},${accountId},${workspaceId},'upgrade','Retained app',${versionId},'user:owner')`;
      await tx`insert into workspace_artifact_versions(id,account_id,workspace_id,artifact_id,revision,content_key,content_sha256,size_bytes,operation_key,created_by_subject_id)
      values(${versionId},${accountId},${workspaceId},${siteId},1,'retained-source',${"a".repeat(64)},10,'upgrade-source','user:owner')`;
      for (const [id, parent, root] of [
        [guest, null, guest],
        [member, null, member],
        [child, guest, guest],
        [legacy, null, legacy],
      ] as const) {
        await tx`insert into sessions(id,account_id,workspace_id,initial_message,model,sandbox_backend,sandbox_group_id,parent_session_id,root_session_id,
        nested_agent_depth,created_by_kind,created_by_subject_id,metadata,tool_policy,
        effective_max_nested_agent_depth,nested_agent_depth_policy_source,reasoning_effort,latency_mode)
        values(${id},${accountId},${workspaceId},'Private content','fixture','none',${root},${parent},${root},${parent ? 1 : 0},'service',${`site:${siteId}`},
          ${tx.json({ _opengeniSiteOrigin: { siteId, title: "Untrusted old label" } })},'{"mode":"explicit","inheritedFromSessionId":null}',3,'default','medium','standard')`;
      }
      for (const [id, viewer, kind] of [
        [guest, "guest:visit-one", "guest"],
        [member, principal, "member"],
      ] as const)
        await tx`insert into site_runtime_conversations(session_id,account_id,workspace_id,site_id,viewer_principal,viewer_kind,limit_micros,reserved_micros)
        values(${id},${accountId},${workspaceId},${siteId},${viewer},${kind},1000000,0)`;
      for (const id of [guest, child, legacy])
        await tx`insert into model_call_facts(account_id,workspace_id,session_id,turn_id,source_key,
      provider,provider_api,model,billing_path,priced_cost_micros,estimated_provider_cost_micros,occurred_at,recorded_at)
      values(${accountId},${workspaceId},${id},${crypto.randomUUID()},${id},'openai','test','fixture','opengeni_credits',13,10,now(),now())`;
      await tx`insert into credit_ledger_entries(account_id,workspace_id,type,amount_micros,source_type,source_id,idempotency_key,metadata)
      values(${accountId},${workspaceId},'model_usage_debit',-26,'model_response','retained-model-debit','retained-model-debit',${tx.json({ sessionId: guest })})`;
    });
    const owner = postgres(database!.ownerUrl, { max: 1, onnotice: () => {} });
    try {
      await owner`delete from schema_migrations where name in ${owner(migrations)}`;
    } finally {
      await owner.end();
    }
    await migrate(database!.ownerUrl);
    await provisionRoles(database!.adminUrl, { appPassword: database!.appPassword });
    const rows =
      await admin`select id,site_id,site_access_root_id,site_viewer_principal,site_owner_subject_id from sessions
    where workspace_id=${workspaceId} order by id`;
    expect(rows.find((row) => row.id === guest)).toMatchObject({
      site_id: siteId,
      site_access_root_id: guest,
      site_viewer_principal: "guest:visit-one",
      site_owner_subject_id: null,
    });
    expect(rows.find((row) => row.id === child)).toMatchObject({
      site_id: siteId,
      site_access_root_id: guest,
      site_viewer_principal: "guest:visit-one",
    });
    expect(rows.find((row) => row.id === member)).toMatchObject({
      site_owner_subject_id: "external_user:legacy-member",
      site_access_root_id: member,
    });
    expect(rows.find((row) => row.id === legacy)).toMatchObject({
      site_id: null,
      site_access_root_id: null,
    });
    const facts =
      await admin`select session_id,site_id from model_call_facts where workspace_id=${workspaceId}`;
    expect(facts.filter((row) => row.site_id === siteId)).toHaveLength(2);
    expect(facts.find((row) => row.session_id === legacy)!.site_id).toBeNull();
    const [debit] =
      await admin`select site_id,amount_micros from credit_ledger_entries where workspace_id=${workspaceId}`;
    expect(debit!.site_id).toBe(siteId);
    expect(Number(debit!.amount_micros)).toBe(-26);
    const flags = await admin`select relname,relforcerowsecurity from pg_class where relname in
    ('sessions','site_runtime_conversations','model_call_facts','credit_ledger_entries') and relnamespace='public'::regnamespace`;
    expect(flags).toHaveLength(4);
    expect(flags.every((row) => row.relforcerowsecurity)).toBe(true);

    const scoped = async <T>(
      sql: postgres.Sql,
      actor: string,
      run: (tx: postgres.TransactionSql) => Promise<T>,
      viewer = "",
    ) =>
      sql.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id',${accountId},true),set_config('opengeni.workspace_id',${workspaceId},true),
        set_config('opengeni.subject_id',${actor},true),set_config('opengeni.site_id',${siteId},true),
        set_config('opengeni.site_viewer_principal',${viewer},true),
        set_config('opengeni.session_variable_set_attachments_v1','1',true)`;
        return await run(tx);
      });
    expect(
      await scoped(
        app!,
        `site:${siteId}`,
        async (tx) => (await tx`select id from sessions where id=${guest}`).length,
        "guest:visit-one",
      ),
    ).toBe(1);
    expect(
      await scoped(
        app!,
        `site:${siteId}`,
        async (tx) => (await tx`select id from sessions where id=${guest}`).length,
        "guest:another",
      ),
    ).toBe(0);
    expect(
      await scoped(
        app!,
        "user:workspace-admin",
        async (tx) => (await tx`select id from sessions where id=${guest}`).length,
      ),
    ).toBe(0);
    // The explicit analytical predicate survives an RLS-bypassing owner too.
    expect(
      await scoped(
        admin,
        "user:workspace-admin",
        async (tx) =>
          (await tx`select id from insights_audience_sessions where id=${guest}`).length,
      ),
    ).toBe(0);
    const oldWriter = crypto.randomUUID();
    await admin`insert into site_runtime_conversations(session_id,account_id,workspace_id,site_id,viewer_principal,viewer_kind,limit_micros,reserved_micros)
    values(${oldWriter},${accountId},${workspaceId},${siteId},'guest:old-writer','guest',1000000,0)`;
    await expect(
      scoped(admin, `site:${siteId}`, async (tx) => {
        await tx`select acquire_session_tenancy_fence(${workspaceId}::uuid)`;
        await tx`select set_config('opengeni.site_session_audience_v1','',true),
          set_config('opengeni.session_activity_gate_state','open',true),
          set_config('opengeni.session_activity_gate_workspace_id',${workspaceId},true)`;
        await tx`insert into sessions(id,account_id,workspace_id,initial_message,model,sandbox_backend,sandbox_group_id,root_session_id,created_by_kind,created_by_subject_id,
      tool_policy,nested_agent_depth,effective_max_nested_agent_depth,nested_agent_depth_policy_source,reasoning_effort,latency_mode)
      values(${oldWriter},${accountId},${workspaceId},'Old writer','fixture','none',${oldWriter},${oldWriter},'service',${`site:${siteId}`},
        '{"mode":"explicit","inheritedFromSessionId":null}',0,3,'default','medium','standard')`;
      }),
    ).rejects.toMatchObject({ code: "55000", message: expect.stringContaining("Site") });
  },
  180_000,
);
