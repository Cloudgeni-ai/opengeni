import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createDb } from "../src/database";
import { listKnowledgeEntries, type KnowledgeContext } from "../src/knowledge-entries";
import { seedListingFixture, type ListingFixture } from "./fixtures/knowledge-collection-listing";

const cutoff = "2026-10-01T00:00:00.000Z";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-created-since");
  if (!acquired) throw new Error("Knowledge creation-date verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function context(f: ListingFixture): KnowledgeContext {
  return {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: f.subjectId,
      writeScopes: ["workspace", "personal", "organization"],
      settingsScopes: ["workspace", "personal"],
      review: true,
    },
  };
}
async function memberIds(f: ListingFixture) {
  const rows = await shared.admin<{ id: string }[]>`SELECT id FROM knowledge_entries
    WHERE account_id=${f.accountId} AND id NOT IN (${f.groupId},${f.sourceId}) ORDER BY id`;
  return rows.map((row) => row.id);
}
async function createdAt(id: string, value: string) {
  await shared.admin`UPDATE knowledge_entries SET created_at=${value}::timestamptz,
    updated_at='2026-10-06T08:00:00Z' WHERE id=${id}`;
}

test("original creation filters before ranked take+one pages, including matches beyond an unfiltered page", async () => {
  const f = await seedListingFixture(shared.admin, 80);
  const ids = await memberIds(f);
  for (const [index, id] of ids.entries())
    await createdAt(id, index < 65 ? "2026-09-30T23:59:59.999Z" : cutoff);
  // The fixture has two revisions per entry, both created now. An old entry's
  // recent revision and updated_at must not make it new.
  await shared.admin`UPDATE knowledge_index_jobs SET state='ready',completed_generation=generation
    WHERE account_id=${f.accountId}`;
  await shared.admin`INSERT INTO knowledge_entry_vectors
    (account_id,entry_id,revision_id,generation,chunk_index,model,dimensions,field,start_offset,end_offset,text,text_codec_version,embedding)
    SELECT r.account_id,r.entry_id,r.id,j.generation,0,'creation-test',3,'title',0,6,'Member',1,'[1,0,0]'::vector
    FROM knowledge_entry_revisions r JOIN knowledge_index_jobs j ON j.revision_id=r.id
    WHERE r.account_id=${f.accountId}`;
  const embedding = { model: "creation-test", values: [1, 0, 0] };
  expect(
    (
      await listKnowledgeEntries(client.db, context(f), { groupId: f.groupId, limit: 50 })
    ).entries.map((entry) => entry.id),
  ).toEqual(ids.slice(0, 50));
  for (const mode of ["keyword", "hybrid", "vector"] as const) {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listKnowledgeEntries(
        client.db,
        context(f),
        {
          query: "Member",
          mode,
          groupId: f.groupId,
          createdSince: cutoff,
          limit: 5,
          ...(cursor ? { cursor } : {}),
        },
        embedding,
      );
      expect(page.entries).toHaveLength(5);
      found.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual(ids.slice(65));
    expect(new Set(found).size).toBe(15);
  }
  expect(
    (
      await listKnowledgeEntries(client.db, context(f), {
        groupId: f.groupId,
        createdSince: "2026-10-01T02:00:00+02:00",
        limit: 50,
      })
    ).entries.map((entry) => entry.id),
  ).toEqual(ids.slice(65));
  expect(
    (
      await listKnowledgeEntries(client.db, context(f), {
        groupId: f.groupId,
        createdSince: "2026-10-01T00:00:00.001Z",
      })
    ).entries,
  ).toEqual([]);
}, 180_000);

