import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { searchKnowledgeEntries } from "@opengeni/core";
import {
  createDb,
  saveKnowledgeEntry,
  getKnowledgeEntry,
  type KnowledgeContext,
} from "@opengeni/db";
import { knowledgeIndexChunks, type DocumentServices } from "@opengeni/documents";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createKnowledgeIndexingActivities } from "../src/activities/knowledge-indexing";
import type { ControlActivityServices } from "../src/activities/types";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-index-worker");
  if (!acquired) throw new Error("Knowledge indexing verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 6 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("worker resumes batches, meters committed chunks once, and serves scoped semantic excerpts", async () => {
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID();
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Index account')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Index workspace')`;
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: "user:knowledge-owner",
      writeScopes: ["personal", "workspace"],
      settingsScopes: ["personal"],
      review: true,
    },
  };
  const content = "A private supply agreement.  🚀\u0000 Original wording is retained.\n".repeat(
    850,
  );
  const saved = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "personal",
    entry: {
      kind: "source",
      title: "Acme contract",
      content,
      source: { kind: "manual", externalId: "acme-contract", retention: "full_text" },
    },
  });
  const chunks = [...knowledgeIndexChunks({ title: "Acme contract", content })];
  expect(chunks.length).toBeGreaterThan(32);
  let failProvider = true;
  let embedded = 0;
  const embedder: DocumentServices["embedder"] = {
    model: "knowledge-index-test",
    dimensions: 3,
    embedQuery: async () => [1, 0, 0],
    embedMany: async (texts) => {
      if (failProvider) throw new Error("provider unavailable");
      embedded += texts.length;
      return texts.map(() => [1, 0, 0]);
    },
  };
  const makeWorker = () =>
    createKnowledgeIndexingActivities(
      async () =>
        ({
          db: client.db,
          settings: { billingMode: "none", usageLimitsMode: "none" } as Settings,
          observability: { warn: () => undefined },
        }) as ControlActivityServices,
      async () => ({ embedder }) as DocumentServices,
    );
  expect((await makeWorker().indexKnowledge()).deferred).toBe(1);
  const [failed] =
    await shared.admin`SELECT next_index, state FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(failed).toMatchObject({ next_index: 0, state: "pending" });
  expect(
    (await searchKnowledgeEntries(client.db, context, { query: "supply" }, () => embedder)).entries,
  ).toHaveLength(1);
  expect(
    (
      await searchKnowledgeEntries(
        client.db,
        context,
        { query: "purchasing", mode: "vector" },
        () => embedder,
      )
    ).entries,
  ).toHaveLength(0);
  failProvider = false;
  await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second' WHERE revision_id=${saved.revisionId}`;
  expect((await makeWorker().indexKnowledge()).advanced).toBe(1);
  const [partial] =
    await shared.admin`SELECT next_index, completed_generation FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(partial).toMatchObject({ next_index: 32, completed_generation: null });
  // A new activity factory represents a worker restart; the database owns progress.
  expect((await makeWorker().indexKnowledge()).completed).toBe(1);
  expect(embedded).toBe(chunks.length);
  expect((await makeWorker().indexKnowledge()).completed).toBe(0);
  const [usage] =
    await shared.admin`SELECT sum(quantity)::int AS chunks FROM usage_events WHERE source_resource_id=${saved.revisionId}`;
  expect(usage?.chunks).toBe(chunks.length);
  const found = await searchKnowledgeEntries(
    client.db,
    context,
    { query: "purchasing", mode: "vector" },
    () => embedder,
  );
  expect(found.searchMode).toBe("vector");
  expect(found.entries.map((entry) => entry.id)).toEqual([saved.entryId]);
  const excerpt = found.entries[0]!.excerpts[0]!;
  expect(excerpt.text).toBe(content.slice(excerpt.start, excerpt.end));
  expect(excerpt.text).toContain("\u0000");
  const other: KnowledgeContext = {
    ...context,
    actor: { ...context.actor, subjectId: "user:other" } as KnowledgeContext["actor"],
  };
  expect(
    (await searchKnowledgeEntries(client.db, other, { query: "purchasing" }, () => embedder))
      .entries,
  ).toHaveLength(0);
  expect((await getKnowledgeEntry(client.db, context, saved.entryId))?.revision.entry.content).toBe(
    content,
  );
  const unavailable = {
    ...embedder,
    embedQuery: async () => {
      throw new Error("unavailable");
    },
  };
  const fallback = await searchKnowledgeEntries(
    client.db,
    context,
    { query: "supply" },
    () => unavailable,
  );
  expect(fallback.searchMode).toBe("keyword");
  expect(fallback.entries).toHaveLength(1);
  await expect(
    searchKnowledgeEntries(
      client.db,
      context,
      { query: "purchasing", mode: "vector" },
      () => unavailable,
    ),
  ).rejects.toThrow("unavailable");
});
