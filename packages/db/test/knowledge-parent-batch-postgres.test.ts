import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import type { SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  listingDatabase,
  seedListingFixture,
  type ListingFixture,
} from "./fixtures/knowledge-collection-listing";
import { installPreBatchKnowledgeBaseline } from "./fixtures/knowledge-batch-visibility-baseline";

let shared: SharedTestDatabase;
let app: postgres.Sql;
beforeAll(async () => {
  shared = await listingDatabase();
  app = postgres(shared.appUrl, { max: 1, prepare: false });
  await installPreBatchKnowledgeBaseline(shared.admin, shared.appUrl, true);
}, 180_000);
afterAll(async () => {
  await app?.end();
  await shared?.release();
}, 60_000);

async function read(
  tx: postgres.Sql | postgres.TransactionSql,
  f: ListingFixture,
  request: Record<string, postgres.JSONValue>,
  baseline = false,
) {
  await tx`SELECT set_config('opengeni.account_id',${f.accountId},true),set_config('opengeni.workspace_id',${f.workspaceId},true),
    set_config('opengeni.subject_id',${f.subjectId},true),set_config('opengeni.principal_kind','human_session',true)`;
  const [row] = baseline
    ? await tx`SELECT knowledge_entry_read_before_parents(${f.accountId},${f.workspaceId},${tx.json(f.actor)},${tx.json(request)}) AS result`
    : await tx`SELECT knowledge_entry_read(${f.accountId},${f.workspaceId},${tx.json(f.actor)},${tx.json(request)}) AS result`;
  return row!.result as Array<{
    id: string;
    score: number;
    revision: { id: string; groupIds: string[] };
  }>;
}
async function parity(f: ListingFixture, request: Record<string, postgres.JSONValue>) {
  const base = await app.begin((tx) => read(tx, f, request, true));
  const actual = await app.begin((tx) => read(tx, f, request));
  expect(JSON.stringify(actual)).toBe(JSON.stringify(base));
  return actual;
}

test("full results, root/collection combinations, search and cursor pages match the preceding reader", async () => {
  const f = await seedListingFixture(shared.admin, 48);
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await app.unsafe(`SET plan_cache_mode=${mode}`);
    for (const request of [
      {},
      { rootOnly: true },
      { groupId: f.groupId },
      { groupId: f.groupId, rootOnly: true },
      { groupId: crypto.randomUUID() },
      { rootOnly: true, scope: "personal" },
      { rootOnly: true, query: "Member", mode: "keyword" },
      { groupId: f.groupId, query: "Member", mode: "hybrid" },
      { groupId: f.groupId, query: "nonexistent", mode: "keyword" },
      { rootOnly: true, view: "needs_review" },
      { groupId: f.groupId, view: "archived" },
      { operation: "get", entryId: f.groupId },
      { operation: "history", entryId: f.groupId },
    ])
      await parity(f, { operation: "list", limit: 7, ...request });
    const ids: string[] = [];
    let cursor: Record<string, postgres.JSONValue> = {};
    for (;;) {
      const page = await parity(f, { operation: "list", groupId: f.groupId, limit: 7, ...cursor });
      ids.push(...page.slice(0, 7).map((row) => row.id));
      if (page.length <= 7) break;
      cursor = { afterId: page[6]!.id, afterScore: page[6]!.score };
    }
    expect(ids).toHaveLength(48);
    expect(new Set(ids).size).toBe(48);
  }
}, 180_000);

