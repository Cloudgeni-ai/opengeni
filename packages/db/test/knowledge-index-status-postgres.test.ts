import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  saveKnowledgeEntry,
  listKnowledgeEntries,
  getKnowledgeEntry,
  claimKnowledgeIndexJobs,
  readKnowledgeIndexSource,
  waitKnowledgeIndexForFunding,
  appendKnowledgeIndexChunks,
  completeKnowledgeIndexJob,
  deferKnowledgeIndexJob,
  type KnowledgeContext,
} from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("knowledge-index-status");
  if (!acquired) throw new Error("Knowledge index status verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("visible source moves from saved/queued to funding wait and resumes the same index job", async () => {
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const subjectId = `user:${crypto.randomUUID()}`;
  await shared.admin`INSERT INTO managed_accounts(id,name) VALUES(${accountId},'Index status test')`;
  await shared.admin`INSERT INTO workspaces(id,account_id,name) VALUES(${workspaceId},${accountId},'Index status')`;
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
  const receipt = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "personal",
    entry: {
      kind: "source",
      title: "Saved source",
      content: "Retained text",
      source: { kind: "manual" },
      evidence: [],
      groupIds: [],
      relationships: [],
    },
  });
  const listed = () =>
    listKnowledgeEntries(client.db, context, { kind: "source", scope: "personal" });
  expect((await listed()).entries.find((entry) => entry.id === receipt.entryId)?.indexStatus).toBe(
    "queued",
  );
  const other: KnowledgeContext = {
    ...context,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: "user:other",
      writeScopes: ["workspace", "personal"],
      settingsScopes: ["workspace", "personal"],
      review: true,
    },
  };
  expect(
    (await listKnowledgeEntries(client.db, other, { kind: "source" })).entries.some(
      (entry) => entry.id === receipt.entryId,
    ),
  ).toBe(false);
  expect(await getKnowledgeEntry(client.db, other, receipt.entryId)).toBeNull();

  const claim = (
    await claimKnowledgeIndexJobs(client.db, { model: "status-test", dimensions: 3, limit: 20 })
  ).find((entry) => entry.revisionId === receipt.revisionId)!;
  expect(claim).toBeDefined();
  expect((await readKnowledgeIndexSource(client.db, claim))?.entry.content).toBe("Retained text");
  expect((await waitKnowledgeIndexForFunding(client.db, claim)).status).toBe("pending");
  expect((await getKnowledgeEntry(client.db, context, receipt.entryId))?.indexStatus).toBe(
    "awaiting_funding",
  );
  expect((await listed()).entries.find((entry) => entry.id === receipt.entryId)?.indexStatus).toBe(
    "awaiting_funding",
  );
  // A funding change does not create another revision or index job. The due
  // claim resumes the existing lease/checkpoint after the bounded wait.
  await shared.admin`UPDATE knowledge_index_jobs SET next_attempt_at=now()-interval '1 second' WHERE revision_id=${receipt.revisionId}`;
  const resumed = (
    await claimKnowledgeIndexJobs(client.db, { model: "status-test", dimensions: 3, limit: 20 })
  ).find((entry) => entry.revisionId === receipt.revisionId)!;
  expect(resumed.nextIndex).toBe(claim.nextIndex);
  expect((await listed()).entries.find((entry) => entry.id === receipt.entryId)?.indexStatus).toBe(
    "indexing",
  );
  await appendKnowledgeIndexChunks(client.db, resumed, 0, [
    {
      index: 0,
      field: "content",
      start: 0,
      end: 13,
      text: "Retained text",
      embedding: [1, 0, 0],
    },
  ]);
  expect((await completeKnowledgeIndexJob(client.db, resumed, 1)).status).toBe("ready");
  expect((await listed()).entries.find((entry) => entry.id === receipt.entryId)?.indexStatus).toBe(
    "indexed",
  );
  const [count] =
    await shared.admin`SELECT count(*)::int AS jobs FROM knowledge_index_jobs WHERE revision_id=${receipt.revisionId}`;
  expect(count?.jobs).toBe(1);

  const failure = await saveKnowledgeEntry(client.db, context, {
    operationId: crypto.randomUUID(),
    entryId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "personal",
    entry: {
      kind: "source",
      title: "Provider source",
      content: "Retained text",
      source: { kind: "manual" },
      evidence: [],
      groupIds: [],
      relationships: [],
    },
  });
  const providerClaim = (
    await claimKnowledgeIndexJobs(client.db, { model: "status-test", dimensions: 3, limit: 20 })
  ).find((entry) => entry.revisionId === failure.revisionId)!;
  await deferKnowledgeIndexJob(client.db, providerClaim);
  expect((await getKnowledgeEntry(client.db, context, failure.entryId))?.indexStatus).toBe(
    "provider_failed",
  );
}, 180_000);
