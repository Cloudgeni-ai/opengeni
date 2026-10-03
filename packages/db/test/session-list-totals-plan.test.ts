import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql, type SQL } from "drizzle-orm";
import * as schema from "../src/schema";
import {
  bootstrapWorkspace,
  createSession,
  listSessionEntriesForSubject,
  registerDbBinding,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectRls,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

let shared: SharedTestDatabase;
let driver: postgres.Sql;
let db: ReturnType<typeof drizzle<typeof schema>>;
let captured: { query: string; parameters: unknown[] } | undefined;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-list-totals-plan");
  if (!acquired) throw new Error("Application-role PostgreSQL plan fixture unavailable");
  shared = acquired;
  driver = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
    debug: (_id, query, parameters) => {
      if (query.includes("attention_roots as")) captured = { query, parameters };
    },
  });
  db = drizzle(driver, { schema });
  registerDbBinding(db, { rlsStrategy: "force" });
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await shared?.release();
}, 60_000);

type PlanNode = {
  "Relation Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  Plans?: PlanNode[];
};

test("complete totals keep base-table work bounded across deep trees and populated personal state", async () => {
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Synthetic totals plans",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Synthetic totals plans",
    subjectId: `totals-plan-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`update workspaces set settings=settings || jsonb_build_object('maxNestedAgentDepth',64)
    where id=${grant.workspaceId}`;
  const root = await createSession(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Synthetic deep tree",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const generatedCount = 8192;
  await withWorkspaceSessionActivityRls(db, grant.workspaceId, async (tx) => {
    await tx.execute(sql`
      with generated as materialized (
        select gen_random_uuid() id, ordinal from generate_series(1, ${generatedCount}) ordinal
      )
      insert into sessions(id,account_id,workspace_id,initial_message,model,reasoning_effort,
        latency_mode,sandbox_backend,sandbox_group_id,tool_policy,parent_session_id,root_session_id,status)
      select generated.id,${grant.accountId},${grant.workspaceId},'Synthetic plan node',
        'test-model','medium','standard','none',generated.id,
        jsonb_build_object('mode','explicit','inheritedFromSessionId',null),
        case when ordinal between 2 and 32 then
          (select ancestor.id from generated ancestor where ancestor.ordinal=generated.ordinal-1)
          when ordinal<=4096 then ${root.id}::uuid else null end,
        case when ordinal<=4096 then ${root.id}::uuid else generated.id end,
        case when ordinal=32 then 'requires_action' else 'idle' end
      from generated
    `);
  });
  // Populate every personal-state row: an empty subject/workspace range hides
  // a repeated full-range scan at each node. Writes stay in the disposable DB.
  await shared.admin`insert into session_pins(account_id,workspace_id,subject_id,session_id,
    pinned,pinned_at,archived,acknowledged_sequence,actively_working)
    select account_id,workspace_id,${grant.subjectId},id,false,null,false,0,false
    from sessions where workspace_id=${grant.workspaceId}`;
  await shared.admin`analyze sessions`;
  await shared.admin`analyze session_pins`;
  await shared.admin`analyze session_event_cursors`;

  for (const scoped of [false, true]) {
    const page = await listSessionEntriesForSubject(db, grant.workspaceId, {
      subjectId: grant.subjectId,
      parentSessionId: null,
      limit: 1,
      includeTotals: true,
      includePinned: false,
      ...(scoped
        ? {
            authorizationScope: {
              kind: "scoped" as const,
              rootSessionIds: [root.id],
              sessionIds: [],
            },
          }
        : {}),
    });
    expect(page.totals?.needsYouCount).toBe(1);
    expect(page.totals?.groups[0]).toMatchObject({
      total: scoped ? 4097 : generatedCount + 1,
      attention: 1,
      unread: 0,
      activeWork: 0,
    });
    expect(page.sessions).toHaveLength(1);
    const query = captured;
    if (!query) throw new Error("Exact totals query was not captured");
    await withWorkspaceSubjectRls(db, grant.workspaceId, grant.subjectId, async (tx) => {
      const posture = await tx.execute(sql`
        select rolsuper,rolbypassrls,relrowsecurity,relforcerowsecurity
        from pg_roles cross join pg_class where rolname=current_user and pg_class.oid='sessions'::regclass
      `);
      expect(posture[0]).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
      const result = await tx.execute(explainStatement(query.query, query.parameters));
      const plan = (result[0]?.["QUERY PLAN"] as { Plan: PlanNode }[])[0]!.Plan;
      const visits = { sessions: 0, session_pins: 0 };
      function walk(node: PlanNode) {
        const relation = node["Relation Name"];
        if (relation === "sessions" || relation === "session_pins") {
          visits[relation] += node["Actual Rows"] * node["Actual Loops"];
        }
        node.Plans?.forEach(walk);
      }
      walk(plan);
      // Bounds guard physical work rather than wall time or a preferred plan
      // shape. Scanning all sessions once per depth violates this by >10x.
      expect(visits.sessions).toBeLessThan((generatedCount + 1) * 3);
      expect(visits.session_pins).toBeLessThan((generatedCount + 1) * 3);
    });
  }
}, 180_000);

function explainStatement(query: string, parameters: unknown[]): SQL {
  // Rebind captured parameters through Drizzle; never interpolate their bytes
  // into SQL text. Exercise the same unprepared driver as production.
  const fragments = query
    .split(/\$(\d+)/g)
    .map((part, index) => (index % 2 === 0 ? sql.raw(part) : sql`${parameters[Number(part) - 1]}`));
  return sql`explain (analyze,buffers,format json) ${sql.join(fragments, sql``)}`;
}
