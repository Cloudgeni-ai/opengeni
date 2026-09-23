import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import { searchKnowledgeEntries } from "@opengeni/core";
import {
  createDb,
  getBillingBalance,
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
    await shared.admin`SELECT sum(quantity)::int AS chunks FROM usage_events WHERE source_resource_id=${saved.revisionId} AND event_type='document.indexed'`;
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

test("paid indexing waits for funding, settles accepted batches and finishes a funded generation in debt", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Funded index account')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Funded index workspace')`;
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: "user:funded-index-owner",
      writeScopes: ["workspace"],
      settingsScopes: ["workspace"],
      review: true,
    },
  };
  let calls = 0;
  const embedder: DocumentServices["embedder"] = {
    model: "paid-knowledge-index",
    dimensions: 3,
    embedMany: async (inputs) => {
      calls++;
      return inputs.map(() => [1, 0, 0]);
    },
    embedQuery: async () => {
      calls++;
      return [1, 0, 0];
    },
  };
  const settings = {
    billingMode: "stripe",
    usageLimitsMode: "managed",
    staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingCreditsActivatedAt: "2026-01-01T00:00:00Z",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  const makeWorker = () =>
    createKnowledgeIndexingActivities(
      async () =>
        ({
          db: client.db,
          settings,
          observability: { warn: () => undefined },
        }) as ControlActivityServices,
      async () => ({ embedder }) as DocumentServices,
    );
  const worker = makeWorker();
  // Prime the worker's database-clock paid cutoff before this source is queued.
  expect((await worker.indexKnowledge()).completed).toBe(0);
  const saved = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "workspace",
    entry: { kind: "fact", title: "Funded contract", content: "Funded terms ".repeat(4500) },
  });
  // Source retention and keyword retrieval remain available at zero.
  expect(
    (
      await searchKnowledgeEntries(
        client.db,
        context,
        { query: "Funded", mode: "keyword" },
        () => embedder,
        settings,
      )
    ).entries,
  ).toHaveLength(1);
  expect((await worker.indexKnowledge()).deferred).toBe(1);
  expect(calls).toBe(0);
  const [waiting] =
    await shared.admin`SELECT next_index,last_failure FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(waiting).toMatchObject({ next_index: 0, last_failure: "waiting_for_funding" });
  const keyword = await searchKnowledgeEntries(
    client.db,
    context,
    { query: "Funded" },
    () => embedder,
    settings,
  );
  expect(keyword.searchMode).toBe("keyword");
  await expect(
    searchKnowledgeEntries(
      client.db,
      context,
      { query: "Funded", mode: "vector" },
      () => embedder,
      settings,
    ),
  ).rejects.toThrow("insufficient OpenGeni credits");
  expect(calls).toBe(0);
  await shared.admin`INSERT INTO credit_ledger_entries(account_id,workspace_id,type,amount_micros,source_type,source_id,idempotency_key) VALUES (${accountId},NULL,'grant',1,'test',${saved.revisionId},${`funded-index:${saved.revisionId}`})`;
  await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second' WHERE revision_id=${saved.revisionId}`;
  expect((await worker.indexKnowledge()).advanced).toBe(1);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBeLessThan(0);
  const [frozen] = await shared.admin`
    SELECT billing_mode,billing_rate_micros_per_million_bytes AS rate
    FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(frozen?.billing_mode).toBe("credits");
  expect(Number(frozen?.rate)).toBe(1_000_000);
  // Retrying the next batch after a tariff change must use the generation's
  // originally disclosed price, not the new process configuration.
  settings.documentEmbeddingRateMicrosPerMillionBytes = 2_000_000;
  // A restarted worker must honor the first batch's frozen paid policy even
  // though the source predates this process and the balance is now negative.
  expect((await makeWorker().indexKnowledge()).completed).toBe(1);
  const after = await getBillingBalance(client.db, accountId);
  expect((await worker.indexKnowledge()).completed).toBe(0);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(after.balanceMicros);
  const [ledgers] =
    await shared.admin`SELECT count(*)::int AS n FROM credit_ledger_entries WHERE source_type='knowledge_revision' AND source_id=${saved.revisionId}`;
  expect(ledgers?.n).toBe(2);
  const [settled] = await shared.admin<Array<{ bytes: number; charged: number }>>`
    SELECT (SELECT coalesce(sum(quantity),0)::bigint FROM usage_events
       WHERE event_type='document.embedding_bytes' AND source_resource_id=${saved.revisionId}) AS bytes,
      (SELECT coalesce(-sum(amount_micros),0)::bigint FROM credit_ledger_entries
       WHERE source_type='knowledge_revision' AND source_id=${saved.revisionId}) AS charged`;
  expect(Number(settled?.charged)).toBe(Number(settled?.bytes));
  expect(calls).toBe(2);
  expect(
    (
      await searchKnowledgeEntries(
        client.db,
        context,
        { query: "Funded" },
        () => embedder,
        settings,
      )
    ).searchMode,
  ).toBe("keyword");
  expect(calls).toBe(2);
});

test("a queued Knowledge generation remains unpriced when paid mode starts later", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Legacy queued index')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Legacy index workspace')`;
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: "user:legacy-index-owner",
      writeScopes: ["workspace"],
      settingsScopes: ["workspace"],
      review: true,
    },
  };
  const saved = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "workspace",
    entry: { kind: "fact", title: "Queued earlier", content: "Indexed without retroactive charge" },
  });
  const settings = {
    billingMode: "stripe",
    usageLimitsMode: "managed",
    staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingCreditsActivatedAt: new Date(Date.now() + 60_000).toISOString(),
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  const embedder: DocumentServices["embedder"] = {
    model: "legacy-index-test",
    dimensions: 3,
    embedMany: async (inputs) => inputs.map(() => [1, 0, 0]),
    embedQuery: async () => [1, 0, 0],
  };
  // The worker starts only after the source has been queued. Its current
  // credit setting cannot be projected backward onto that queued source.
  const worker = createKnowledgeIndexingActivities(
    async () =>
      ({
        db: client.db,
        settings,
        observability: { warn: () => undefined },
      }) as ControlActivityServices,
    async () => ({ embedder }) as DocumentServices,
  );
  expect((await worker.indexKnowledge()).completed).toBe(1);
  const [job] =
    await shared.admin`SELECT billing_mode,billed_generation FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(job).toMatchObject({ billing_mode: "usage_only", billed_generation: 1 });
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(0);
});
