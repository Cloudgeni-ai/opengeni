import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { bootstrapWorkspace, createDb, createSession, withWorkspaceRls } from "../src";
import { executeMigrationFile } from "../src/migrate";
import { listSessionEventSlices, type SessionEventSliceOptions } from "../src/session-event-slices";

const migrations = [
  "0943_session_event_tool_name_pages.sql",
  "0944_session_event_tool_name_fallback_pages.sql",
];
const indexes = ["session_events_tool_name_page_idx", "session_events_tool_name_fallback_page_idx"];
let fixture: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let driver: postgres.Sql;
let accountId: string;
let workspaceId: string;
let sessionId: string;
beforeAll(async () => {
  const shared = await acquireSharedTestDatabase("tool-name-event-pages", {
    withheldMigrations: migrations,
  });
  if (!shared) throw Error("Real PostgreSQL required");
  fixture = shared;
  client = createDb(shared.appUrl, { max: 1 });
  driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Tool pages",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Tool pages",
    subjectId: crypto.randomUUID(),
  });
  ({ accountId, workspaceId } = access.workspaceGrants[0]!);
  sessionId = (
    await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: "Tool page fixture",
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
      if (text.startsWith("select") && text.includes('"tool_name_pages"'))
        captured = { text, params: [...params] };
    };
    await listSessionEventSlices(client.db, workspaceId, sessionId, { view: "tools", ...options });
  } finally {
    driver.options.debug = previous;
  }
  if (!captured) throw Error("Actual tool-name UNION query not captured");
  return captured;
}
const literal = (v: unknown): string => {
  if (v === null) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
  throw Error("Unexpected query parameter");
};
type Plan = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Shared Hit Blocks": number;
  Plans?: Plan[];
};
const nodes = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(nodes)];

