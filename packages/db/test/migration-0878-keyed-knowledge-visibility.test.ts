import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  listingDatabase,
  readListing,
  seedListingFixture,
  type ListingFixture,
} from "./fixtures/knowledge-collection-listing";
import {
  installVisibilityBaseline,
  readVisibilityBaseline,
} from "./fixtures/knowledge-visibility-baseline";

let shared: SharedTestDatabase;
let app: postgres.Sql;
let fixture: ListingFixture;
beforeAll(async () => {
  shared = await listingDatabase();
  app = postgres(shared.appUrl, { max: 1, prepare: false });
  await installVisibilityBaseline(shared.admin, shared.appUrl);
  fixture = await seedListingFixture(shared.admin, 240);
}, 180_000);
afterAll(async () => {
  await app?.end();
  await shared?.release();
}, 180_000);

async function parity(request: Record<string, postgres.JSONValue>, f = fixture) {
  const before = await readVisibilityBaseline(app, f, request);
  const after = await readListing(app, f, request);
  expect(after).toEqual(before);
  return after;
}

test("current read results, ordering and cursor pages are identical with custom and generic plans", async () => {
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await app.unsafe(`SET plan_cache_mode = ${mode}`);
    for (const request of [
      { limit: 20 },
      { limit: 20, rootOnly: true },
      { limit: 20, groupId: fixture.groupId },
      { limit: 20, query: "Member", mode: "keyword" },
      { limit: 20, query: "Member", mode: "hybrid" },
      { operation: "get", entryId: fixture.sourceId },
      { operation: "history", entryId: fixture.groupId },
      { limit: 20, createdSince: "2000-01-01T00:00:00Z" },
    ])
      await parity(request);
    const ids: string[] = [];
    let afterId: string | undefined;
    do {
      const rows = await parity({
        limit: 50,
        groupId: fixture.groupId,
        ...(afterId ? { afterId, afterScore: 0 } : {}),
      });
      ids.push(...rows.slice(0, 50).map((row) => row.id));
      afterId = rows.length > 50 ? rows[49]!.id : undefined;
    } while (afterId);
    expect(ids).toHaveLength(240);
    expect(new Set(ids).size).toBe(240);
    expect(ids).toEqual([...ids].sort());
  }
}, 180_000);

test("cycles terminate and revocation/restoration propagates through the unchanged evidence graph", async () => {
  const f = await seedListingFixture(shared.admin, 8);
  const [member] =
    await shared.admin`SELECT e.id,e.published_revision_id AS revision FROM knowledge_entries e
    JOIN knowledge_entry_links l ON l.account_id=e.account_id AND l.entry_id=e.id AND l.revision_id=e.published_revision_id
    WHERE e.account_id=${f.accountId} AND l.relation='evidence' LIMIT 1`;
  await shared.admin`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,target_revision_id,relation)
    VALUES(${f.accountId},${f.sourceId},${f.sourceRevisionId},99,${member!.id},${member!.revision},'evidence')`;
  const request = { operation: "get", entryId: member!.id };
  const before = await parity(request, f);
  expect(before).toHaveLength(1);
  await shared.admin`UPDATE files SET status='pending' WHERE id=${f.sourceFileId}`;
  expect(await parity(request, f)).toEqual([]);
  await shared.admin`UPDATE files SET status='ready' WHERE id=${f.sourceFileId}`;
  expect(await parity(request, f)).toEqual(before);
  await shared.admin`UPDATE knowledge_entries SET archived=true WHERE id=${f.sourceId}`;
  expect(await parity(request, f)).toEqual([]);
  await shared.admin`UPDATE knowledge_entries SET archived=false,scope='personal',scope_workspace_id=NULL,scope_subject_id='user:other' WHERE id=${f.sourceId}`;
  expect(await parity(request, f)).toEqual([]);
}, 180_000);

test("internal visibility keeps its hardened metadata and is not callable by the app role", async () => {
  const [row] = await shared.admin`SELECT p.prosecdef,p.provolatile,p.proconfig,
    format('search_path=%I, pg_catalog, pg_temp',n.nspname) AS expected,
    has_function_privilege(${decodeURIComponent(new URL(shared.appUrl).username)},p.oid,'EXECUTE') AS allowed
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE p.oid='knowledge_revision_visible(uuid,uuid,uuid,boolean)'::regprocedure`;
  expect(row!.prosecdef).toBe(false);
  expect(row!.provolatile).toBe("v");
  expect(row!.proconfig).toEqual([row!.expected]);
  expect(row!.allowed).toBe(false);
  await expect(
    Promise.resolve(
      app`SELECT knowledge_revision_visible(${fixture.accountId},${fixture.sourceId},${fixture.sourceRevisionId},false)`,
    ),
  ).rejects.toMatchObject({ code: "42501" });
}, 180_000);

