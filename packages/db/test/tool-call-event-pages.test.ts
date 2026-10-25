import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { bootstrapWorkspace, createDb, createSession, withWorkspaceRls } from "../src";
import { executeMigrationFile } from "../src/migrate";
import { listSessionEventSlices, type SessionEventSliceOptions } from "../src/session-event-slices";

const migrations = [
  "0963_session_event_tool_call_pages.sql",
  "0964_session_event_tool_call_fallback_pages.sql",
];
const indexes = ["session_events_tool_call_page_idx", "session_events_tool_call_fallback_page_idx"];
const toolTypes = ["agent.toolCall.created", "agent.toolCall.output"] as const;
let fixture: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let driver: postgres.Sql;
let accountId: string;
let workspaceId: string;
let sessionId: string;
beforeAll(async () => {
  const shared = await acquireSharedTestDatabase("tool-call-event-pages", {
    withheldMigrations: migrations,
  });
  if (!shared) throw Error("Real PostgreSQL required");
  fixture = shared;
  client = createDb(shared.appUrl, { max: 1 });
  driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Call pages",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Call pages",
    subjectId: crypto.randomUUID(),
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
  sessionId = (
    await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "Call fixture",
      resources: [],
      metadata: {},
      model: "test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    })
  ).id;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 60_000);

type Query = { text: string; params: unknown[] };
async function capture(options: SessionEventSliceOptions): Promise<Query> {
  let captured: Query | undefined;
  const previous = driver.options.debug;
  try {
    driver.options.debug = (_id, text, params) => {
      if (text.startsWith("select") && text.includes('"tool_call_pages"'))
        captured = { text, params: [...params] };
    };
    await listSessionEventSlices(client.db, workspaceId, sessionId, {
      view: "tools",
      includeTypes: toolTypes,
      ...options,
    });
  } finally {
    driver.options.debug = previous;
  }
  if (!captured) throw Error("Actual tool-call UNION not captured");
  return captured;
}
function literal(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw Error("Unexpected parameter");
}
type Plan = {
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Loops": number;
  Plans?: Plan[];
};
const nodes = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(nodes)];

