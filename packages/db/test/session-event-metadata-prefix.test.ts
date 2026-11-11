import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionEventPage,
  withWorkspaceRls,
} from "../src";

let fixture: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let driver: postgres.Sql;
let workspaceId: string;
let otherWorkspaceId: string;
let sessionId: string;
beforeAll(async () => {
  const shared = await acquireSharedTestDatabase("session-event-metadata-prefix");
  if (!shared) throw Error("Real PostgreSQL required");
  fixture = shared;
  client = createDb(shared.appUrl, { max: 1 });
  driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  for (const foreign of [false, true]) {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: crypto.randomUUID(),
      accountName: "Metadata prefix",
      workspaceExternalSource: "test",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Metadata prefix",
      subjectId: crypto.randomUUID(),
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Fixture",
      resources: [],
      metadata: {},
      model: "test",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    if (foreign) otherWorkspaceId = grant.workspaceId;
    else {
      workspaceId = grant.workspaceId;
      sessionId = session.id;
    }
    // Explicit raw-storage fixture, including unrelated rows to expose repeated
    // tenant/table scans inside a recursive prepared query.
    await fixture.admin`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
      select ${grant.accountId},${grant.workspaceId},${session.id},n,'agent.toolCall.output',
        jsonb_build_object('output',repeat('x',${foreign ? 32 : 512_000}))
      from generate_series(1,${foreign ? 5000 : 300}) n`;
  }
  await fixture.admin`analyze session_events`;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 60_000);

type Query = { text: string; params: unknown[] };
function literal(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw Error("Unexpected parameter");
}
type Plan = {
  "Relation Name"?: string;
  "Node Type": string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Shared Hit Blocks": number;
  Plans?: Plan[];
};
const nodes = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(nodes)];

test.each(["after", "before"] as const)(
  "large %s pages size only the necessary prefix under restricted custom/generic plans",
  async (direction) => {
    let captured: Query | undefined;
    const previous = driver.options.debug;
    let page: Awaited<ReturnType<typeof listSessionEventPage>>;
    try {
      driver.options.debug = (_id, text, params) => {
        if (!captured && text.includes("with recursive candidates as materialized"))
          captured = { text, params: [...params] };
      };
      page = await listSessionEventPage(client.db, workspaceId, sessionId, {
        direction,
        limit: 500,
      });
    } finally {
      driver.options.debug = previous;
    }
    if (!captured) throw Error("Metadata query not captured");
    expect(page.events.map((e) => e.sequence)).toEqual(direction === "after" ? [1, 2] : [299, 300]);
    expect(page.truncatedBy).toBe("bytes");
    expect(page.hasMore).toBeTrue();
    expect(page.fullPayloadsExact).toBeTrue();
    expect(page.bytes).toBe(Buffer.byteLength(JSON.stringify(page.events)));
    const [role] =
      await driver`select rolsuper,rolbypassrls,current_setting('row_security') rls from pg_roles where rolname=current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rls: "on" });
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await withWorkspaceRls(client.db, workspaceId, async (tx) => {
        await tx.execute(sql.raw(`set local plan_cache_mode=${mode}`));
        await tx.execute(sql.raw(`prepare metadata_prefix as ${captured!.text}`));
        try {
          const args = captured!.params.map(literal).join(",");
          const rows = await tx.execute(sql.raw(`execute metadata_prefix(${args})`));
          expect(rows).toHaveLength(3); // two delivered rows and the first byte overflow
          expect(rows.map((r: { sourceRowCount: number }) => r.sourceRowCount)).toEqual([
            256, 256, 256,
          ]);
          const explain = await tx.execute(
            sql.raw(`explain(analyze,buffers,format json) execute metadata_prefix(${args})`),
          );
          const report = (explain[0] as Record<string, any>)["QUERY PLAN"][0];
          const reads = nodes(report.Plan).filter(
            (p) => p["Relation Name"] === "session_events" && p["Actual Loops"] > 0,
          );
          if (process.env.OPENGENI_BENCH_EVENT_METADATA === "1")
            console.log(JSON.stringify({ direction, mode, reads, ms: report["Execution Time"] }));
          expect(reads).toHaveLength(3);
          const recursion = nodes(report.Plan).find((p) => p["Node Type"] === "Recursive Union");
          expect(recursion).toBeDefined();
          const payloadReads = nodes(recursion!).filter(
            (p) => p["Relation Name"] === "session_events" && p["Actual Loops"] > 0,
          );
          expect(payloadReads).toHaveLength(2);
          expect(payloadReads.every((p) => p["Node Type"] === "Index Scan")).toBeTrue();
          expect(
            payloadReads.map((p) => p["Actual Rows"] * p["Actual Loops"]).sort((a, b) => a - b),
          ).toEqual([1, 2]);
          // A failed keyed recursion previously performed repeated table scans.
          expect(report.Plan["Shared Hit Blocks"]).toBeLessThan(10_000);
        } finally {
          await tx.execute(sql.raw("deallocate metadata_prefix"));
        }
      });
    }
    await withWorkspaceRls(client.db, otherWorkspaceId, async (tx) => {
      await tx.execute(sql.raw(`prepare metadata_foreign as ${captured!.text}`));
      try {
        expect(
          await tx.execute(
            sql.raw(`execute metadata_foreign(${captured!.params.map(literal).join(",")})`),
          ),
        ).toEqual([]);
      } finally {
        await tx.execute(sql.raw("deallocate metadata_foreign"));
      }
    });
  },
  30_000,
);

test("explicit batches retain byte-limited results and exact continuation", async () => {
  for (const direction of ["after", "before"] as const) {
    const expected = await listSessionEventPage(client.db, workspaceId, sessionId, {
      direction,
      limit: 255,
    });
    for (const batchSize of [1, 2, 32, 256]) {
      const actual = await listSessionEventPage(client.db, workspaceId, sessionId, {
        direction,
        limit: 500,
        batchSize,
      });
      expect(actual).toEqual(expected);
    }
    const next = await listSessionEventPage(client.db, workspaceId, sessionId, {
      direction,
      limit: 500,
      ...(direction === "after"
        ? { after: expected.nextAfter! }
        : { before: expected.nextBefore! }),
    });
    expect(next.events.map((e) => e.sequence)).toEqual(direction === "after" ? [3, 4] : [297, 298]);
  }
}, 30_000);