test("archive, private and wrong-kind parents preserve roots and membership semantics", async () => {
  const f = await seedListingFixture(shared.admin, 8);
  expect(await parity(f, { groupId: f.groupId, limit: 20 })).toHaveLength(8);
  await shared.admin`UPDATE knowledge_entries SET archived=true WHERE id=${f.groupId}`;
  expect(await parity(f, { groupId: f.groupId, limit: 20 })).toEqual([]);
  expect(await parity(f, { rootOnly: true, limit: 20 })).toHaveLength(9);
  await shared.admin`UPDATE knowledge_entries SET archived=false,scope='personal',scope_workspace_id=NULL,scope_subject_id='user:other' WHERE id=${f.groupId}`;
  expect(await parity(f, { groupId: f.groupId })).toEqual([]);
  await parity(f, { rootOnly: true, limit: 20 });
  await shared.admin`UPDATE knowledge_entries SET scope='workspace',scope_workspace_id=${f.workspaceId},scope_subject_id=NULL WHERE id=${f.groupId}`;
  const [next] =
    await shared.admin`INSERT INTO knowledge_entry_revisions(account_id,entry_id,number,body,preview,actor)
    SELECT account_id,entry_id,2,jsonb_set(body,'{kind}','"note"'),preview,actor FROM knowledge_entry_revisions
    WHERE entry_id=${f.groupId} AND number=1 RETURNING id`;
  await shared.admin`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
    VALUES(${f.accountId},${f.groupId},${next!.id},2,'published','{}')`;
  await shared.admin`UPDATE knowledge_entries SET version=2,published_revision_id=${next!.id},latest_revision_id=${next!.id} WHERE id=${f.groupId}`;
  // The old explicit collection selector does not require a group kind; roots do.
  expect(await parity(f, { groupId: f.groupId, limit: 20 })).toHaveLength(8);
  expect(await parity(f, { rootOnly: true, limit: 20 })).toHaveLength(10);
}, 180_000);

test("parent evidence revocation is observed on the next read in the same transaction", async () => {
  const f = await seedListingFixture(shared.admin, 8);
  const [parent] =
    await shared.admin`SELECT published_revision_id AS revision FROM knowledge_entries WHERE id=${f.groupId}`;
  await shared.admin`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,target_revision_id,relation)
    VALUES(${f.accountId},${f.groupId},${parent!.revision},99,${f.sourceId},${f.sourceRevisionId},'evidence')`;
  await app.begin(async (tx) => {
    const before = await read(tx, f, { groupId: f.groupId, limit: 20 });
    expect(before).toHaveLength(8);
    await shared.admin`UPDATE files SET status='pending' WHERE id=${f.sourceFileId}`;
    expect(await read(tx, f, { groupId: f.groupId, limit: 20 })).toEqual([]);
    await shared.admin`UPDATE files SET status='ready' WHERE id=${f.sourceFileId}`;
    expect(await read(tx, f, { groupId: f.groupId, limit: 20 })).toEqual(before);
  });
  await parity(f, { rootOnly: true, limit: 20 });
}, 180_000);

test("pending parent heads and historical member links keep their separate revision identities", async () => {
  const f = await seedListingFixture(shared.admin, 4);
  const [parent] =
    await shared.admin`INSERT INTO knowledge_entry_revisions(account_id,entry_id,number,body,preview,actor)
    SELECT account_id,entry_id,2,body,preview,actor FROM knowledge_entry_revisions
    WHERE entry_id=${f.groupId} AND number=1 RETURNING id`;
  await shared.admin`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
    VALUES(${f.accountId},${f.groupId},${parent!.id},2,'pending','{}')`;
  await shared.admin`UPDATE knowledge_entries SET version=2,latest_revision_id=${parent!.id} WHERE id=${f.groupId}`;
  // Seed independent pending member revisions, leaving published links intact.
  await shared.admin`INSERT INTO knowledge_entry_revisions(account_id,entry_id,number,body,preview,actor)
    SELECT account_id,entry_id,3,body,preview,actor FROM knowledge_entry_revisions
    WHERE account_id=${f.accountId} AND number=2 AND entry_id<>${f.groupId}`;
  await shared.admin`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
    SELECT account_id,entry_id,id,3,'pending','{}' FROM knowledge_entry_revisions
    WHERE account_id=${f.accountId} AND number=3`;
  await shared.admin`UPDATE knowledge_entries e SET version=3,latest_revision_id=r.id FROM knowledge_entry_revisions r
    WHERE r.account_id=${f.accountId} AND r.entry_id=e.id AND r.number=3`;
  expect(await parity(f, { view: "needs_review", groupId: f.groupId, limit: 20 })).toEqual([]);
  expect(await parity(f, { groupId: f.groupId, limit: 20 })).toHaveLength(4);
  await shared.admin`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,relation)
    SELECT account_id,entry_id,id,0,${f.groupId},'group' FROM knowledge_entry_revisions
    WHERE account_id=${f.accountId} AND number=3`;
  expect(await parity(f, { view: "needs_review", groupId: f.groupId, limit: 20 })).toHaveLength(4);
  await parity(f, { view: "needs_review", rootOnly: true, limit: 20 });
  // Pending-only dependency denial must not hide the published parent revision.
  await shared.admin`INSERT INTO knowledge_entry_links(account_id,entry_id,revision_id,ordinal,target_entry_id,target_revision_id,relation)
    VALUES(${f.accountId},${f.groupId},${parent!.id},99,${f.sourceId},${f.sourceRevisionId},'evidence')`;
  await shared.admin`UPDATE files SET status='pending' WHERE id=${f.sourceFileId}`;
  expect(await parity(f, { view: "needs_review", groupId: f.groupId, limit: 20 })).toEqual([]);
  expect((await parity(f, { groupId: f.groupId, limit: 20 })).length).toBeGreaterThan(0);
}, 180_000);

