import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  withRlsContext,
  withWorkspaceSessionActivityRls,
} from "../src/index";
import { readSessionHistoryToolIdentityPage } from "../src/session-history-tool-identities";
import { parseConcurrentIndexMigration } from "../src/migrate";

const migration = "0916_scoped_turn_history_pages.sql";
const indexName = "session_history_items_scope_turn_position_idx";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const fixture = await acquireSharedTestDatabase("scoped-turn-history", {
    withheldMigrations: [migration],
  });
  if (!fixture) throw Error("Real PostgreSQL required");
  shared = fixture;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Shared Hit Blocks"?: number;
  Plans?: PlanNode[];
};
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

test("actual receipt pages use one scoped ordered index in custom and generic plans", async () => {
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Scoped history",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Scoped history",
    subjectId: `reader-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const background = await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (tx) =>
    tx.execute(sql`
    insert into sessions(id, account_id, workspace_id, initial_message, model,
      reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
      root_session_id, status, created_by_kind, created_by_subject_id)
    select id, ${scope.accountId}, ${scope.workspaceId}, 'History fixture', 'test-model',
      'medium', 'standard', 'none', id, jsonb_build_object('mode','explicit','inheritedFromSessionId',null),
      id, 'idle', 'subject', ${grant.subjectId}
    from (select gen_random_uuid() id from generate_series(1,1000)) generated returning id
  `),
  );
  const ids = background.map((row: { id: unknown }) => String(row.id));
  await shared.admin`insert into session_turns (id,account_id,workspace_id,session_id,
    trigger_event_id,temporal_workflow_id,status,execution_generation,position,prompt,
    model,reasoning_effort,latency_mode,sandbox_backend,source,initiator_kind,initiator_subject_id)
    select gen_random_uuid(),${scope.accountId},${scope.workspaceId},id,gen_random_uuid(),
      id::text,'completed',1,1,'fixture','test-model','medium','standard','none','user','subject',${grant.subjectId}
    from unnest(${ids}::uuid[]) ids(id)`;
  await shared.admin`insert into session_history_items(account_id,workspace_id,session_id,turn_id,position,item)
    select t.account_id,t.workspace_id,t.session_id,t.id,n,
      jsonb_build_object('type','message','content',repeat('x',512))
    from session_turns t cross join generate_series(1,100) n where t.workspace_id=${scope.workspaceId}`;
  const targets: Array<{
    workspaceId: string;
    sessionId: string;
    turnId: string;
    turnRows: number;
  }> = [];
  for (const turnRows of [100, 10000]) {
    const session = await createSession(client.db, {
      ...scope,
      initialMessage: "",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const turnId = crypto.randomUUID();
    await shared.admin`insert into session_turns (id,account_id,workspace_id,session_id,
      trigger_event_id,temporal_workflow_id,status,execution_generation,position,prompt,
      model,reasoning_effort,latency_mode,sandbox_backend,source,initiator_kind,initiator_subject_id)
      values (${turnId},${scope.accountId},${scope.workspaceId},${session.id},${crypto.randomUUID()},
      ${turnId},'completed',1,1,'fixture','test-model','medium','standard','none','user','subject',${grant.subjectId})`;
    await shared.admin`insert into session_history_items(account_id,workspace_id,session_id,turn_id,position,item,active)
      select ${scope.accountId}::uuid,${scope.workspaceId}::uuid,${session.id}::uuid,
        case when n > 20000-${turnRows} then ${turnId}::uuid else null end,n+0.25,
        jsonb_build_object('type','function_call_result','callId','call-'||n,'output',repeat('x',512)),n%2=0
      from generate_series(1,20000) n`;
    targets.push({ workspaceId: scope.workspaceId, sessionId: session.id, turnId, turnRows });
  }
  await shared.admin`analyze sessions`;
  await shared.admin`analyze session_turns`;
  await shared.admin`analyze session_history_items`;
  const [role] = await client.db
    .execute(sql`select current_user,rolsuper,rolbypassrls,current_setting('row_security') as rls
    from pg_roles where rolname=current_user`);
  expect(role).toMatchObject({
    current_user: "opengeni_app",
    rolsuper: false,
    rolbypassrls: false,
    rls: "on",
  });
  const expected = new Map<string, string>();
  const observations: unknown[] = [];
  const writes: unknown[] = [];
  let freshIndexBytes = 0;
  for (const phase of ["before", "after"] as const) {
    if (phase === "after") {
      const source = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
      const parsed = parseConcurrentIndexMigration(migration, source)!;
      expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
      expect(parsed.indexName).toBe(indexName);
      await shared.admin.unsafe(parsed.statement);
      await shared.admin.unsafe(parsed.statement);
      const [size] =
        await shared.admin`select pg_relation_size(${indexName}::regclass)::int as bytes`;
      freshIndexBytes = size!.bytes;
    }
    for (const target of targets)
      for (const before of [null, 19950.5, 20000 - target.turnRows + 40.5]) {
        await withRlsContext(client.db, scope, async (tx) => {
          let compiled: ReturnType<PgDialect["sqlToQuery"]> | undefined;
          const capture = new Proxy(tx, {
            get(instance, key, receiver) {
              if (key === "execute")
                return async (query: Parameters<typeof tx.execute>[0]) => {
                  compiled = new PgDialect().sqlToQuery(
                    query as Parameters<PgDialect["sqlToQuery"]>[0],
                  );
                  return instance.execute(query);
                };
              return Reflect.get(instance, key, receiver);
            },
          });
          const decoded = await readSessionHistoryToolIdentityPage(capture, target, before, 32);
          expect(decoded).toHaveLength(32);
          expect(decoded[0]!.position).toBe(before === null ? 20000.25 : Math.floor(before) + 0.25);
          const key = `${target.turnRows}:${before}`;
          if (phase === "before") expected.set(key, JSON.stringify(decoded));
          else expect(JSON.stringify(decoded)).toBe(expected.get(key)!);
          expect(compiled).toBeDefined();
          for (const mode of ["force_custom_plan", "force_generic_plan"]) {
            await tx.execute(sql.raw(`set local plan_cache_mode='${mode}'`));
            await tx.execute(sql.raw(`prepare receipt_scope_page as ${compiled!.sql}`));
            try {
              const args = compiled!.params
                .map((value) => `'${String(value).replaceAll("'", "''")}'`)
                .join(",");
              const execute = sql.raw(`execute receipt_scope_page(${args})`);
              const rows = await tx.execute(execute);
              const rowKey = `${key}:${mode}`;
              if (phase === "before") expected.set(rowKey, JSON.stringify(rows));
              else expect(JSON.stringify(rows)).toBe(expected.get(rowKey)!);
              const [explained] = await tx.execute(
                sql`explain (analyze,buffers,format json) ${execute}`,
              );
              const plan = explained!["QUERY PLAN"][0];
              const scans = nodes(plan.Plan).filter(
                (node) => node["Relation Name"] === "session_history_items",
              );
              if (phase === "after") {
                expect(scans).toHaveLength(1);
                expect(scans[0]!["Index Name"]).toBe(indexName);
                expect(scans[0]!["Index Cond"]).toContain("workspace_id");
                expect(scans[0]!["Index Cond"]).toContain("session_id");
                expect(scans[0]!["Index Cond"]).toContain("turn_id");
                if (before === null) {
                  expect(scans[0]!["Actual Rows"]).toBe(32);
                  expect(scans[0]!["Rows Removed by Filter"] ?? 0).toBe(0);
                }
              }
              observations.push({
                phase,
                turnRows: target.turnRows,
                before,
                mode,
                ms: plan["Execution Time"],
                buffers: plan.Plan["Shared Hit Blocks"],
                scans: scans.map((node) => ({
                  type: node["Node Type"],
                  index: node["Index Name"],
                  condition: node["Index Cond"],
                  rows: node["Actual Rows"],
                  loops: node["Actual Loops"],
                  filtered: node["Rows Removed by Filter"] ?? 0,
                })),
              });
            } finally {
              await tx.execute(sql`deallocate receipt_scope_page`);
            }
          }
        });
      }
    if (process.env.OPENGENI_BENCH_HISTORY_SCOPE === "1") {
      const target = targets[0]!;
      const rollback = new Error("rollback write benchmark");
      for (let sample = 0; sample < 25; sample++) {
        let elapsed = 0;
        try {
          await shared.admin.begin(async (tx) => {
            const start = performance.now();
            await tx`insert into session_history_items(account_id,workspace_id,session_id,turn_id,position,item)
              select ${scope.accountId},${scope.workspaceId},${target.sessionId},${target.turnId},n,
                jsonb_build_object('type','message','content',repeat('x',512)) from generate_series(30001,31000) n`;
            elapsed = performance.now() - start;
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
        if (sample >= 5) writes.push({ phase, sample, rows: 1000, ms: elapsed });
      }
      await shared.admin`vacuum analyze session_history_items`;
    }
  }
  const target = targets[0]!;
  expect(
    await withRlsContext(client.db, { ...scope, workspaceId: crypto.randomUUID() }, (tx) =>
      readSessionHistoryToolIdentityPage(tx, target, null, 32),
    ),
  ).toEqual([]);
  expect(
    await withRlsContext(client.db, scope, (tx) =>
      readSessionHistoryToolIdentityPage(
        tx,
        { ...target, sessionId: targets[1]!.sessionId },
        null,
        32,
      ),
    ),
  ).toEqual([]);
  expect(
    await withRlsContext(client.db, scope, (tx) =>
      readSessionHistoryToolIdentityPage(tx, { ...target, turnId: crypto.randomUUID() }, null, 32),
    ),
  ).toEqual([]);
  const [index] =
    await shared.admin`select indisvalid,indisready,pg_relation_size(indexrelid)::int as bytes from pg_index where indexrelid=${indexName}::regclass`;
  expect(index).toMatchObject({ indisvalid: true, indisready: true });
  if (process.env.OPENGENI_BENCH_HISTORY_SCOPE === "1")
    console.log(JSON.stringify({ observations, writes, freshIndexBytes, index }));
}, 120_000);