test("published readers reject an unpublished evidence revision while reviewers retain their existing view", async () => {
  const f = await seedListingFixture(shared.admin, 4);
  const reader = { ...f, actor: { ...f.actor, review: false } };
  const [member] =
    await shared.admin`SELECT id,published_revision_id AS revision FROM knowledge_entries
    WHERE account_id=${f.accountId} AND id NOT IN (${f.groupId},${f.sourceId}) LIMIT 1`;
  const revisionId = crypto.randomUUID();
  await shared.admin`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,actor)
    VALUES(${revisionId},${f.accountId},${f.sourceId},2,'{}','{}')`;
  await shared.admin`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,target_revision_id,relation)
    VALUES(${f.accountId},${member!.id},${member!.revision},99,${f.sourceId},${revisionId},'evidence')`;
  const request = { operation: "get", entryId: member!.id };
  expect(await parity(request, reader)).toEqual([]);
  expect(await parity(request, f)).toHaveLength(1);
  await shared.admin`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
    VALUES(${f.accountId},${f.sourceId},${revisionId},2,'published','{}')`;
  expect(await parity(request, reader)).toHaveLength(1);
}, 180_000);

test("the rolling replacement hardens an embedded schema rather than assuming public", async () => {
  const migration = await readFile(
    new URL("../drizzle/0878_keyed_knowledge_visibility.sql", import.meta.url),
    "utf8",
  );
  const schema = `knowledge_plan_${crypto.randomUUID().replaceAll("-", "")}`;
  const rollback = new Error("rollback metadata fixture");
  try {
    await shared.admin.begin(async (tx) => {
      await tx`CREATE SCHEMA ${tx(schema)}`;
      await tx`SET LOCAL search_path = ${tx(schema)}, public`;
      await tx`SET LOCAL check_function_bodies = off`;
      await tx.unsafe(migration);
      const [row] =
        await tx`SELECT p.proconfig,format('search_path=%I, pg_catalog, pg_temp',${schema}::text) AS expected
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=${schema} AND p.proname='knowledge_revision_visible'`;
      expect(row!.proconfig).toEqual([row!.expected]);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}, 180_000);

test("generic recursive plans examine exact dependency rows rather than scanning the account", async () => {
  const [member] =
    await shared.admin`SELECT e.id,e.published_revision_id AS revision FROM knowledge_entries e
    JOIN knowledge_entry_links l ON l.account_id=e.account_id AND l.entry_id=e.id AND l.revision_id=e.published_revision_id
    WHERE e.account_id=${fixture.accountId} AND l.relation='evidence' LIMIT 1`;
  const [source] = await shared.admin`SELECT prosrc,pg_get_userbyid(proowner) AS owner FROM pg_proc
    WHERE oid='knowledge_revisions_visible(uuid,uuid[],uuid[],boolean)'::regprocedure`;
  await shared.admin.begin(async (tx) => {
    await tx`SET LOCAL ROLE ${tx(source!.owner as string)}`;
    await tx`SELECT set_config('opengeni.account_id',${fixture.accountId},true),set_config('opengeni.workspace_id',${fixture.workspaceId},true),
      set_config('opengeni.subject_id',${fixture.subjectId},true),set_config('opengeni.knowledge_actor_kind','human',true),set_config('opengeni.private_file_owner',${fixture.subjectId},true)`;
    await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
    const statement = (source!.prosrc as string).match(
      /^\s*BEGIN\s+RETURN QUERY\s+([\s\S]*);\s*END;\s*$/,
    );
    expect(statement).not.toBeNull();
    const body = statement![1]!
      .replace(/\bp_account\b/g, "$1")
      .replace(/\bp_entries\b/g, "$2")
      .replace(/\bp_revisions\b/g, "$3")
      .replace(/\bp_pending\b/g, "$4");
    await tx.unsafe(`PREPARE visibility_plan(uuid,uuid[],uuid[],boolean) AS ${body}`);
    try {
      // These are generated fixture UUIDs, not caller-supplied SQL expressions.
      const args = `'${fixture.accountId}',ARRAY['${member!.id}'::uuid],ARRAY['${member!.revision}'::uuid],false`;
      const rows = await tx.unsafe(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE visibility_plan(${args})`,
      );
      const plan = rows[0]!["QUERY PLAN"][0];
      const examined: Record<string, number> = {};
      const walk = (node: any) => {
        if (node["Relation Name"])
          examined[node["Relation Name"]] =
            (examined[node["Relation Name"]] ?? 0) +
            (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * node["Actual Loops"];
        for (const child of node.Plans ?? []) walk(child);
      };
      walk(plan.Plan);
      console.log(JSON.stringify({ examined, executionMs: plan["Execution Time"] }));
      expect(examined.knowledge_entries).toBeLessThanOrEqual(2);
      // PostgreSQL may use the entry prefix and filter its two fixture revisions;
      // either choice stays bounded to the two dependencies, not the account.
      expect(examined.knowledge_entry_revisions).toBeLessThanOrEqual(5);
      expect(examined.knowledge_entry_links).toBeLessThanOrEqual(6);
      expect(examined.knowledge_entry_decisions).toBeLessThanOrEqual(4);
    } finally {
      await tx`DEALLOCATE visibility_plan`;
    }
  });
}, 180_000);
