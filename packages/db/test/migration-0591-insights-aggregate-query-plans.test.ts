import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";

import { createDb, ensureManagedAccessForUser } from "../src";
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
  expect(routine?.definition).toContain("sum(usage_row.event_count) AS event_count");
  expect(routine?.definition).toContain("'eventCount', event_count::text");
  expect(routine?.definition).toContain("'privateChatsTruncated'");
});
