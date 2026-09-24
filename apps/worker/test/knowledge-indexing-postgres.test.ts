import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
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
const fixtureAccounts: string[] = [];
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
afterEach(async () => {
  // A later worker may re-claim a ready job when its embedding model changes.
  // Keep the disposable accounts isolated even if a test assertion fails.
  for (const accountId of fixtureAccounts.splice(0)) {
    await shared.admin`DELETE FROM managed_accounts WHERE id=${accountId}`;
  }
});

test("worker resumes batches, meters committed chunks once, and serves scoped semantic excerpts", async () => {
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
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
  fixtureAccounts.push(accountId);
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
  ).rejects.toThrow("Knowledge vector search needs OpenGeni credits");
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

test("a frozen paid generation pauses across a billing-mode rollback and resumes at its original tariff", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Rollback index account')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Rollback index workspace')`;
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: "user:rollback-index-owner",
      writeScopes: ["workspace"],
      settingsScopes: ["workspace"],
      review: true,
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
  let calls = 0;
  const embedder: DocumentServices["embedder"] = {
    model: "paid-rollback-index-test",
    dimensions: 3,
    embedMany: async (inputs) => {
      calls++;
      return inputs.map(() => [1, 0, 0]);
    },
    embedQuery: async () => [1, 0, 0],
  };
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
  const content = "A paid revision that spans multiple indexing batches. ".repeat(1600);
  const saved = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "workspace",
    entry: { kind: "fact", title: "Rollback contract", content },
  });
  const chunks = [...knowledgeIndexChunks({ title: "Rollback contract", content })];
  expect(chunks.length).toBeGreaterThan(32);
  await shared.admin`INSERT INTO credit_ledger_entries(account_id,type,amount_micros,idempotency_key)
    VALUES(${accountId},'grant',1000000,${`rollback-index:${saved.revisionId}`})`;
  expect((await worker.indexKnowledge()).advanced).toBe(1);
  expect(calls).toBe(1);
  const [firstBatch] = await shared.admin<
    Array<{
      next_index: number;
      billing_mode: string;
      rate: number;
      vectors: number;
      debits: number;
    }>
  >`
    SELECT j.next_index,j.billing_mode,j.billing_rate_micros_per_million_bytes AS rate,
      (SELECT count(*)::int FROM knowledge_entry_vectors WHERE revision_id=${saved.revisionId}) AS vectors,
      (SELECT count(*)::int FROM credit_ledger_entries WHERE source_id=${saved.revisionId}
        AND type='document_embedding_debit') AS debits
    FROM knowledge_index_jobs j WHERE j.revision_id=${saved.revisionId}`;
  expect(firstBatch?.next_index).toBe(32);
  expect(firstBatch?.billing_mode).toBe("credits");
  expect(Number(firstBatch?.rate)).toBe(1_000_000);
  expect(firstBatch?.vectors).toBe(32);
  expect(firstBatch?.debits).toBe(1);
  const balanceAfterFirstBatch = (await getBillingBalance(client.db, accountId)).balanceMicros;

  settings.documentEmbeddingBillingMode = "usage_only";
  settings.documentEmbeddingRateMicrosPerMillionBytes = 2_000_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    expect((await makeWorker().indexKnowledge()).deferred).toBe(1);
    const [paused] = await shared.admin<
      Array<{ state: string; next_index: number; vectors: number; debits: number; indexed: number }>
    >`
      SELECT j.state,j.next_index,
        (SELECT count(*)::int FROM knowledge_entry_vectors WHERE revision_id=${saved.revisionId}) AS vectors,
        (SELECT count(*)::int FROM credit_ledger_entries WHERE source_id=${saved.revisionId}
          AND type='document_embedding_debit') AS debits,
        (SELECT coalesce(sum(quantity),0)::int FROM usage_events WHERE source_resource_id=${saved.revisionId}
          AND event_type='document.indexed') AS indexed
      FROM knowledge_index_jobs j WHERE j.revision_id=${saved.revisionId}`;
    expect(paused).toMatchObject({
      state: "pending",
      next_index: 32,
      vectors: 32,
      debits: 1,
      indexed: 32,
    });
    expect(calls).toBe(1);
    expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(
      balanceAfterFirstBatch,
    );
    await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second'
      WHERE revision_id=${saved.revisionId}`;
  }
  expect(
    (
      await searchKnowledgeEntries(
        client.db,
        context,
        { query: "Rollback", mode: "keyword" },
        () => embedder,
        settings,
      )
    ).entries,
  ).toHaveLength(1);

  settings.documentEmbeddingBillingMode = "credits";
  expect((await makeWorker().indexKnowledge()).completed).toBe(1);
  expect(calls).toBe(2);
  const [settled] = await shared.admin<
    Array<{
      state: string;
      next_index: number;
      rate: number;
      bytes: number;
      charged: number;
      debits: number;
    }>
  >`
    SELECT j.state,j.next_index,j.billing_rate_micros_per_million_bytes AS rate,
      (SELECT coalesce(sum(quantity),0)::bigint FROM usage_events
        WHERE event_type='document.embedding_bytes' AND source_resource_id=${saved.revisionId}) AS bytes,
      (SELECT coalesce(-sum(amount_micros),0)::bigint FROM credit_ledger_entries
        WHERE source_id=${saved.revisionId} AND type='document_embedding_debit') AS charged,
      (SELECT count(*)::int FROM credit_ledger_entries
        WHERE source_id=${saved.revisionId} AND type='document_embedding_debit') AS debits
    FROM knowledge_index_jobs j WHERE j.revision_id=${saved.revisionId}`;
  expect(settled?.state).toBe("ready");
  expect(settled?.next_index).toBe(chunks.length);
  expect(Number(settled?.rate)).toBe(1_000_000);
  expect(settled?.debits).toBe(2);
  expect(Number(settled?.charged)).toBe(Number(settled?.bytes));
  expect((await worker.indexKnowledge()).completed).toBe(0);
  expect(calls).toBe(2);
});