test("rolling replacement retains security metadata and rejects ambiguous source", async () => {
  const rows =
    await shared.admin`SELECT p.proowner,p.proacl,p.proconfig,p.provolatile,p.prosecdef FROM pg_proc p
    WHERE p.oid IN ('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure,'knowledge_entry_read_before_parents(uuid,uuid,jsonb,jsonb)'::regprocedure)`;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(rows[1]);
  const migration = await readFile(
    new URL("../drizzle/0936_batched_knowledge_parent_visibility.sql", import.meta.url),
    "utf8",
  );
  await expect(shared.admin.begin((tx) => tx.unsafe(migration))).rejects.toMatchObject({
    code: "P0001",
  });
});

test("actual restricted-role plans batch shared parents in custom and generic modes", async () => {
  const f = await seedListingFixture(shared.admin, 240);
  const notices: string[] = [];
  const instrument = postgres(shared.adminUrl, {
    max: 1,
    onnotice: (n) => {
      if (n.message?.includes("plan:\n")) notices.push(n.message);
    },
  });
  try {
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      const counts: number[] = [];
      for (const baseline of [true, false]) {
        notices.length = 0;
        await instrument.begin(async (tx) => {
          await tx`LOAD 'auto_explain'`;
          await tx`SET LOCAL auto_explain.log_min_duration=0`;
          await tx`SET LOCAL auto_explain.log_analyze=true`;
          await tx`SET LOCAL auto_explain.log_buffers=true`;
          await tx`SET LOCAL auto_explain.log_nested_statements=true`;
          await tx`SET LOCAL auto_explain.log_format='json'`;
          await tx`SET LOCAL client_min_messages='log'`;
          await tx.unsafe(`SET LOCAL plan_cache_mode=${mode}`);
          await tx`SET LOCAL ROLE ${tx(decodeURIComponent(new URL(shared.appUrl).username))}`;
          const [role] =
            await tx`SELECT rolsuper,rolbypassrls,current_setting('row_security') AS rls FROM pg_roles WHERE rolname=current_user`;
          expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rls: "on" });
          expect(await read(tx, f, { groupId: f.groupId, limit: 20 }, baseline)).toHaveLength(21);
        });
        const plans = notices.map((n) => JSON.parse(n.slice(n.indexOf("plan:\n") + 6)));
        counts.push(
          plans.filter((p) =>
            p["Query Text"].includes("SELECT EXISTS(SELECT 1 FROM knowledge_revisions_visible("),
          ).length,
        );
      }
      expect(counts[0]).toBe(261);
      expect(counts[1]).toBe(21);
    }
  } finally {
    await instrument.end();
  }
}, 180_000);
