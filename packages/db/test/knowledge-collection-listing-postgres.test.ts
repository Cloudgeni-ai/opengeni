import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
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
