import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import type { SharedTestDatabase } from "@opengeni/testing";
import {
  installListingBaseline,
  listingDatabase,
  readListing,
  seedListingFixture,
  type ListingFixture,
} from "./fixtures/knowledge-collection-listing";

let shared: SharedTestDatabase;
let app: postgres.Sql;
let fixture: ListingFixture;
beforeAll(async () => {
  shared = await listingDatabase();
  app = postgres(shared.appUrl, { max: 1, prepare: false });
  await installListingBaseline(shared.admin, shared.appUrl);
  fixture = await seedListingFixture(shared.admin, 80);
}, 180_000);
afterAll(async () => {
  await app?.end();
  await shared?.release();
}, 180_000);

async function parity(request: Record<string, postgres.JSONValue>, f = fixture) {
  const before = await readListing(app, f, request, true);
  const after = await readListing(app, f, request);
  expect(after).toEqual(before);
  return after;
}

describe("Knowledge relationship projection", () => {
  test("projection and historical baseline retain the hardened function metadata", async () => {
    const rows = await shared.admin`SELECT p.proname,p.prosecdef,p.provolatile,
      p.proconfig,pg_get_userbyid(p.proowner) AS owner,n.nspname,
      has_function_privilege(${decodeURIComponent(new URL(shared.appUrl).username)},p.oid,'EXECUTE') AS app_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.oid IN ('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure,
        'knowledge_entry_read_baseline(uuid,uuid,jsonb,jsonb)'::regprocedure,
        'knowledge_entry_visible_body(uuid,jsonb,boolean)'::regprocedure,
        'knowledge_entry_visible_body_baseline(uuid,jsonb,boolean)'::regprocedure)`;
    expect(rows).toHaveLength(4);
    const owner = rows.find((row) => row.proname === "knowledge_entry_read")!.owner;
    for (const row of rows) {
      const [path] =
        await shared.admin`SELECT format('search_path=%I, pg_catalog, pg_temp',${row.nspname}::text) AS value`;
      expect(row.proconfig).toEqual([path!.value]);
      expect(row.owner).toBe(owner);
      expect(row.provolatile).toBe("v");
      expect(row.prosecdef).toBe(row.proname.startsWith("knowledge_entry_read"));
      expect(row.app_execute).toBe(row.proname.startsWith("knowledge_entry_read"));
    }
  }, 180_000);

  test("an app-owned temporary relation cannot shadow privileged endpoint projection", async () => {
    const [member] = await readListing(app, fixture, { groupId: fixture.groupId, limit: 1 });
    const request = { operation: "get", entryId: member!.id };
    const expected = await readListing(app, fixture, request);
    expect(expected[0]!.revision.groupIds).toEqual([fixture.groupId]);
    const [owner] = await shared.admin`SELECT pg_get_userbyid(proowner) AS name FROM pg_proc
      WHERE oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
    // An empty sentinel only: no executable payload or forged content. Give the
    // capability owner read access so the test detects wrong relation resolution,
    // rather than passing/failing merely because the sentinel lacks a grant.
    await app`CREATE TEMP TABLE knowledge_entries(id uuid,account_id uuid,archived boolean,
      published_revision_id uuid,latest_revision_id uuid)`;
    try {
      await app`GRANT SELECT ON pg_temp.knowledge_entries TO ${app(owner!.name as string)}`;
      expect(await readListing(app, fixture, request)).toEqual(expected);
      expect(await readListing(app, fixture, request, true)).toEqual(expected);
    } finally {
      await app`DROP TABLE pg_temp.knowledge_entries`;
    }
  }, 180_000);

  test("the migration pins the actual embedded schema, not public or an implicit temp path", async () => {
    const migration = await readFile(
      new URL("../drizzle/0468_knowledge_relationship_projection.sql", import.meta.url),
      "utf8",
    );
    const schema = `Knowledge_embedded_${crypto.randomUUID().replaceAll("-", "")}`;
    const rollback = new Error("rollback metadata-only embedded fixture");
    try {
      await shared.admin.begin(async (tx) => {
        await tx`CREATE SCHEMA ${tx(schema)}`;
        await tx`SET LOCAL search_path = ${tx(schema)}, public`;
        // This test checks migration metadata only. The app-role test above
        // executes the real migrated routines, tables and recursive ACL checks.
        await tx`SET LOCAL check_function_bodies = off`;
        await tx.unsafe(migration);
        const [row] =
          await tx`SELECT p.proconfig,format('search_path=%I, pg_catalog, pg_temp',${schema}::text) AS expected
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname=${schema} AND p.proname='knowledge_entry_visible_body'`;
        expect(row!.proconfig).toEqual([row!.expected]);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }, 180_000);

  test("exact JSON parity for root/collection lists, search, history, details and cursor boundaries", async () => {
    for (const request of [
      { rootOnly: true },
      { groupId: fixture.groupId },
      { kind: "note" },
      { scope: "workspace" },
      { scope: "personal" },
      { scope: "organization" },
      { query: "Member", mode: "keyword" },
      { query: "Member", mode: "hybrid" },
      { query: "absent", mode: "vector" },
      { view: "archived" },
      { view: "rejected" },
      { view: "needs_review" },
      { entryId: fixture.groupId, operation: "get" },
      { entryId: fixture.sourceId, operation: "history" },
      { afterId: fixture.groupId, afterScore: 1 },
      { afterId: fixture.groupId, afterScore: -1 },
    ])
      await parity({ limit: 20, ...request });
    const rows = await parity({ limit: 1, groupId: fixture.groupId });
    expect(rows).toHaveLength(2); // take + one, never an unbounded result
    await parity({ operation: "get", entryId: rows[0]!.id });
    await parity({ operation: "history", entryId: rows[0]!.id });
    await parity({ operation: "history", entryId: rows[0]!.id, beforeRevision: 2 });
    await parity({ operation: "get", entryId: rows[0]!.id, revisionId: rows[0]!.revision.id });
  }, 180_000);

  test("0469 excludes typed incidental sources that the historical read exposed", async () => {
    const f = await seedListingFixture(shared.admin, 4);
    await shared.admin`UPDATE knowledge_entries SET prepared_file_id=${f.sourceFileId} WHERE id=${f.sourceId}`;
    const before = await readListing(app, f, { limit: 20 }, true);
    const after = await readListing(app, f, { limit: 20 });
    expect(before.map((entry) => entry.id)).toContain(f.sourceId);
    expect(after.map((entry) => entry.id)).not.toContain(f.sourceId);
    expect(after).toEqual(before.filter((entry) => entry.id !== f.sourceId));
    expect(await readListing(app, f, { limit: 20, includeEvidence: true })).toEqual(before);
    expect(await readListing(app, f, { operation: "get", entryId: f.sourceId })).toEqual(
      await readListing(app, f, { operation: "get", entryId: f.sourceId }, true),
    );
    expect(
      (await readListing(app, f, { query: "Source", mode: "keyword" }, true)).map(
        (entry) => entry.id,
      ),
    ).toContain(f.sourceId);
    expect(await readListing(app, f, { query: "Source", mode: "keyword" })).toEqual([]);
  }, 180_000);

  test("all pages retain exact ordering without gaps or duplicates", async () => {
    for (const limit of [7, 50]) {
      let afterId: string | undefined;
      const ids: string[] = [];
      for (;;) {
        const rows = await parity({
          limit,
          groupId: fixture.groupId,
          ...(afterId ? { afterId, afterScore: 0 } : {}),
        });
        ids.push(...rows.slice(0, limit).map((row) => row.id));
        if (rows.length <= limit) break;
        afterId = rows[limit - 1]!.id;
      }
      expect(ids).toHaveLength(80);
      expect(new Set(ids).size).toBe(80);
      expect(ids).toEqual([...ids].sort());
    }
  }, 180_000);

  test("archived and out-of-scope collection endpoints do not hide readable roots", async () => {
    const f = await seedListingFixture(shared.admin, 4);
    await shared.admin`UPDATE knowledge_entries SET archived=true WHERE id=${f.groupId}`;
    expect(await parity({ groupId: f.groupId }, f)).toEqual([]);
    const roots = await parity({ rootOnly: true }, f);
    expect(roots).toHaveLength(5);
    expect(roots.every((row) => row.revision.groupIds.length === 0)).toBe(true);
    await shared.admin`UPDATE knowledge_entries SET archived=false,scope='personal',scope_workspace_id=NULL,
      scope_subject_id='user:another-owner' WHERE id=${f.groupId}`;
    expect(await parity({ groupId: f.groupId }, f)).toEqual([]);
    expect(await parity({ rootOnly: true }, f)).toHaveLength(5);
  }, 180_000);

  test("source revocation propagates through evidence but not discovery relationships", async () => {
    const f = await seedListingFixture(shared.admin, 24);
    const before = await parity({ limit: 50, groupId: f.groupId }, f);
    await shared.admin`UPDATE files SET status='pending' WHERE id=${f.sourceFileId}`;
    const denied = await parity({ limit: 50, groupId: f.groupId }, f);
    expect(denied.length).toBeLessThan(before.length);
    expect(denied.length).toBeGreaterThan(0);
    for (const row of denied) {
      const details = await parity({ operation: "get", entryId: row.id }, f);
      expect(
        (details[0]!.revision as unknown as { entry: { relationships: unknown[] } }).entry
          .relationships,
      ).toEqual([]);
    }
    await shared.admin`UPDATE files SET status='ready' WHERE id=${f.sourceFileId}`;
    expect(await parity({ limit: 50, groupId: f.groupId }, f)).toEqual(before);
  }, 180_000);

  test("runtime remains execute-only and denies forged scope and review claims", async () => {
    const [role] = await app`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(role?.rolsuper).toBe(false);
    expect(role?.rolbypassrls).toBe(false);
    await expect(Promise.resolve(app`SELECT * FROM knowledge_entries`)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      Promise.resolve(
        app`SELECT knowledge_entry_read(${fixture.accountId},${fixture.workspaceId},${app.json(fixture.actor)},'{}')`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const noReview = { ...fixture, actor: { ...fixture.actor, review: false } };
    for (const baseline of [false, true]) {
      await expect(
        readListing(app, noReview, { view: "needs_review" }, baseline),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        readListing(app, noReview, { operation: "history", entryId: fixture.groupId }, baseline),
      ).rejects.toMatchObject({ code: "42501" });
    }
  }, 180_000);

  test("endpoint projection preserves duplicates, order, pending fallback and published-first choice", async () => {
    const f = await seedListingFixture(shared.admin, 0);
    const pendingId = crypto.randomUUID();
    const pendingRevision = crypto.randomUUID();
    const latestGroupRevision = crypto.randomUUID();
    const missingId = crypto.randomUUID();
    await shared.admin.begin(async (tx) => {
      await tx`SELECT set_config('opengeni.account_id',${f.accountId},true)`;
      await tx`INSERT INTO knowledge_entries(id,account_id,origin_workspace_id,scope,scope_workspace_id)
        VALUES(${pendingId},${f.accountId},${f.workspaceId},'workspace',${f.workspaceId})`;
      // The existing collection has an unavailable pending source dependency,
      // but its published revision remains the projection endpoint in BOTH views.
      for (const [id, entryId, number] of [
        [pendingRevision, pendingId, 1],
        [latestGroupRevision, f.groupId, 2],
      ] as const) {
        await tx`INSERT INTO knowledge_entry_revisions(id,account_id,entry_id,number,body,actor)
          VALUES(${id},${f.accountId},${entryId},${number},'{}','{}')`;
        await tx`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
          VALUES(${f.accountId},${entryId},${id},${number},'pending','{}')`;
        await tx`UPDATE knowledge_entries SET latest_revision_id=${id},version=${number} WHERE id=${entryId}`;
      }
      await tx`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,target_revision_id,relation)
        VALUES(${f.accountId},${f.groupId},${latestGroupRevision},0,${f.sourceId},${f.sourceRevisionId},'evidence')`;
      await tx`UPDATE files SET status='pending' WHERE id=${f.sourceFileId}`;
    });
    const foreign = await seedListingFixture(shared.admin, 0);
    const body = {
      content: "Exact retained text\u0000 and Unicode 🧪".repeat(1000),
      extra: { unchanged: true },
      groupIds: [pendingId, f.groupId, missingId, foreign.groupId, f.groupId],
      relationships: [
        { entryId: pendingId, relation: "related_to" },
        { entryId: f.groupId, relation: "depends_on" },
        { entryId: f.sourceId, relation: "related_to" },
      ],
    };
    const [owner] = await shared.admin`SELECT pg_get_userbyid(proowner) AS name FROM pg_proc
      WHERE oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
    for (const pending of [false, true]) {
      const result = await shared.admin.begin(async (tx) => {
        await tx`SET LOCAL ROLE ${tx(owner!.name as string)}`;
        await tx`SELECT set_config('opengeni.account_id',${f.accountId},true),set_config('opengeni.workspace_id',${f.workspaceId},true),
          set_config('opengeni.subject_id',${f.subjectId},true),set_config('opengeni.knowledge_actor_kind','human',true)`;
        // PostgreSQL JSON cannot store NUL; projection still preserves the exact
        // escaped text codec payload rather than decoding or rewriting it.
        const encoded = { ...body, content: body.content.replaceAll("\u0000", "\\u0000") };
        const [row] =
          await tx`SELECT knowledge_entry_visible_body(${f.accountId},${tx.json(encoded)},${pending}) AS current,
          knowledge_entry_visible_body_baseline(${f.accountId},${tx.json(encoded)},${pending}) AS baseline`;
        expect(row!.current).toEqual(row!.baseline);
        expect(row!.current.content).toBe(encoded.content);
        return row!.current;
      });
      expect(result.groupIds).toEqual(
        pending ? [pendingId, f.groupId, f.groupId] : [f.groupId, f.groupId],
      );
      expect(result.relationships).toEqual(
        pending ? body.relationships.slice(0, 2) : body.relationships.slice(1, 2),
      );
      expect(result.extra).toEqual(body.extra);
    }
  }, 180_000);
});
