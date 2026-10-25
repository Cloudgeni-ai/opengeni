import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "../src/schema";
import {
  bootstrapWorkspace,
  getSessionAuthorizationFacts,
  getSessionAuthorizationFactsBatch,
  registerDbBinding,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectRls,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

let shared: SharedTestDatabase;
let driver: postgres.Sql;
let db: ReturnType<typeof drizzle<typeof schema>>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("authorization-facts-plans");
  if (!acquired) throw new Error("Real application-role PostgreSQL required");
  shared = acquired;
  driver = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  db = drizzle(driver, { schema });
  registerDbBinding(db, { rlsStrategy: "force" });
}, 180_000);
afterAll(async () => {
  await driver?.end();
  await shared?.release();
}, 60_000);

test("actual scalar and batch authorization queries keep keyed target reads in custom and generic plans", async () => {
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Authorization plans",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Authorization plans",
    subjectId: `plan-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const seeded = await withWorkspaceSessionActivityRls(db, grant.workspaceId, (tx) =>
    tx.execute(sql`
    insert into sessions(id, account_id, workspace_id, initial_message, model,
      reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
      root_session_id, status, created_by_kind, created_by_subject_id)
    select id, ${scope.accountId}, ${scope.workspaceId}, 'Authorization fixture', 'test-model',
      'medium', 'standard', 'none', id, jsonb_build_object('mode','explicit','inheritedFromSessionId',null),
      id, 'idle', 'subject', ${grant.subjectId}
    from (select gen_random_uuid() id from generate_series(1,10001)) generated returning id
  `),
  );
  const ids = seeded.map((row: { id: unknown }) => String(row.id));
  await shared.admin`analyze sessions`;
  const [role] =
    await driver`select rolsuper,rolbypassrls,current_setting('row_security') as rls from pg_roles where rolname=current_user`;
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false, rls: "on" });
  const cases = [
    { name: "missing", ids: [crypto.randomUUID()] },
    { name: "late", ids: [ids[10000]!] },
    {
      name: "caller",
      ids: [ids[10000]!],
      caller: { sessionId: ids[0]!, attemptId: crypto.randomUUID() },
    },
    { name: "window", ids: ids.slice(-8) },
    { name: "page", ids: ids.slice(-60) },
  ];
  for (const sample of cases) {
    const captured: { query: string; parameters: unknown[] }[] = [];
    driver.options.debug = (_id, query, parameters) => captured.push({ query, parameters });
    try {
      if (sample.ids.length === 1)
        await getSessionAuthorizationFacts(db, {
          ...scope,
          sessionId: sample.ids[0]!,
          caller: sample.caller,
        });
      else await getSessionAuthorizationFactsBatch(db, { ...scope, sessionIds: sample.ids });
    } finally {
      driver.options.debug = false;
    }
    const queries = captured.filter((query) => query.query.includes("target.id as target_id"));
    expect(queries).toHaveLength(1);
    const query = queries[0]!;
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await withWorkspaceSubjectRls(db, grant.workspaceId, grant.subjectId, async (tx) => {
        await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
        await tx.execute(sql.raw(`prepare authorization_plan as ${query.query}`));
        const args = query.parameters
          .map((value) => {
            if (value === null) return "null";
            if (typeof value === "number" || typeof value === "boolean") return String(value);
            if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
            throw new Error("Unexpected captured parameter");
          })
          .join(",");
        try {
          const result = await tx.execute(
            sql.raw(`explain (analyze,buffers,format json) execute authorization_plan(${args})`),
          );
          type Node = {
            "Relation Name"?: string;
            Alias?: string;
            "Actual Rows": number;
            "Actual Loops": number;
            "Rows Removed by Filter"?: number;
            "Index Cond"?: string;
            Plans?: Node[];
          };
          const plans = result[0]?.["QUERY PLAN"] as
            | { Plan: Node; "Execution Time": number }[]
            | undefined;
          const plan = plans?.[0];
          if (!plan) throw new Error("Authorization plan was not returned");
          const nodes = (node: Node): Node[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
          const targets = nodes(plan.Plan).filter(
            (node) => node["Relation Name"] === "sessions" && node.Alias === "target",
          );
          expect(targets.length).toBeGreaterThan(0);
          const visited = targets.reduce(
            (total, node) =>
              total +
              (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * node["Actual Loops"],
            0,
          );
          expect(visited).toBeLessThanOrEqual(sample.ids.length);
          expect(targets.every((node) => node["Index Cond"]?.includes("id"))).toBe(true);
          console.log(
            JSON.stringify({
              fixture: "authorization-facts",
              case: sample.name,
              mode,
              visited,
              executionMs: plan["Execution Time"],
            }),
          );
        } finally {
          await tx.execute(sql.raw("deallocate authorization_plan"));
        }
      });
    }
  }
}, 120_000);