test("paid indexing waits for publication without charging a review-first draft", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Review-gated index')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Review workspace')`;
  const settings = {
    billingMode: "stripe",
    usageLimitsMode: "managed",
    staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingCreditsActivatedAt: "2026-01-01T00:00:00Z",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  let calls = 0;
  let onEmbed: (() => Promise<void>) | undefined;
  const embedder: DocumentServices["embedder"] = {
    model: "review-gated-index-test",
    dimensions: 3,
    embedMany: async (inputs) => {
      calls++;
      await onEmbed?.();
      return inputs.map(() => [1, 0, 0]);
    },
    embedQuery: async () => [1, 0, 0],
  };
  const worker = createKnowledgeIndexingActivities(
    async () =>
      ({
        db: client.db,
        settings,
        observability: { warn: () => undefined },
      }) as ControlActivityServices,
    async () => ({ embedder }) as DocumentServices,
  );
  const saved = await saveKnowledgeEntry(
    client.db,
    {
      accountId,
      workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: "user:review-owner",
        writeScopes: ["workspace"],
        settingsScopes: ["workspace"],
        review: true,
      },
    },
    {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      scope: "workspace",
      entry: { kind: "fact", title: "Review-first draft", content: "Pending review" },
    },
  );
  // Model a review-first revision's exact publication pointer without changing
  // its immutable body or bypassing the worker's leased indexing capability.
  await shared.admin`UPDATE knowledge_entries SET published_revision_id=NULL WHERE id=${saved.entryId}`;
  await shared.admin`INSERT INTO credit_ledger_entries(account_id,type,amount_micros,idempotency_key)
    VALUES(${accountId},'grant',1,${`review-index:${saved.revisionId}`})`;
  expect((await worker.indexKnowledge()).deferred).toBe(1);
  expect(calls).toBe(0);
  const [waiting] = await shared.admin`
    SELECT state,last_failure FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(waiting).toMatchObject({ state: "pending", last_failure: "waiting_for_review" });
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(1);
  await shared.admin`UPDATE knowledge_entries SET published_revision_id=${saved.revisionId} WHERE id=${saved.entryId}`;
  await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second'
    WHERE revision_id=${saved.revisionId}`;
  // Simulate a concurrent reviewer withdrawing publication after the provider
  // started but before the batch can append and charge. No paid projection may
  // commit using a stale pre-provider publication check.
  onEmbed = async () => {
    await shared.admin`UPDATE knowledge_entries SET published_revision_id=NULL WHERE id=${saved.entryId}`;
    onEmbed = undefined;
  };
  expect((await worker.indexKnowledge()).deferred).toBe(1);
  expect(calls).toBe(1);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(1);
  const [withdrawn] = await shared.admin`
    SELECT state,next_index,last_failure FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(withdrawn).toMatchObject({
    state: "pending",
    next_index: 0,
    last_failure: "waiting_for_review",
  });
  await shared.admin`UPDATE knowledge_entries SET published_revision_id=${saved.revisionId} WHERE id=${saved.entryId}`;
  await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second'
    WHERE revision_id=${saved.revisionId}`;
  expect((await worker.indexKnowledge()).completed).toBe(1);
  expect(calls).toBe(2);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBeLessThan(1);
});

test("deterministic embeddings still index without funds under the credits-mode switch", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Deterministic index')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Deterministic workspace')`;
  const settings = {
    billingMode: "stripe",
    usageLimitsMode: "managed",
    staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "deterministic",
    documentEmbeddingBillingMode: "credits",
    documentEmbeddingRateMicrosPerMillionBytes: 0,
  } as Settings;
  const embedder: DocumentServices["embedder"] = {
    model: "deterministic-index-test",
    dimensions: 3,
    embedMany: async (inputs) => inputs.map(() => [1, 0, 0]),
    embedQuery: async () => [1, 0, 0],
  };
  const worker = createKnowledgeIndexingActivities(
    async () =>
      ({
        db: client.db,
        settings,
        observability: { warn: () => undefined },
      }) as ControlActivityServices,
    async () => ({ embedder }) as DocumentServices,
  );
  await worker.indexKnowledge();
  const saved = await saveKnowledgeEntry(
    client.db,
    {
      accountId,
      workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: "user:deterministic-owner",
        writeScopes: ["workspace"],
        settingsScopes: ["workspace"],
        review: true,
      },
    },
    {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      scope: "workspace",
      entry: { kind: "fact", title: "No provider charge", content: "Local embeddings" },
    },
  );
  expect((await worker.indexKnowledge()).completed).toBe(1);
  const [job] = await shared.admin`
    SELECT billing_mode, state FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}`;
  expect(job).toMatchObject({ billing_mode: "usage_only", state: "ready" });
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(0);
});

