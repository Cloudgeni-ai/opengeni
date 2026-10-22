import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { sql, type SQL } from "drizzle-orm";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionEntriesForSubject,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectRls,
  type Database,
} from "../src";
import { parseConcurrentIndexMigration } from "../src/migrate";

let shared: SharedTestDatabase;
let driver: postgres.Sql;
let client: ReturnType<typeof createDb>;
let db: Database;
let captured: { query: string; parameters: unknown[] } | undefined;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-list-totals-plan");
  if (!acquired) throw new Error("Application-role PostgreSQL plan fixture unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 1 });
  db = client.db;
  driver = (db as unknown as { $client: postgres.Sql }).$client;
  driver.options.debug = (_id, query, parameters) => {
    if (query.includes("attention_roots as")) captured = { query, parameters };
  };
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type PlanNode = {
  "Relation Name"?: string;
  Alias?: string;
  "CTE Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  Plans?: PlanNode[];
};

test("personal-state probe index is rolling, concurrent and idempotent", async () => {
  const migration = "0901_session_personal_state_probes.sql";
  const source = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
  expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
  const parsed = parseConcurrentIndexMigration(migration, source)!;
  expect(parsed.indexName).toBe("session_pins_session_subject_idx");
  await shared.admin.unsafe(parsed.statement);
  await shared.admin.unsafe(parsed.statement);
  const [index] =
    await shared.admin`select indisvalid, indisready, pg_get_indexdef(indexrelid) as definition
    from pg_index where indexrelid='session_pins_session_subject_idx'::regclass`;
  expect(index).toMatchObject({ indisvalid: true, indisready: true });
  expect(index!.definition).toContain("(session_id, subject_id)");
});

test("shallow workspace totals only read cursors contributing to unarchived groups", async () => {
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Shallow totals",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Shallow totals",
    subjectId: `shallow-totals-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  const roots = 1000;
  const archivedRoots = 650;
  const childrenPerRoot = 7;
  await withWorkspaceSessionActivityRls(db, grant.workspaceId, async (tx) => {
    await tx.execute(sql`
      with roots as materialized (
        select gen_random_uuid() id, ordinal from generate_series(1, ${roots}) ordinal
      ), generated as (
        select id, id as root_id, null::uuid parent_id, ordinal from roots
        union all
        select gen_random_uuid(), roots.id, roots.id, roots.ordinal
          from roots cross join generate_series(1, ${childrenPerRoot}) child
      )
      insert into sessions(id, account_id, workspace_id, initial_message, model, reasoning_effort,
        latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
        parent_session_id, root_session_id, status, metadata)
      select id, ${grant.accountId}, ${grant.workspaceId}, 'Shallow fixture', 'test-model', 'medium',
        'standard', 'none', id, jsonb_build_object('mode','explicit','inheritedFromSessionId',null),
        parent_id, root_id, 'idle', jsonb_build_object('ordinal', ordinal) from generated
    `);
  });
  await shared.admin`insert into session_pins(account_id, workspace_id, subject_id, session_id,
    pinned, pinned_at, archived, archived_at, acknowledged_sequence, actively_working)
    select account_id, workspace_id, ${grant.subjectId}, id, false, null,
      parent_session_id is null and (metadata->>'ordinal')::int <= ${archivedRoots},
      case when parent_session_id is null and (metadata->>'ordinal')::int <= ${archivedRoots}
        then now() else null end, 0, false
    from sessions where workspace_id=${grant.workspaceId}`;
  // A generic plan estimates average workspace/subject cardinalities. One
  // populated workspace hides the bad nested-loop choice made when a large
  // workspace shares a database with many small ones.
  for (let ordinal = 0; ordinal < 100; ordinal++) {
    const background = await bootstrapWorkspace(db, {
      accountExternalSource: "test",
      accountExternalId: identity,
      accountName: "Shallow totals",
      workspaceExternalSource: "test",
      workspaceExternalId: `${identity}-${ordinal}`,
      workspaceName: "Small background workspace",
      subjectId: `background-${identity}-${ordinal}`,
    });
    const other = background.workspaceGrants[0]!;
    const session = await createSession(db, {
      accountId: other.accountId,
      workspaceId: other.workspaceId,
      initialMessage: "Small workspace fixture",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await shared.admin`insert into session_pins(account_id, workspace_id, subject_id, session_id,
      pinned, pinned_at) values (${other.accountId}, ${other.workspaceId}, ${other.subjectId},
      ${session.id}, false, null)`;
  }
  await shared.admin`analyze sessions`;
  await shared.admin`analyze session_pins`;
  await shared.admin`analyze session_event_cursors`;
  const contributing = (roots - archivedRoots) * (childrenPerRoot + 1);
  const iterations = process.env.OPENGENI_BENCH_SESSION_LIST === "1" ? 6 : 2;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const page = await listSessionEntriesForSubject(db, grant.workspaceId, {
      subjectId: grant.subjectId,
      parentSessionId: null,
      limit: 1,
      includeTotals: true,
      includePinned: false,
    });
    expect(page.totals?.groups[0]).toMatchObject({ total: contributing, unread: 0, activeWork: 0 });
    const query = captured;
    if (!query) throw new Error("Exact totals query was not captured");
    await withWorkspaceSubjectRls(db, grant.workspaceId, grant.subjectId, async (tx) => {
      const mode = iteration % 2 === 0 ? "force_custom_plan" : "force_generic_plan";
      await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
      await tx.execute(sql.raw(`prepare shallow_totals as ${query.query}`));
      // EXECUTE arguments are SQL expressions, not extended-protocol bind
      // parameters. Quote the captured scalar fixture values, never SQL text.
      const argumentsSql = sql.raw(
        query.parameters
          .map((value) => {
            if (value === null) return "NULL";
            if (typeof value === "boolean") return value ? "true" : "false";
            if (typeof value === "number" && Number.isFinite(value)) return String(value);
            if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
            throw new Error("Unsupported prepared totals fixture parameter");
          })
          .join(", "),
      );
      let result;
      try {
        const totals = await tx.execute(sql`execute shallow_totals(${argumentsSql})`);
        const groups = totals[0]?.groups as Array<{ total: number }> | undefined;
        expect(groups?.[0]?.total).toBe(contributing);
        result = await tx.execute(
          sql`explain (analyze, buffers, format json) execute shallow_totals(${argumentsSql})`,
        );
      } finally {
        await tx.execute(sql.raw("deallocate shallow_totals")).catch(() => undefined);
      }
      const plans = result[0]?.["QUERY PLAN"] as { Plan: PlanNode; "Execution Time": number }[];
      if (process.env.OPENGENI_BENCH_SESSION_LIST === "1")
        console.log(JSON.stringify({ fixture: "shallow-plan", mode, plan: plans }));
      let cursorRows = 0;
      let sessionRows = 0;
      let childRows = 0;
      let personalRows = 0;
      let personalBlocks = 0;
      function walk(node: PlanNode) {
        if (node["Relation Name"] === "session_pins" || node["CTE Name"] === "personal_state")
          personalRows += node["Actual Rows"] * node["Actual Loops"];
        if (node["Relation Name"] === "session_pins")
          personalBlocks += (node["Shared Hit Blocks"] ?? 0) + (node["Shared Read Blocks"] ?? 0);
        if (node["Relation Name"] === "session_event_cursors")
          cursorRows += node["Actual Rows"] * node["Actual Loops"];
        if (node["Relation Name"] === "sessions")
          sessionRows += node["Actual Rows"] * node["Actual Loops"];
        if (node["Relation Name"] === "sessions" && node.Alias === "child")
          childRows += node["Actual Rows"] * node["Actual Loops"];
        node.Plans?.forEach(walk);
      }
      walk(plans[0]!.Plan);
      console.log(
        JSON.stringify({
          fixture: "shallow",
          mode,
          iteration,
          contributing,
          cursorRows,
          sessionRows,
          childRows,
          personalRows,
          personalBlocks,
          executionMs: plans[0]!["Execution Time"],
        }),
      );
      expect(cursorRows).toBe(contributing);
      // Root filtering must happen before materializing descendants. Archived
      // trees cannot contribute, even though their children remain visible.
      expect(childRows).toBe((roots - archivedRoots) * childrenPerRoot);
      expect(personalRows).toBeLessThanOrEqual(roots * (childrenPerRoot + 1) * 5);
      // An index scan can still walk an entire workspace range while returning
      // one row. Bound its buffer work too, not just its output cardinality.
      expect(personalBlocks).toBeLessThanOrEqual(roots * (childrenPerRoot + 1) * 8);
      expect(sessionRows).toBeLessThanOrEqual(roots * (childrenPerRoot + 1) + contributing);
    });
  }
  if (process.env.OPENGENI_BENCH_SESSION_LIST === "1") {
    const [size] =
      await shared.admin`select pg_relation_size('session_pins_session_subject_idx')::int as bytes`;
    console.log(
      JSON.stringify({ fixture: "personal-state-index", rows: 8100, bytes: size!.bytes }),
    );
  }
}, 180_000);

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
  const createRoot = () =>
    createSession(db, {
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
  const root = await createRoot();
  const cycleA = await createRoot();
  const cycleB = await createRoot();
  // Simulate disconnected corrupt legacy edges. Normal writers reject these;
  // neither node is parentless, so UNION ALL must never enter their cycle.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role=replica`;
    await tx`update sessions set parent_session_id=${cycleB.id} where id=${cycleA.id}`;
    await tx`update sessions set parent_session_id=${cycleA.id} where id=${cycleB.id}`;
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

  const scopes =
    process.env.OPENGENI_BENCH_SESSION_LIST === "1"
      ? [false, true, false, true, false, true]
      : [false, true];
  for (const scoped of scopes) {
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
      const plans = result[0]?.["QUERY PLAN"] as { Plan: PlanNode }[] | undefined;
      const plan = plans?.[0]?.Plan;
      if (!plan) throw new Error("Exact totals query returned no execution plan");
      const visits = { sessions: 0, session_pins: 0, personal_state: 0 };
      function walk(node: PlanNode) {
        const relation = node["Relation Name"];
        if (relation === "sessions" || relation === "session_pins") {
          visits[relation] += node["Actual Rows"] * node["Actual Loops"];
        }
        if (node["CTE Name"] === "personal_state") {
          visits.personal_state += node["Actual Rows"] * node["Actual Loops"];
        }
        node.Plans?.forEach(walk);
      }
      walk(plan);
      if (process.env.OPENGENI_BENCH_SESSION_LIST === "1")
        console.log(JSON.stringify({ scoped, visits, plan: result[0]?.["QUERY PLAN"] }));
      // Bounds guard physical work rather than wall time or a preferred plan
      // shape. Scanning all sessions once per depth violates this by >10x.
      // Sessions are read for roots/descendants and by keyed child-table
      // visibility probes, so a constant small multiple of the workspace.
      expect(visits.sessions).toBeLessThan((generatedCount + 1) * 4);
      expect(visits.session_pins).toBeLessThan((generatedCount + 1) * 3);
      expect(visits.personal_state).toBeLessThan((generatedCount + 1) * 4);
    });
  }

  const [attention] = await shared.admin`select id from sessions
    where workspace_id=${grant.workspaceId} and status='requires_action'`;
  const [leaf] = await shared.admin`select node.id from sessions node
    where node.workspace_id=${grant.workspaceId} and node.parent_session_id=${root.id}
      and not exists (select 1 from sessions child where child.parent_session_id=node.id)
    limit 1`;
  await shared.admin`update session_pins set pinned=true,pinned_at=now()
    where session_id=${attention!.id} and subject_id=${grant.subjectId}`;
  await shared.admin`update session_pins set manually_unread_through=0,actively_working=true
    where session_id in (${root.id},${leaf!.id}) and subject_id=${grant.subjectId}`;
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
    // Pinned paths leave group summaries, but still count toward root attention.
    expect(page.totals?.needsYouCount).toBe(1);
    expect(page.totals?.groups[0]).toMatchObject({
      total: scoped ? 4096 : generatedCount,
      attention: 0,
      unread: 2,
      activeWork: 2,
    });
  }
  await shared.admin`update session_pins set pinned=true,pinned_at=now()
    where session_id=${root.id} and subject_id=${grant.subjectId}`;
  const pinned = await listSessionEntriesForSubject(db, grant.workspaceId, {
    subjectId: grant.subjectId,
    parentSessionId: null,
    limit: 1,
    includeTotals: true,
    includePinned: false,
  });
  expect(pinned.totals?.needsYouCount).toBe(1);
  expect(pinned.totals?.groups[0]).toMatchObject({
    total: 4096,
    attention: 0,
    unread: 0,
    activeWork: 0,
  });
}, 180_000);

function explainStatement(query: string, parameters: unknown[]): SQL {
  // Rebind captured parameters through Drizzle; never interpolate their bytes
  // into SQL text. Exercise the production driver's prepared-query settings.
  const fragments = query
    .split(/\$(\d+)/g)
    .map((part, index) => (index % 2 === 0 ? sql.raw(part) : sql`${parameters[Number(part) - 1]}`));
  return sql`explain (analyze,buffers,format json) ${sql.join(fragments, sql``)}`;
}
