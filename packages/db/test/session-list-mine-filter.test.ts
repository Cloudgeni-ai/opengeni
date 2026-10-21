import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
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

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-list-mine-filter");
  if (!acquired) throw new Error("Application-role PostgreSQL fixture unavailable");
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

test("mine keeps workstreams the subject started or messaged, anywhere in the tree", async () => {
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Synthetic mine filter",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Synthetic mine filter",
    subjectId: `mine-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  const me = grant.subjectId;
  const someoneElse = `other-${identity}`;
  const session = (createdBy: { kind: "subject" | "service"; subjectId: string }) =>
    createSession(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Synthetic workstream",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy,
    });
  const child = async (rootId: string) => {
    const id = crypto.randomUUID();
    await withWorkspaceSessionActivityRls(db, grant.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into sessions(id, account_id, workspace_id, initial_message, model,
          reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
          parent_session_id, root_session_id, status, created_by_kind, created_by_subject_id)
        values (${id}, ${grant.accountId}, ${grant.workspaceId}, 'Synthetic child',
          'test-model', 'medium', 'standard', 'none', ${id},
          jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null),
          ${rootId}, ${rootId}, 'idle', 'service', 'agent-spawner')`);
    });
    return id;
  };
  const turn = async (
    sessionId: string,
    initiator: { kind: "subject" | "service"; subjectId: string },
    source: "user" | "api" | "system",
    surface: string | null,
  ) => {
    await shared.admin`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, execution_generation, position, prompt, model, reasoning_effort, latency_mode,
        sandbox_backend, source, surface, initiator_kind, initiator_subject_id,
        initiating_human_subject_id
      ) values (
        ${crypto.randomUUID()}, ${grant.accountId}, ${grant.workspaceId}, ${sessionId},
        ${crypto.randomUUID()}, ${`mine-${crypto.randomUUID()}`}, 'completed', 1, 1,
        'synthetic prompt', 'test-model', 'medium', 'standard', 'none', ${source}, ${surface},
        ${initiator.kind}, ${initiator.subjectId},
        ${initiator.kind === "subject" ? initiator.subjectId : null}
      )`;
  };

  const started = await session({ kind: "subject", subjectId: me });
  const messagedInChild = await session({ kind: "service", subjectId: "scheduler" });
  const messagedChild = await child(messagedInChild.id);
  await turn(messagedChild, { kind: "subject", subjectId: me }, "user", "web");
  const viaApi = await session({ kind: "service", subjectId: "scheduler" });
  await turn(viaApi.id, { kind: "subject", subjectId: me }, "api", null);
  const relayedByAgent = await session({ kind: "service", subjectId: "scheduler" });
  await turn(relayedByAgent.id, { kind: "subject", subjectId: me }, "user", "agent");
  const continuation = await session({ kind: "service", subjectId: "scheduler" });
  await turn(continuation.id, { kind: "service", subjectId: "scheduler" }, "system", null);
  const theirs = await session({ kind: "subject", subjectId: someoneElse });
  await turn(theirs.id, { kind: "subject", subjectId: someoneElse }, "user", "web");

  const roots = await listSessionEntriesForSubject(db, grant.workspaceId, {
    subjectId: me,
    parentSessionId: null,
    limit: 50,
    includePinned: false,
    includeTotals: true,
    materializeSnapshot: true,
    mineOnly: true,
  });
  expect(roots.mineOnly).toBe(true);
  expect(new Set(roots.sessions.map((row) => row.id))).toEqual(
    new Set([started.id, messagedInChild.id, viaApi.id]),
  );
  expect(roots.totals?.groups.reduce((sum, group) => sum + group.total, 0)).toBe(4);

  // A matching root's children list in full; the filter is per workstream.
  const children = await listSessionEntriesForSubject(db, grant.workspaceId, {
    subjectId: me,
    parentSessionId: messagedInChild.id,
    limit: 50,
    includePinned: false,
    materializeSnapshot: true,
    mineOnly: true,
  });
  expect(children.sessions.map((row) => row.id)).toEqual([messagedChild]);

  const scoped = await listSessionEntriesForSubject(db, grant.workspaceId, {
    subjectId: me,
    parentSessionId: null,
    includePinned: false,
    includeTotals: true,
    mineOnly: true,
    authorizationScope: { kind: "scoped", rootSessionIds: [messagedInChild.id], sessionIds: [] },
  });
  expect(scoped.sessions.map((row) => row.id)).toEqual([messagedInChild.id]);
  expect(scoped.totals?.groups.reduce((sum, group) => sum + group.total, 0)).toBe(2);
  const exactChild = await listSessionEntriesForSubject(db, grant.workspaceId, {
    subjectId: me,
    parentSessionId: null,
    includePinned: false,
    mineOnly: true,
    authorizationScope: { kind: "scoped", rootSessionIds: [], sessionIds: [messagedChild] },
  });
  expect(exactChild.sessions).toEqual([]);

  // Without the filter every visible root is listed.
  const everyone = await listSessionEntriesForSubject(db, grant.workspaceId, {
    subjectId: me,
    parentSessionId: null,
    limit: 50,
    includePinned: false,
    materializeSnapshot: true,
  });
  expect(everyone.mineOnly).toBeUndefined();
  expect(everyone.sessions).toHaveLength(6);

  // The turn probe matches the partial index predicate exactly.
  const plan = await shared.admin.begin(async (tx) => {
    await tx`set local enable_seqscan = off`;
    return await tx.unsafe(
      `explain (format json) select 1 from session_turns t
       where t.workspace_id = $1 and t.initiator_subject_id = $2 and t.session_id = $3
         and t.initiator_kind = 'subject' and t.source in ('user', 'api')
         and t.surface is distinct from 'agent'`,
      [grant.workspaceId, me, viaApi.id],
    );
  });
  expect(JSON.stringify(plan)).toContain("session_turns_human_prompt_subject_idx");
}, 120_000);

