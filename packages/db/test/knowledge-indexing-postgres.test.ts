import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  claimKnowledgeIndexJobs,
  readKnowledgeIndexSource,
  appendKnowledgeIndexChunks,
  completeKnowledgeIndexJob,
  deferKnowledgeIndexJob,
  saveKnowledgeEntry,
  getKnowledgeEntry,
  listKnowledgeEntries,
  archiveKnowledgeEntry,
  type KnowledgeContext,
} from "../src";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-indexing");
  if (!acquired) throw new Error("Knowledge indexing verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 6 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);
async function fixture() {
  const accountId = crypto.randomUUID(),
    workspaceId = crypto.randomUUID(),
    subjectId = `user:${crypto.randomUUID()}`;
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Knowledge indexing')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Index workspace')`;
  const context: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId,
      writeScopes: ["workspace", "personal"],
      settingsScopes: ["workspace", "personal"],
      review: true,
    },
  };
  const exact = "Private Acme contract 🚀\u0000 retains all wording.  ";
  const receipt = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "personal",
    entry: {
      kind: "fact",
      title: "Acme",
      content: exact,
      groupIds: [],
      evidence: [],
      relationships: [],
    },
  });
  return { accountId, workspaceId, subjectId, context, exact, receipt };
}
test("projection jobs preserve private content and enforce leases across restart and provider changes", async () => {
  const f = await fixture();
  const claims = await claimKnowledgeIndexJobs(client.db, {
    model: "test-embedding",
    dimensions: 3,
    limit: 20,
  });
  const claim = claims.find((item) => item.revisionId === f.receipt.revisionId)!;
  expect(claim).toBeDefined();
  expect("body" in claim).toBe(false);
  const source = await readKnowledgeIndexSource(client.db, claim);
  expect(source?.entry.content).toBe(f.exact);
  expect(source?.scope).toBe("personal");
  await expect(
    readKnowledgeIndexSource(client.db, { ...claim, leaseId: crypto.randomUUID() }),
  ).rejects.toBeDefined();
  await appendKnowledgeIndexChunks(client.db, claim, 0, [
    {
      index: 0,
      field: "content",
      start: 0,
      end: f.exact.length,
      text: f.exact,
      embedding: [1, 0, 0],
    },
  ]);
  await deferKnowledgeIndexJob(client.db, claim);
  await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second' WHERE revision_id=${claim.revisionId}`;
  const resumed = (
    await claimKnowledgeIndexJobs(client.db, { model: "test-embedding", dimensions: 3, limit: 20 })
  ).find((item) => item.revisionId === claim.revisionId)!;
  expect(resumed.nextIndex).toBe(1);
  expect(resumed.generation).toBe(claim.generation);
  expect(resumed.leaseId).not.toBe(claim.leaseId);
  await expect(completeKnowledgeIndexJob(client.db, claim, 1)).rejects.toBeDefined();
  expect((await completeKnowledgeIndexJob(client.db, resumed, 1)).status).toBe("ready");
  const nextModel = (
    await claimKnowledgeIndexJobs(client.db, { model: "new-embedding", dimensions: 3, limit: 20 })
  ).find((item) => item.revisionId === claim.revisionId)!;
  expect(nextModel.nextIndex).toBe(0);
  expect(nextModel.generation).toBe(claim.generation + 1);
  const [before] =
    await shared.admin`SELECT completed_generation FROM knowledge_index_jobs WHERE revision_id=${claim.revisionId}`;
  expect(before?.completed_generation).toBe(claim.generation);
  await appendKnowledgeIndexChunks(client.db, nextModel, 0, [
    {
      index: 0,
      field: "content",
      start: 0,
      end: f.exact.length,
      text: f.exact,
      embedding: [0, 1, 0],
    },
  ]);
  await completeKnowledgeIndexJob(client.db, nextModel, 1);
  const [after] =
    await shared.admin`SELECT count(*)::int AS n FROM knowledge_entry_vectors WHERE revision_id=${claim.revisionId}`;
  expect(after?.n).toBe(1);
  expect(
    (await getKnowledgeEntry(client.db, f.context, f.receipt.entryId))?.revision.entry.content,
  ).toBe(f.exact);
  const other: KnowledgeContext = {
    ...f.context,
    actor: { ...f.context.actor, subjectId: "user:other" } as KnowledgeContext["actor"],
  };
  expect(await getKnowledgeEntry(client.db, other, f.receipt.entryId)).toBeNull();
});
test("a forged dispatcher flag gives application SQL no access to jobs or vectors", async () => {
  const failure = await client.db
    .transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('opengeni.knowledge_index_dispatcher','1',true)`);
      await tx.execute(sql`SELECT * FROM knowledge_index_jobs`);
    })
    .then(
      () => null,
      (error) => error,
    );
  expect(failure).not.toBeNull();
});
test("a superseded source revision cannot publish a completed cache", async () => {
  const f = await fixture();
  const claim = (
    await claimKnowledgeIndexJobs(client.db, { model: "test-embedding", dimensions: 3, limit: 20 })
  ).find((item) => item.revisionId === f.receipt.revisionId)!;
  const current = await getKnowledgeEntry(client.db, f.context, f.receipt.entryId);
  const replacement = await saveKnowledgeEntry(client.db, f.context, {
    operationId: crypto.randomUUID(),
    entryId: f.receipt.entryId,
    expectedVersion: f.receipt.version,
    entry: { ...current!.revision.entry, content: "Corrected renewal date" },
  });
  expect(await readKnowledgeIndexSource(client.db, claim)).toBeNull();
  expect((await getKnowledgeEntry(client.db, f.context, f.receipt.entryId))?.revision.id).toBe(
    replacement.revisionId,
  );
});

test("semantic ranking uses the best chunk and paginates after permission filtering", async () => {
  const f = await fixture();
  const content = "renewal terms. vendor contracts.";
  const a = await saveKnowledgeEntry(client.db, f.context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "personal",
    entry: { kind: "fact", title: "Terms", content },
  });
  const b = await saveKnowledgeEntry(client.db, f.context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "personal",
    entry: { kind: "fact", title: "Agreement", content: "other purchasing details" },
  });
  const claims = await claimKnowledgeIndexJobs(client.db, {
    model: "ranking",
    dimensions: 3,
    limit: 20,
  });
  const first = claims.find((claim) => claim.revisionId === a.revisionId)!;
  await appendKnowledgeIndexChunks(client.db, first, 0, [
    {
      index: 0,
      field: "content",
      start: 0,
      end: 14,
      text: content.slice(0, 14),
      embedding: [0, 1, 0],
    },
    {
      index: 1,
      field: "content",
      start: 14,
      end: content.length,
      text: content.slice(14),
      embedding: [1, 0, 0],
    },
  ]);
  await completeKnowledgeIndexJob(client.db, first, 2);
  const second = claims.find((claim) => claim.revisionId === b.revisionId)!;
  await appendKnowledgeIndexChunks(client.db, second, 0, [
    {
      index: 0,
      field: "content",
      start: 0,
      end: 24,
      text: "other purchasing details",
      embedding: [0.8, 0.6, 0],
    },
  ]);
  await completeKnowledgeIndexJob(client.db, second, 1);
  const embedding = { model: "ranking", values: [1, 0, 0] };
  const request = { query: "renewal", mode: "vector" as const, limit: 1 };
  const page = await listKnowledgeEntries(client.db, f.context, request, embedding);
  expect(page.entries.map((entry) => entry.id)).toEqual([a.entryId]);
  expect(page.entries[0]!.excerpts[0]!.text).toBe(content.slice(14));
  expect(page.nextCursor).not.toBeNull();
  const next = await listKnowledgeEntries(
    client.db,
    f.context,
    { ...request, cursor: page.nextCursor! },
    embedding,
  );
  expect(next.entries.map((entry) => entry.id)).toEqual([b.entryId]);
  expect(next.nextCursor).toBeNull();
  const other: KnowledgeContext = {
    ...f.context,
    actor: { ...f.context.actor, subjectId: "user:unrelated" } as KnowledgeContext["actor"],
  };
  expect((await listKnowledgeEntries(client.db, other, request, embedding)).entries).toEqual([]);
  await expect(
    listKnowledgeEntries(
      client.db,
      f.context,
      { ...request, cursor: page.nextCursor! },
      { ...embedding, model: "different" },
    ),
  ).rejects.toThrow("Refresh");
});

test("withdrawing pinned evidence prevents a leased finding from committing embeddings", async () => {
  const f = await fixture();
  const finding = await saveKnowledgeEntry(client.db, f.context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "personal",
    entry: {
      kind: "fact",
      title: "Renewal",
      content: "December renewal",
      evidence: [{ entryId: f.receipt.entryId, revisionId: f.receipt.revisionId }],
    },
  });
  const claim = (
    await claimKnowledgeIndexJobs(client.db, { model: "withdrawal", dimensions: 3, limit: 20 })
  ).find((item) => item.revisionId === finding.revisionId)!;
  expect(await readKnowledgeIndexSource(client.db, claim)).not.toBeNull();
  await archiveKnowledgeEntry(client.db, f.context, {
    operationId: crypto.randomUUID(),
    entryId: f.receipt.entryId,
    expectedVersion: f.receipt.version,
  });
  expect(
    (
      await appendKnowledgeIndexChunks(client.db, claim, 0, [
        {
          index: 0,
          field: "content",
          start: 0,
          end: 16,
          text: "December renewal",
          embedding: [1, 0, 0],
        },
      ])
    ).status,
  ).toBe("pending");
  const [stored] =
    await shared.admin`SELECT count(*)::int AS n FROM knowledge_entry_vectors WHERE revision_id=${finding.revisionId}`;
  expect(stored?.n).toBe(0);
  expect(
    (
      await listKnowledgeEntries(
        client.db,
        f.context,
        { query: "December", mode: "vector" },
        { model: "withdrawal", values: [1, 0, 0] },
      )
    ).entries,
  ).toEqual([]);
});