test("actual call-ID pages preserve results and keysets with custom and generic scoped indexes", async () => {
  await fixture.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
    select ${accountId},${workspaceId},${sessionId},n,
      case when n%2=0 then 'agent.toolCall.output' else 'agent.toolCall.created' end,
      jsonb_build_object('name','fixture','callId',case when n between 10001 and 10012 then 'rare'
        when n%1000=0 then repeat('X',3000) else 'call-'||n end,'arguments',repeat('a',128),'output',repeat('o',128))
      from generate_series(1,12000) n`;
  await fixture.admin`update session_events set tool_call_id=null where session_id=${sessionId}
    and (sequence%20=0 or (sequence between 10001 and 10012 and sequence%2=0))`;
  await fixture.admin`analyze session_events`;
  const [role] =
    await driver`select rolsuper,rolbypassrls,current_setting('row_security') rls from pg_roles where rolname=current_user`;
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rls: "on" });
  const cases: SessionEventSliceOptions[] = [
    { callId: "rare" },
    { callId: "rare", direction: "before" },
    { callId: "rare", after: 10005 },
    { callId: "rare", before: 10009 },
    { callId: "rare", after: 10002, before: 10010, direction: "after" },
    { callId: "absent" },
    { callId: "X".repeat(3000) },
    { callId: "rare", includeTypes: ["agent.toolCall.created"] },
    { callId: "rare", excludeTypes: ["agent.toolCall.output"] },
  ];
  const queries: Query[] = [];
  for (const options of cases) queries.push(await capture(options));
  const baseline = new Map<string, string>();
  const observations: unknown[] = [];
  for (const phase of ["before", "after"]) {
    if (phase === "after") {
      for (const file of migrations) {
        const source = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
        await executeMigrationFile(fixture.admin, file, source);
        const oids =
          await fixture.admin`select oid from pg_class where relname=any(${indexes}) order by oid`;
        await executeMigrationFile(fixture.admin, file, source);
        expect(
          await fixture.admin`select oid from pg_class where relname=any(${indexes}) order by oid`,
        ).toEqual(oids);
      }
      expect([
        ...(await fixture.admin`select indisvalid,indisready from pg_index join pg_class on indexrelid=oid where relname=any(${indexes})`),
      ]).toEqual([
        { indisvalid: true, indisready: true },
        { indisvalid: true, indisready: true },
      ]);
      await fixture.admin`analyze session_events`;
    }
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      for (const [i, query] of queries.entries()) {
        const options = cases[i]!;
        await withWorkspaceRls(client.db, workspaceId, async (tx) => {
          await tx.execute(sql.raw(`set local plan_cache_mode=${mode}`));
          await tx.execute(sql.raw(`prepare tool_call_page as ${query.text}`));
          try {
            const args = query.params.map(literal).join(",");
            const rows = await tx.execute(sql.raw(`execute tool_call_page(${args})`));
            const direction =
              options.direction ?? (options.before === undefined ? "after" : "before");
            const expected =
              await tx.execute(sql`select id,sequence,type,turn_id,turn_association,duplicate_of_event_id from session_events
              where workspace_id=${workspaceId} and session_id=${sessionId}
              and sequence>${options.after ?? 0} and sequence<${options.before ?? 2147483647}
              and type=any(${sql.param(options.includeTypes ?? toolTypes)}::text[])
              ${options.excludeTypes?.length ? sql`and not(type=any(${sql.param(options.excludeTypes)}::text[]))` : sql``}
              and coalesce(tool_call_id,payload->>'callId',payload->>'call_id',payload->>'id')=${options.callId}
              order by sequence ${sql.raw(direction === "before" ? "desc" : "asc")} limit 9`);
            expect(rows).toEqual(expected);
            const key = `${mode}:${i}`;
            if (phase === "before") baseline.set(key, JSON.stringify(rows));
            else expect(JSON.stringify(rows)).toBe(baseline.get(key)!);
            const explain = await tx.execute(
              sql.raw(`explain(analyze,buffers,format json) execute tool_call_page(${args})`),
            );
            const report = (explain[0] as Record<string, any>)["QUERY PLAN"][0];
            if (phase === "after")
              expect(
                nodes(report.Plan)
                  .filter((p) => p["Relation Name"] === "session_events" && p["Actual Loops"] > 0)
                  .map((p) => p["Index Name"])
                  .sort(),
              ).toEqual([...indexes].sort());
            observations.push({
              phase,
              mode,
              case: i,
              ms: report["Execution Time"],
              buffers: report.Plan["Shared Hit Blocks"],
            });
          } finally {
            await tx.execute(sql.raw("deallocate tool_call_page"));
          }
        });
      }
    }
  }
  const page = await listSessionEventSlices(client.db, workspaceId, sessionId, {
    view: "tools",
    includeTypes: toolTypes,
    callId: "rare",
  });
  expect(page.events.map((e) => e.sequence)).toEqual([
    10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008,
  ]);
  expect(page.hasMore).toBe(true);
  expect(page.coveredSequence).toEqual({ first: 10001, last: 10008 });
  if (process.env.OPENGENI_BENCH_TOOL_CALL_PAGES === "1")
    console.log(JSON.stringify({ toolCallPages: observations }));
}, 180_000);

test("call-ID branches retain application RLS", async () => {
  const other = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Other",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Other",
    subjectId: crypto.randomUUID(),
  });
  for (const callId of ["rare", "X".repeat(3000)]) {
    const query = await capture({ callId });
    const parts = query.text
      .split(/\$(\d+)/g)
      .map((part, i) =>
        i % 2 === 0 ? sql.raw(part) : sql`${sql.param(query.params[Number(part) - 1])}`,
      );
    const rows = await withWorkspaceRls(client.db, other.workspaceGrants[0]!.workspaceId, (tx) =>
      tx.execute(sql.join(parts, sql``)),
    );
    expect(rows).toEqual([]);
  }
});

test("short and oversized collation-equivalent call IDs retain fallback equality", async () => {
  await fixture.admin.unsafe(
    `create collation tool_call_fold (provider=icu,locale='und-u-ks-level1',deterministic=false)`,
  );
  const [trigger] =
    await fixture.admin`select pg_get_triggerdef(oid) definition from pg_trigger where tgrelid='session_events'::regclass and tgname='session_events_fill_tool_identity'`;
  await fixture.admin.begin(async (tx) => {
    await tx.unsafe(`drop trigger session_events_fill_tool_identity on session_events`);
    await tx.unsafe(
      `alter table session_events alter column tool_call_id type text collate tool_call_fold`,
    );
    await tx.unsafe(trigger!.definition);
  });
  const long = "a" + "\u0301".repeat(1500);
  for (const [i, id] of ["a", long, "A", "á"].entries())
    await fixture.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
    values(${accountId},${workspaceId},${sessionId},${12001 + i},'agent.toolCall.created',jsonb_build_object('name','fixture','callId',${id}::text))`;
  await fixture.admin`update session_events set tool_call_id=null where session_id=${sessionId} and sequence=12004`;
  for (const callId of ["a", long]) {
    const page = await listSessionEventSlices(client.db, workspaceId, sessionId, {
      view: "tools",
      includeTypes: toolTypes,
      callId,
    });
    expect(page.events.map((e) => e.sequence)).toEqual([12001, 12002, 12003, 12004]);
  }
}, 180_000);
