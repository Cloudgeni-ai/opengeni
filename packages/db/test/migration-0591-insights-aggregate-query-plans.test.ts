import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";

import { createDb, createSession, ensureManagedAccessForUser } from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

setDefaultTimeout(180_000);
let shared: OwnerMigratedTestDatabase | null = null;
let appUrl: string | null = null;
beforeAll(async () => {
  shared = await acquireOwnerMigratedTestDatabase("insights-aggregate-initplans");
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  await migrate(shared.ownerUrl, undefined, {
    applicationDatabaseRoles: ["opengeni_app"],
    preinstalledVector: true,
  });
  await provisionRoles(shared.adminUrl, { appPassword: shared.appPassword, rlsStrategy: "force" });
  const applicationUrl = new URL(shared.ownerUrl);
  applicationUrl.username = "opengeni_app";
  applicationUrl.password = shared.appPassword;
  appUrl = applicationUrl.toString();
}, 180_000);
afterAll(async () => {
  await shared?.release();
}, 180_000);

type PlanNode = {
  "Parent Relationship"?: string;
  "Actual Loops"?: number;
  Output?: string[];
  Plans?: PlanNode[];
};
function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

test("0591 retains write predicates and runs exact owner capability checks once per SELECT", async () => {
  if (!shared || !appUrl) throw new Error("PostgreSQL test database unavailable");
  const client = createDb(appUrl, { max: 1, rlsStrategy: "force" });
  const app = postgres(appUrl, { max: 1 });
  try {
    const userId = `insights-plan-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Insights initPlan fixture",
    });
    const grant = access.workspaceGrants[0]!;
    await shared.admin`
      insert into model_call_facts (
        account_id, workspace_id, session_id, turn_id, source_key, provider, provider_api,
        model, billing_path, total_tokens, occurred_at
      ) select ${grant.accountId}, ${grant.workspaceId}, gen_random_uuid(), gen_random_uuid(),
        ${`insights-plan-${crypto.randomUUID()}-`} || n, 'openai', 'responses', 'plan', 'external', 3, now()
      from generate_series(1, 32) n`;
    const [owner] = await shared.admin<
      Array<{ name: string; superuser: boolean; bypass: boolean }>
    >`
      select role.rolname as name, role.rolsuper as superuser, role.rolbypassrls as bypass
      from pg_class relation join pg_roles role on role.oid = relation.relowner
      where relation.oid = 'model_call_facts'::regclass`;
    expect(owner).toBeDefined();
    expect(owner!.superuser).toBe(false);
    expect(owner!.bypass).toBe(false);
    await shared.admin.begin(async (tx) => {
      await tx`set local role ${tx(owner!.name)}`;
      await tx`select set_config('opengeni.account_id', ${grant.accountId}, true),
        set_config('opengeni.workspace_id', ${grant.workspaceId!}, true),
        set_config('opengeni.subject_id', ${`user:${userId}`}, true),
        set_config('opengeni.initiating_human_subject_id', '', true)`;
      await tx`insert into opengeni_private.insights_fact_read_runtime_capabilities
        (backend_pid, transaction_id, capability_kind, account_id, workspace_id, subject_id)
        values (pg_backend_pid(), pg_current_xact_id(), 'model_call_facts',
          ${grant.accountId}, ${grant.workspaceId}, ${`user:${userId}`})`;
      const [result] = await tx<Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>>`
        explain (analyze, verbose, format json) select count(*) from model_call_facts
        where account_id = ${grant.accountId} and workspace_id = ${grant.workspaceId}`;
      const checks = nodes(result!["QUERY PLAN"][0]!.Plan).filter(
        (node) =>
          node["Parent Relationship"] === "InitPlan" &&
          node.Output?.some((output) =>
            output.includes("insights_fact_read_policy_capability_active"),
          ),
      );
      expect(checks).toHaveLength(1);
      expect(checks[0]!["Actual Loops"]).toBe(1);
      const [count] = await tx<Array<{ calls: number }>>`
        select count(*)::int as calls from model_call_facts
        where account_id = ${grant.accountId} and workspace_id = ${grant.workspaceId}`;
      expect(count?.calls).toBe(32);
      await tx`delete from opengeni_private.insights_fact_read_runtime_capabilities
        where backend_pid = pg_backend_pid() and transaction_id = pg_current_xact_id_if_assigned()`;
    });
    await app.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${grant.accountId}, true),
        set_config('opengeni.workspace_id', ${grant.workspaceId!}, true),
        set_config('opengeni.subject_id', ${`user:${userId}`}, true),
        set_config('opengeni.insights_fact_read_capability', 'model_call_facts', true)`;
      const [ordinary] = await tx<Array<{ active: boolean; calls: number }>>`
        select insights_fact_read_policy_capability_active(
          ${owner!.name}, ${owner!.name}, 'model_call_facts') as active,
          (select count(*)::int from model_call_facts where account_id = ${grant.accountId}
            and workspace_id = ${grant.workspaceId}) as calls`;
      expect(ordinary).toEqual({ active: false, calls: 0 });
    });
    const writes = await shared.admin<Array<{ expression: string }>>`
      select coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '') as expression
      from pg_policy where polrelid in ('model_call_facts'::regclass, 'usage_events'::regclass)
        and polname in ('session_visibility_insert_isolation', 'session_visibility_update_isolation',
          'session_visibility_delete_isolation')`;
    expect(writes).toHaveLength(6);
    for (const write of writes) {
      expect(write.expression).toContain("session_reference_visible");
      expect(write.expression).not.toContain("policy_capability_active");
    }
    const [leftover] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from opengeni_private.insights_fact_read_runtime_capabilities`;
    expect(leftover?.count).toBe(0);
  } finally {
    await client.close();
    await app.end();
  }
});

test("0591 aggregate source retains complete totals, private owner sums and decimal event counts", async () => {
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  const [routine] = await shared.admin<Array<{ definition: string }>>`
    select pg_get_functiondef('opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)'::regprocedure) as definition`;
  expect(routine?.definition).toContain("WITH visible AS NOT MATERIALIZED");
  expect(routine?.definition).not.toContain("LEFT JOIN visible_sessions");
  expect(routine?.definition).toContain("usage_by_session AS MATERIALIZED");
  // 0593 restricts only the attribution source before grouping. The main
  // all-row totals source still has no private or visible session join.
  const definition = routine!.definition;
  const privateInventory = definition.indexOf("WITH private_sessions AS MATERIALIZED");
  const privateGroups = definition.indexOf("usage_by_session AS MATERIALIZED");
  const ownerGroups = definition.indexOf("owner_totals AS (");
  expect(privateInventory).toBeGreaterThan(0);
  expect(privateGroups).toBeGreaterThan(privateInventory);
  expect(ownerGroups).toBeGreaterThan(privateGroups);
  expect(definition.slice(privateGroups, ownerGroups)).toContain(
    "JOIN private_sessions matched_session ON matched_session.id = usage_row.session_id",
  );
  expect(definition.slice(privateGroups, ownerGroups)).toContain(
    "matched_session.workspace_id = usage_row.workspace_id",
  );
  expect(definition.slice(0, privateInventory)).not.toContain("JOIN private_sessions");
  expect(routine?.definition).toContain("sum(usage_row.event_count) AS event_count");
  expect(routine?.definition).toContain("'eventCount', event_count::text");
  expect(routine?.definition).toContain("'privateChatsTruncated'");
});

test("0594 hash-safe organization reads retain missing-session amounts and restore caller settings", async () => {
  if (!shared || !appUrl) throw new Error("PostgreSQL test database unavailable");
  const client = createDb(appUrl, { max: 1, rlsStrategy: "force" });
  const app = postgres(appUrl, {
    max: 1,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  try {
    const userId = `organization-hash-plan-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Organization hash plan fixture",
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "Deleted ledger plan fixture",
      resources: [],
      metadata: {},
      model: "plan-fixture",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: `user:${userId}` },
      createdByContext: {},
    });
    await shared.admin`insert into usage_events
      (account_id, workspace_id, session_id, event_type, quantity, unit, idempotency_key, occurred_at)
      values (${grant.accountId}, ${grant.workspaceId}, ${session.id},
        'model.cost', 123, 'usd_micros', ${crypto.randomUUID()}, '2026-09-14T01:00:00Z')`;
    await shared.admin`delete from sessions where id = ${session.id}`;
    const [routine] = await shared.admin<Array<{ settings: string[]; definer: boolean }>>`
      select proconfig as settings, prosecdef as definer from pg_proc
      where oid = 'opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)'::regprocedure`;
    expect(routine?.definer).toBe(true);
    expect(routine?.settings).toContain("enable_nestloop=off");
    expect(routine?.settings).toContain("plan_cache_mode=force_custom_plan");
    await app.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${grant.accountId}, true),
        set_config('opengeni.workspace_id', '', true),
        set_config('opengeni.subject_id', ${`user:${userId}`}, true),
        set_config('opengeni.initiating_human_subject_id', '', true),
        set_config('enable_nestloop', 'on', true)`;
      const [row] = await tx<Array<{ summary: { totals: unknown[]; privateChats: unknown[] } }>>`
        select opengeni_private.organization_usage_summary(${grant.accountId}::uuid,
          '2026-09-14'::timestamptz, '2026-09-15'::timestamptz, 'day', null, true) as summary`;
      expect(row?.summary.totals).toEqual([
        { eventType: "model.cost", unit: "usd_micros", quantity: "123", eventCount: "1" },
      ]);
      expect(row?.summary.privateChats).toEqual([]);
      const [afterRead] = await tx<Array<{ enabled: string }>>`
        select current_setting('enable_nestloop') as enabled`;
      expect(afterRead?.enabled).toBe("on");
      await expect(
        tx.savepoint(async (savepoint) => {
          await savepoint`select opengeni_private.organization_usage_summary(${grant.accountId}::uuid,
            '2026-09-15'::timestamptz, '2026-09-14'::timestamptz, 'day', null, true)`;
        }),
      ).rejects.toMatchObject({ code: "22023" });
      const [afterError] = await tx<Array<{ enabled: string }>>`
        select current_setting('enable_nestloop') as enabled`;
      expect(afterError?.enabled).toBe("on");
    });
    const [leftover] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from opengeni_private.organization_usage_read_capabilities`;
    expect(leftover?.count).toBe(0);
  } finally {
    await client.close();
    await app.end();
  }
});