test("shadow indexing records its frozen cost estimate without a credit debit", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Shadow index')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Shadow workspace')`;
  const settings = {
    billingMode: "stripe",
    usageLimitsMode: "managed",
    staticUsageLimitsJson: "{}",
    documentEmbeddingProvider: "openai",
    documentEmbeddingBillingMode: "shadow",
    documentEmbeddingRateMicrosPerMillionBytes: 1_000_000,
  } as Settings;
  const embedder: DocumentServices["embedder"] = {
    model: "shadow-index-test",
    dimensions: 3,
    embedMany: async (inputs) => inputs.map(() => [1, 0, 0]),
    embedQuery: async () => [1, 0, 0],
  };
  const worker = createKnowledgeIndexingActivities(
    async () =>
      ({
        db: client.db,
        settings,
        observability: { warn: () => undefined },
      }) as ControlActivityServices,
    async () => ({ embedder }) as DocumentServices,
  );
  await worker.indexKnowledge();
  const saved = await saveKnowledgeEntry(
    client.db,
    {
      accountId,
      workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: "user:shadow-owner",
        writeScopes: ["workspace"],
        settingsScopes: ["workspace"],
        review: true,
      },
    },
    {
      operationId: crypto.randomUUID(),
      entryId: crypto.randomUUID(),
      expectedVersion: 0,
      scope: "workspace",
      entry: { kind: "fact", title: "Shadow estimate", content: "Count these bytes only" },
    },
  );
  expect((await worker.indexKnowledge()).completed).toBe(1);
  const [meter] = await shared.admin<
    Array<{ mode: string; estimate: number | string; ledger: number }>
  >`
    SELECT (SELECT billing_mode FROM knowledge_index_jobs WHERE revision_id=${saved.revisionId}) AS mode,
      (SELECT sum(quantity)::bigint FROM usage_events WHERE event_type='document.embedding_shadow_estimate'
       AND source_resource_id=${saved.revisionId}) AS estimate,
      (SELECT count(*)::int FROM credit_ledger_entries WHERE account_id=${accountId}) AS ledger`;
  expect(meter?.mode).toBe("shadow");
  expect(Number(meter?.estimate)).toBeGreaterThan(0);
  expect(meter?.ledger).toBe(0);
});

test("a queued Knowledge generation remains unpriced when paid mode starts later", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  fixtureAccounts.push(accountId);
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
