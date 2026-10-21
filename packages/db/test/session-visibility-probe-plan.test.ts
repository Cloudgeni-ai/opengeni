import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { bootstrapWorkspace, createDb, createSession, withWorkspaceSubjectRls } from "../src";

// Session child tables check visibility with an inlined EXISTS probe of
// sessions. Reading many rows of one session must probe sessions by key for
// the rows read, never hash every visible sessions row first.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-visibility-probe-plan");
  if (!acquired) throw new Error("PostgreSQL application-role plan fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const EVENTS = 5000;
const FIRST_SEQUENCE = 1000;

test("every inlined session visibility probe stays a keyed per-row lookup", async () => {
  const policies = await shared.admin<{ relname: string; expression: string }[]>`
    select c.relname, concat_ws(' ', pg_get_expr(p.polqual, p.polrelid),
      pg_get_expr(p.polwithcheck, p.polrelid)) as expression
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema()
      and concat_ws(' ', pg_get_expr(p.polqual, p.polrelid),
        pg_get_expr(p.polwithcheck, p.polrelid)) like '%sessions session_row%'`;
  expect(policies.length).toBeGreaterThan(50);
  for (const policy of policies) {
    const probes = policy.expression.match(/sessions session_row/g)?.length ?? 0;
    const perRow = policy.expression.match(/OFFSET 0/g)?.length ?? 0;
    expect({ relname: policy.relname, perRow }).toEqual({
      relname: policy.relname,
      perRow: probes,
    });
  }
});

test("reading a long session's events never hashes the workspace's sessions", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Visibility probe plans",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Visibility probe plans",
    subjectId: `visibility-probe-plan-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none" as const,
  });
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
      select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${session.id}::uuid,
        ${FIRST_SEQUENCE} + n, 'agent.message.completed', '{}'::jsonb
      from generate_series(1, ${EVENTS}) n`;
  });
  await shared.admin`analyze session_events`;

  const page = sql`select id, sequence from session_events
    where workspace_id = ${grant.workspaceId} and session_id = ${session.id}
      and sequence > ${FIRST_SEQUENCE}
    order by sequence asc limit 256`;
  const { sql: text, params } = new PgDialect().sqlToQuery(page);
  for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
    await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, async (tx) => {
      await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
      await tx.execute(sql.raw(`prepare visibility_probe_page as ${text}`));
      try {
        const literal = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
        const explained = await tx.execute(
          sql.raw(
            `explain (analyze, format json) execute visibility_probe_page(${params
              .map(literal)
              .join(", ")})`,
          ),
        );
        const plan = JSON.stringify(explained[0]?.["QUERY PLAN"]);
        expect({ mode, hashed: plan.includes("hashed SubPlan") }).toEqual({ mode, hashed: false });
        const sessionScans = [...plan.matchAll(/"Relation Name":"sessions"/g)].length;
        expect(sessionScans).toBeGreaterThan(0);
        expect(plan).not.toContain('"Node Type":"Seq Scan","Parent Relationship":"SubPlan"');
      } finally {
        await tx.execute(sql.raw("deallocate visibility_probe_page"));
      }
    });
  }
});