test("every view and scope uses original creation without widening private visibility", async () => {
  for (const view of ["published", "needs_review", "archived", "rejected"] as const) {
    const f = await seedListingFixture(shared.admin, 8);
    const ids = await memberIds(f);
    for (const [index, id] of ids.entries()) {
      const scope = (["workspace", "personal", "organization", "personal"] as const)[
        Math.floor(index / 2)
      ]!;
      await shared.admin`UPDATE knowledge_entries SET scope=${scope},
        scope_workspace_id=${scope === "workspace" ? f.workspaceId : null},
        scope_subject_id=${scope === "personal" ? (index >= 6 ? "user:someone-else" : f.subjectId) : null},
        archived=${view === "archived"} WHERE id=${id}`;
      await createdAt(id, index % 2 === 0 ? "2026-09-01T00:00:00Z" : cutoff);
    }
    if (view === "needs_review" || view === "rejected") {
      await shared.admin`INSERT INTO knowledge_entry_decisions(account_id,entry_id,revision_id,version,outcome,actor)
        SELECT e.account_id,e.id,e.latest_revision_id,3,${view === "needs_review" ? "pending" : "rejected"},'{}'
        FROM knowledge_entries e WHERE e.account_id=${f.accountId} AND e.id NOT IN (${f.groupId},${f.sourceId})`;
      await shared.admin`UPDATE knowledge_entries e SET version=3,published_revision_id=r.id
        FROM knowledge_entry_revisions r WHERE r.entry_id=e.id AND r.number=1
          AND e.account_id=${f.accountId} AND e.id NOT IN (${f.groupId},${f.sourceId})`;
    }
    const expected = [ids[1]!, ids[3]!, ids[5]!];
    expect(
      (
        await listKnowledgeEntries(client.db, context(f), {
          kind: "note",
          view,
          createdSince: cutoff,
        })
      ).entries.map((entry) => entry.id),
    ).toEqual(expected);
    for (const [index, scope] of (["workspace", "personal", "organization"] as const).entries()) {
      expect(
        (
          await listKnowledgeEntries(client.db, context(f), {
            kind: "note",
            view,
            scope,
            createdSince: cutoff,
          })
        ).entries.map((entry) => entry.id),
      ).toEqual([expected[index]!]);
    }
  }
}, 180_000);

test("creation-date cursors bind the cutoff and invalid dates fail before querying", async () => {
  const f = await seedListingFixture(shared.admin, 4);
  const page = await listKnowledgeEntries(client.db, context(f), {
    kind: "note",
    createdSince: cutoff,
    limit: 1,
  });
  expect(page.nextCursor).not.toBeNull();
  for (const createdSince of [undefined, "2026-10-02T00:00:00Z"])
    await expect(
      listKnowledgeEntries(client.db, context(f), {
        kind: "note",
        createdSince,
        limit: 1,
        cursor: page.nextCursor!,
      }),
    ).rejects.toThrow("This search changed");
  const unfiltered = await listKnowledgeEntries(client.db, context(f), { kind: "note", limit: 1 });
  await expect(
    listKnowledgeEntries(client.db, context(f), {
      kind: "note",
      createdSince: cutoff,
      limit: 1,
      cursor: unfiltered.nextCursor!,
    }),
  ).rejects.toThrow("This search changed");
  for (const createdSince of ["not-a-date", "2026-10-01", "2026-10-01T00:00:00"])
    await expect(listKnowledgeEntries({} as never, context(f), { createdSince })).rejects.toThrow();
}, 180_000);

test("rolling migration retains the exact read capability metadata", async () => {
  const [metadata] =
    await shared.admin`SELECT p.prosecdef,p.proowner,p.proacl,p.proconfig,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p WHERE p.oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
  expect(metadata!.prosecdef).toBe(true);
  expect(metadata!.definition.indexOf("e.created_at >=")).toBeLessThan(
    metadata!.definition.indexOf("), scored AS ("),
  );
  expect(metadata!.definition).not.toContain("r.created_at >= (p_request->>'createdSince')");
  // Exercise owner execution against a historical definition in a rollback-only
  // transaction, including its ACL and hardened embedded-schema search_path.
  const migration = await readFile(
    new URL("../drizzle/0638_knowledge_entry_created_since.sql", import.meta.url),
    "utf8",
  );
  const rollback = new Error("rollback creation-date migration metadata test");
  try {
    await shared.admin.begin(async (tx) => {
      const historical = metadata!.definition.replace(
        /\n      -- Filter the authorized candidate set[\s\S]*?OR e\.created_at >= \(p_request->>'createdSince'\)::timestamptz\)/,
        "",
      );
      expect(historical).not.toContain("createdSince");
      await tx.unsafe(historical);
      const [owner] = await tx`SELECT pg_get_userbyid(${metadata!.proowner}::oid) AS name`;
      await tx`SET LOCAL ROLE ${tx(owner!.name)}`;
      await tx.unsafe(migration);
      const [after] = await tx`SELECT p.prosecdef,p.proowner,p.proacl,p.proconfig FROM pg_proc p
        WHERE p.oid='knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure`;
      expect(after).toEqual({
        prosecdef: metadata!.prosecdef,
        proowner: metadata!.proowner,
        proacl: metadata!.proacl,
        proconfig: metadata!.proconfig,
      });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}, 180_000);
