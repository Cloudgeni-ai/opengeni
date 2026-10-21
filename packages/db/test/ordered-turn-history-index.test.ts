import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { bootstrapWorkspace, createDb, createSession, withRlsContext } from "../src/index";
import { parseConcurrentIndexMigration } from "../src/migrate";

const migration = "0899_ordered_turn_history_pages.sql";
const indexName = "session_history_items_turn_position_idx";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const database = await acquireSharedTestDatabase("ordered-turn-history", {
    withheldMigrations: [migration],
  });
  if (!database) throw new Error("Real PostgreSQL required");
  shared = database;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type PlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Relation Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
};

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

test("turn receipt reads preserve results and RLS with an ordered first-page index", async () => {
  const id = crypto.randomUUID();
  const {
    workspaceGrants: [grant],
  } = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "History page",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "History page",
    subjectId: `reader-${id}`,
  });
  const scope = { accountId: grant!.accountId, workspaceId: grant!.workspaceId };
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
    ${id},'completed',1,1,'fixture','test-model','medium','standard','none','user','subject',${grant!.subjectId})`;
  // A long session has a short current turn: this shape can scan both indexes
  // or sort all current-turn rows before returning its newest page.
  await shared.admin`insert into session_history_items(account_id,workspace_id,session_id,turn_id,position,item)
    select ${scope.accountId}::uuid,${scope.workspaceId}::uuid,${session.id}::uuid,
      case when n > 19900 then ${turnId}::uuid else null end,n,
      jsonb_build_object('type','message','content',repeat('x',512),'ordinal',n)
    from generate_series(1,20000) n`;
  await shared.admin`analyze session_history_items`;

  // Exact projection, filter and page order used by durableToolCallPairIdsTx.
  const page = (before: number | null) => sql`
    select position,item_ordered,item_codec_version from session_history_items
    where workspace_id=${scope.workspaceId}::uuid and session_id=${session.id}::uuid
      and turn_id=${turnId}::uuid ${before === null ? sql`` : sql`and position < ${before}`}
    order by position desc limit 32`;
  const modes = ["force_custom_plan", "force_generic_plan"] as const;
  const observations: unknown[] = [];
  const writes: unknown[] = [];
  const expected = new Map<string, string>();
  for (const phase of ["before", "after"] as const) {
    if (phase === "after") {
      const source = await readFile(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
      expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
      const parsed = parseConcurrentIndexMigration(migration, source)!;
      expect(parsed.indexName).toBe(indexName);
      await shared.admin.unsafe(parsed.statement);
      await shared.admin.unsafe(parsed.statement);
    }
    for (const mode of modes) {
      for (const before of [null, 19950]) {
        await withRlsContext(client.db, scope, async (tx) => {
          await tx.execute(sql.raw(`set local plan_cache_mode = '${mode}'`));
          const compiled = new PgDialect().sqlToQuery(page(before));
          await tx.execute(
            sql.raw(
              `prepare receipt_page(uuid,uuid,uuid${before === null ? "" : ",numeric"}) as ${compiled.sql}`,
            ),
          );
          // EXPLAIN EXECUTE exercises a genuinely prepared generic/custom
          // SELECT; preparing EXPLAIN itself does not prove that distinction.
          const argumentsSql = compiled.params
            .map((value) => `'${String(value).replaceAll("'", "''")}'`)
            .join(",");
          const execute = sql.raw(`execute receipt_page(${argumentsSql})`);
          const result = await tx.execute(execute);
          const key = `${mode}:${before}`;
          if (phase === "before") expected.set(key, JSON.stringify(result));
          else expect(JSON.stringify(result)).toBe(expected.get(key)!);
          expect(result).toHaveLength(32);
          expect(Number(result[0]!.position)).toBe(before === null ? 20000 : before - 1);
          const explained = await tx.execute(sql`explain (analyze,buffers,format json) ${execute}`);
          await tx.execute(sql`deallocate receipt_page`);
          const plan = explained[0]!["QUERY PLAN"][0];
          const scanned = nodes(plan.Plan).filter(
            (node) => node["Relation Name"] === "session_history_items",
          );
          if (phase === "before" && before === null) {
            expect(
              scanned.reduce(
                (count, node) => count + node["Actual Rows"] * node["Actual Loops"],
                0,
              ),
            ).toBeGreaterThan(32);
          }
          // Numeric cursor comparisons may remain above the RLS barrier.
          // Only the first page promises no filtered prefix. Later pages
          // retain exactly the same cursor semantics, not a new scan bound.
          if (phase === "after" && before === null) {
            expect(scanned).toHaveLength(1);
            expect(scanned[0]!["Index Name"]).toBe(indexName);
            expect(scanned[0]!["Actual Rows"]).toBe(32);
            expect(scanned[0]!["Actual Loops"]).toBe(1);
            expect(nodes(plan.Plan).some((node) => node["Node Type"] === "Sort")).toBe(false);
            expect(scanned[0]!["Rows Removed by Filter"] ?? 0).toBe(0);
          }
          observations.push({
            phase,
            mode,
            before,
            executionMs: plan["Execution Time"],
            scanned: scanned.map((node) => ({
              index: node["Index Name"],
              rows: node["Actual Rows"],
              loops: node["Actual Loops"],
              filtered: node["Rows Removed by Filter"] ?? 0,
            })),
          });
        });
      }
    }
    if (process.env.OPENGENI_BENCH_HISTORY_PAGE === "1") {
      const rollback = new Error("rollback synthetic write sample");
      for (let sample = 0; sample < 4; sample++) {
        let elapsedMs = 0;
        try {
          await shared.admin.begin(async (tx) => {
            const began = performance.now();
            await tx`insert into session_history_items(account_id,workspace_id,session_id,turn_id,position,item)
              select ${scope.accountId}::uuid,${scope.workspaceId}::uuid,${session.id}::uuid,
                ${turnId}::uuid,n,jsonb_build_object('type','message','content',repeat('x',512))
              from generate_series(30001,31000) n`;
            elapsedMs = performance.now() - began;
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
        writes.push({ phase, sample, rows: 1000, elapsedMs });
      }
      // Do not make the next phase measure dead entries left by rollback.
      await shared.admin`vacuum analyze session_history_items`;
    }
  }
  const hidden = await withRlsContext(
    client.db,
    { ...scope, workspaceId: crypto.randomUUID() },
    (tx) => tx.execute(page(null)),
  );
  expect(hidden).toHaveLength(0);
  const [index] =
    await shared.admin`select indisvalid,indisready,pg_relation_size(indexrelid)::int as bytes
    from pg_index where indexrelid=${indexName}::regclass`;
  expect(index).toMatchObject({ indisvalid: true, indisready: true });
  if (process.env.OPENGENI_BENCH_HISTORY_PAGE === "1")
    console.log(JSON.stringify({ observations, writes, index }));
}, 60_000);
