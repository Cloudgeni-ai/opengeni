import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  clearSiteToolAllowances,
  createDb,
  hasSiteToolAllowance,
  listSiteToolAllowances,
  recordSiteToolAllowance,
  withWorkspaceSubjectRls,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("site-tool-allowances");
  if (!shared) {
    if (requireRealDatabase)
      throw new Error(
        "[site-tool-allowances] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[site-tool-allowances] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function workspaceWithSites(count: number) {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('site-tool-allowances') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name, settings)
    values (${account!.id}, 'site-tool-allowances', ${admin.json({})}) returning id`;
  const siteIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const siteId = crypto.randomUUID();
    await admin`
      insert into workspace_artifacts (id, account_id, workspace_id, slug, title, created_by_subject_id)
      values (${siteId}, ${account!.id}, ${workspace!.id}, ${`site-${siteId.slice(0, 8)}`}, 'Site', 'user:owner')`;
    siteIds.push(siteId);
  }
  return { accountId: account!.id, workspaceId: workspace!.id, siteIds };
}

describe("Site tool allowances (real PostgreSQL + FORCE RLS)", () => {
  test("are personal, per Site, per tool and per connection, and never another person's", async () => {
    if (!available) return;
    const { accountId, workspaceId, siteIds } = await workspaceWithSites(2);
    const [siteId, otherSiteId] = siteIds as [string, string];
    const key = {
      accountId,
      workspaceId,
      subjectId: "user:ada",
      siteId,
      serverId: "gmail",
      toolName: "send_message",
      connectionId: "conn-ada",
    };
    expect(await hasSiteToolAllowance(db, key)).toBe(false);
    await recordSiteToolAllowance(db, key);
    // Idempotent.
    await recordSiteToolAllowance(db, key);
    expect(await hasSiteToolAllowance(db, key)).toBe(true);
    expect(await listSiteToolAllowances(db, key)).toEqual([
      {
        siteId,
        serverId: "gmail",
        toolName: "send_message",
        connectionId: "conn-ada",
        createdAt: expect.any(String),
      },
    ]);
    // Exact on everything else.
    for (const other of [
      { subjectId: "user:bob" },
      { siteId: otherSiteId },
      { toolName: "create_draft" },
      { connectionId: "conn-other" },
      { connectionId: null },
      { serverId: "slack" },
    ])
      expect(await hasSiteToolAllowance(db, { ...key, ...other })).toBe(false);
    expect(await listSiteToolAllowances(db, { ...key, subjectId: "user:bob" })).toEqual([]);

    // FORCE RLS: another subject cannot read or write Ada's rows, even directly.
    const visibleToBob = await withWorkspaceSubjectRls(
      db,
      workspaceId,
      "user:bob",
      async (tx) =>
        await tx.execute<{ count: number }>(
          sql`select count(*)::int as count from site_tool_allowances`,
        ),
    );
    expect(visibleToBob).toEqual([{ count: 0 }]);
    await expect(
      withWorkspaceSubjectRls(db, workspaceId, "user:bob", async (tx) => {
        await tx.execute(sql`
          insert into site_tool_allowances (account_id, workspace_id, subject_id, site_id, server_id, tool_name)
          values (${accountId}, ${workspaceId}, 'user:ada', ${siteId}, 'gmail', 'send_message')`);
      }),
    ).rejects.toThrow();
    const [table] = await admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class
      where oid = 'site_tool_allowances'::regclass`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    // A tool without a connection, and clearing one Site's consents.
    await recordSiteToolAllowance(db, {
      ...key,
      serverId: "opengeni",
      toolName: "sessions_create",
      connectionId: null,
    });
    await recordSiteToolAllowance(db, { ...key, siteId: otherSiteId });
    expect((await listSiteToolAllowances(db, key)).map((row) => row.connectionId)).toEqual([
      "conn-ada",
      null,
    ]);
    expect(await clearSiteToolAllowances(db, key)).toBe(2);
    expect(await listSiteToolAllowances(db, key)).toEqual([]);
    expect(await hasSiteToolAllowance(db, { ...key, siteId: otherSiteId })).toBe(true);

    // Deleting the Site removes its consents.
    await admin`delete from workspace_artifacts where id = ${otherSiteId}`;
    const [remaining] = await admin<{ count: number }[]>`
      select count(*)::int as count from site_tool_allowances where site_id = ${otherSiteId}`;
    expect(remaining?.count).toBe(0);
  });
});