test("actual tool-name pages preserve keysets and use both partial indexes under restricted custom/generic plans", async () => {
  await fixture.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
    select ${accountId},${workspaceId},${sessionId},n,'agent.toolCall.created',
      jsonb_build_object('name',case when n between 10001 and 10012 then 'rare' when n%1000=0 then repeat('L',2050) else 'other_'||(n%41) end,
        'callId','call-'||n,'arguments',repeat('x',128)) from generate_series(1,12000) n`;
  // Compatibility boundary: pre-projection rows, including half the matches.
  await fixture.admin`update session_events set tool_name=null where session_id=${sessionId}
    and (sequence%20=0 or (sequence between 10001 and 10012 and sequence%2=0))`;
  await fixture.admin`analyze session_events`;
  const [role] =
    await driver`select rolsuper,rolbypassrls,current_setting('row_security') rls from pg_roles where rolname=current_user`;
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rls: "on" });
  const cases: SessionEventSliceOptions[] = [
    { toolName: "rare" },
    { toolName: "rare", direction: "before" },
    { toolName: "rare", after: 10005 },
    { toolName: "rare", before: 10009 },
    { toolName: "rare", after: 10002, before: 10010, direction: "after" },
    { toolName: "absent" },
    { toolName: "absent", direction: "before" },
    { toolName: "L".repeat(2050) },
    { toolName: "rare", callId: "call-10007" },
  ];
  const queries: Array<{ options: SessionEventSliceOptions; query: Query }> = [];
  for (const options of cases) queries.push({ options, query: await capture(options) });
  const observations: unknown[] = [];
  const previousRows = new Map<string, string>();
  for (const phase of ["before", "after"]) {
    if (phase === "after") {
      for (const file of migrations) {
        const source = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
        await executeMigrationFile(fixture.admin, file, source);
        const before = await fixture.admin`select oid from pg_class where relname=any(${indexes})`;
        await executeMigrationFile(fixture.admin, file, source);
        expect(await fixture.admin`select oid from pg_class where relname=any(${indexes})`).toEqual(
          before,
        );
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
      for (const [i, { options, query }] of queries.entries()) {
        await withWorkspaceRls(client.db, workspaceId, async (tx) => {
          await tx.execute(sql.raw(`set local plan_cache_mode=${mode}`));
          await tx.execute(sql.raw(`prepare tool_name_page as ${query.text}`));
          const args = query.params.map(literal).join(",");
          try {
            const rows = await tx.execute(sql.raw(`execute tool_name_page(${args})`));
            const direction =
              options.direction ?? (options.before === undefined ? "after" : "before");
            // Former predicate, same scoped transaction. All fixture events are
            // claimed/non-human; the original prompt exclusion is vacuous here.
            const expected = await tx.execute(sql`select id,sequence,type,turn_id,
                turn_association,duplicate_of_event_id from session_events
              where workspace_id=${workspaceId} and session_id=${sessionId}
                and sequence > ${options.after ?? 0} and sequence < ${options.before ?? 2147483647}
                and type='agent.toolCall.created' and coalesce(tool_name,payload->>'name')=${options.toolName}
                ${options.callId === undefined ? sql`` : sql`and coalesce(tool_call_id,payload->>'callId',payload->>'call_id',payload->>'id')=${options.callId}`}
              order by sequence ${sql.raw(direction === "before" ? "desc" : "asc")} limit 9`);
            expect(rows).toEqual(expected);
            const key = `${mode}:${i}`;
            if (phase === "before") previousRows.set(key, JSON.stringify(rows));
            else expect(JSON.stringify(rows)).toBe(previousRows.get(key)!);
            const result = await tx.execute(
              sql.raw(`explain(analyze,buffers,format json) execute tool_name_page(${args})`),
            );
            const plan = (result[0] as Record<string, any>)["QUERY PLAN"][0];
            const accesses = nodes(plan.Plan).filter(
              (p) => p["Relation Name"] === "session_events" && p["Actual Loops"] > 0,
            );
            if (phase === "after") {
              expect(accesses.map((p) => p["Index Name"]).sort()).toEqual([...indexes].sort());
            }
            observations.push({
              phase,
              mode,
              case: i,
              ms: plan["Execution Time"],
              buffers: plan.Plan["Shared Hit Blocks"],
            });
          } finally {
            await tx.execute(sql.raw("deallocate tool_name_page"));
          }
        });
      }
    }
  }
  const page = await listSessionEventSlices(client.db, workspaceId, sessionId, {
    view: "tools",
    toolName: "rare",
    limit: 8,
  });
  expect(page.events.map((e) => e.sequence)).toEqual([
    10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008,
  ]);
  expect(page.hasMore).toBe(true);
  expect(page.coveredSequence).toEqual({ first: 10001, last: 10008 });
  if (process.env.OPENGENI_BENCH_TOOL_NAME_PAGES === "1")
    console.log(JSON.stringify({ toolNamePages: observations }));
}, 180_000);

test("both branches retain explicit scope and application RLS", async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Other account",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Other workspace",
    subjectId: crypto.randomUUID(),
  });
  const other = access.workspaceGrants[0]!.workspaceId;
  for (const toolName of ["rare", "L".repeat(2050)]) {
    const query = await capture({ toolName });
    const fragments = query.text
      .split(/\$(\d+)/g)
      .map((part, i) =>
        i % 2 === 0 ? sql.raw(part) : sql`${sql.param(query.params[Number(part) - 1])}`,
      );
    const hidden = await withWorkspaceRls(client.db, other, (tx) =>
      tx.execute(sql.join(fragments, sql``)),
    );
    expect(hidden.length).toBe(0);
    const mismatched = await listSessionEventSlices(client.db, other, sessionId, {
      view: "tools",
      toolName,
    });
    expect(mismatched.events).toEqual([]);
  }
}, 180_000);

test("oversized collation-equivalent names remain in the fallback, not excluded by the index bound", async () => {
  // A short search can equal a >2048-byte name. This must not become an input
  // restriction or a bytewise-collation change in an existing installation.
  await fixture.admin.unsafe(
    `create collation tool_name_test_fold (provider=icu,locale='und-u-ks-level1',deterministic=false)`,
  );
  // Recreate the unchanged dependent trigger around this disposable-only
  // collation alteration. Production migrations never change the collation.
  const [trigger] = await fixture.admin`select pg_get_triggerdef(oid) as definition from pg_trigger
    where tgrelid='session_events'::regclass and tgname='session_events_fill_tool_identity'`;
  await fixture.admin.begin(async (tx) => {
    await tx.unsafe(`drop trigger session_events_fill_tool_identity on session_events`);
    await tx.unsafe(
      `alter table session_events alter column tool_name type text collate tool_name_test_fold`,
    );
    await tx.unsafe(trigger!.definition);
  });
  const long = "a" + "\u0301".repeat(1500);
  for (const [i, name] of ["a", long, "A"].entries()) {
    await fixture.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
      values(${accountId},${workspaceId},${sessionId},${12001 + i},'agent.toolCall.created',jsonb_build_object('name',${name}::text,'callId',${String(i)}::text))`;
  }
  for (const name of ["a", long]) {
    const expected = await withWorkspaceRls(client.db, workspaceId, (tx) =>
      tx.execute<{ sequence: number }>(sql`
      select sequence from session_events where workspace_id=${workspaceId} and session_id=${sessionId}
      and type='agent.toolCall.created' and coalesce(tool_name,payload->>'name')=${name} order by sequence`),
    );
    expect(expected.map((r: { sequence: number }) => r.sequence)).toEqual([12001, 12002, 12003]);
    const page = await listSessionEventSlices(client.db, workspaceId, sessionId, {
      view: "tools",
      toolName: name,
    });
    expect(page.events.map((e) => e.sequence)).toEqual(
      expected.map((r: { sequence: number }) => r.sequence),
    );
  }
}, 180_000);