test("mine checks for a matching prompt without hydrating a person's whole turn history", async () => {
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Mine plan",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Mine plan",
    subjectId: `mine-plan-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  const root = crypto.randomUUID();
  const child = crypto.randomUUID();
  await withWorkspaceSessionActivityRls(db, grant.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into sessions(id, account_id, workspace_id, initial_message, model,
        reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
        parent_session_id, root_session_id, status, created_by_kind, created_by_subject_id)
      select id, ${grant.accountId}, ${grant.workspaceId}, 'Mine plan fixture', 'test-model',
        'medium', 'standard', 'none', id,
        jsonb_build_object('mode','explicit','inheritedFromSessionId',null),
        parent_id, root_id, 'idle', 'service', 'scheduler'
      from (
        select ${root}::uuid id, null::uuid parent_id, ${root}::uuid root_id
        union all select ${child}::uuid, ${root}::uuid, ${root}::uuid
        union all select id, null::uuid, id from
          (select gen_random_uuid() id from generate_series(1, 999)) unrelated
      ) generated
    `);
  });
  await shared.admin`
    insert into session_turns(id, account_id, workspace_id, session_id, trigger_event_id,
      temporal_workflow_id, status, execution_generation, position, prompt, model,
      reasoning_effort, latency_mode, sandbox_backend, source, surface,
      initiator_kind, initiator_subject_id, initiating_human_subject_id)
    select gen_random_uuid(), ${grant.accountId}, ${grant.workspaceId}, ${child},
      gen_random_uuid(), gen_random_uuid()::text, 'completed', 1, ordinal, 'fixture prompt',
      'test-model', 'medium', 'standard', 'none', 'user', 'web', 'subject',
      ${grant.subjectId}, ${grant.subjectId}
    from generate_series(1, 10000) ordinal
  `;
  await shared.admin`analyze sessions`;
  await shared.admin`analyze session_turns`;
  const captured: { query: string; parameters: unknown[] }[] = [];
  driver.options.debug = (_id, query, parameters) => captured.push({ query, parameters });
  try {
    const page = await listSessionEntriesForSubject(db, grant.workspaceId, {
      subjectId: grant.subjectId,
      parentSessionId: null,
      limit: 50,
      includePinned: false,
      includeTotals: true,
      mineOnly: true,
    });
    expect(page.sessions.map((row) => row.id)).toEqual([root]);
    expect(page.totals?.groups.reduce((sum, group) => sum + group.total, 0)).toBe(2);
  } finally {
    driver.options.debug = false;
  }
  const queries = captured.filter(
    (x) =>
      x.query.includes("mine_turn") &&
      (x.query.includes("attention_roots as") || x.query.startsWith('select "sessions"."id",')),
  );
  expect(queries).toHaveLength(2);
  const turnVisits: number[] = [];
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    for (const [index, query] of queries.entries()) {
      await withWorkspaceSubjectRls(db, grant.workspaceId, grant.subjectId, async (tx) => {
        await tx.execute(sql.raw(`set local plan_cache_mode = ${mode}`));
        await tx.execute(sql.raw(`prepare mine_plan as ${query.query}`));
        const args = query.parameters
          .map((value) => {
            if (value === null) return "null";
            if (typeof value === "boolean" || typeof value === "number") return String(value);
            if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
            throw new Error("Unexpected captured query parameter");
          })
          .join(",");
        try {
          const result = await tx.execute(
            sql.raw(`explain (analyze,buffers,format json) execute mine_plan(${args})`),
          );
          type Node = {
            "Relation Name"?: string;
            Alias?: string;
            "Actual Rows": number;
            "Actual Loops": number;
            "Index Cond"?: string;
            Plans?: Node[];
          };
          const plans = result[0]?.["QUERY PLAN"] as
            | { Plan: Node; "Execution Time": number }[]
            | undefined;
          const plan = plans?.[0];
          if (!plan) throw new Error("Mine plan was not returned");
          let turnRows = 0;
          let keyedProbes = 0;
          const walk = (node: Node) => {
            if (node["Relation Name"] === "session_turns" && node.Alias === "mine_turn") {
              turnRows += node["Actual Rows"] * node["Actual Loops"];
              // EXPLAIN may round the per-loop row average down to zero.
              // Check the actual keyed access too, not only that average.
              expect(node["Index Cond"]).toContain("session_id");
              expect(node["Index Cond"]).toContain("initiator_subject_id");
              keyedProbes += node["Actual Loops"];
            }
            node.Plans?.forEach(walk);
          };
          walk(plan.Plan);
          expect(keyedProbes).toBeGreaterThan(0);
          console.log(
            JSON.stringify({
              fixture: "mine-history",
              mode,
              query: index === 0 ? "totals" : "rows",
              turnRows,
              executionMs: plan["Execution Time"],
            }),
          );
          turnVisits.push(turnRows);
        } finally {
          await tx.execute(sql.raw("deallocate mine_plan"));
        }
      });
    }
  }
  expect(Math.max(...turnVisits)).toBeLessThanOrEqual(10);
}, 120_000);
