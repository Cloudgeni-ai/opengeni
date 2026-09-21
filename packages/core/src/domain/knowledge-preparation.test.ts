import { expect, test } from "bun:test";
import type { KnowledgeEntryRecord, KnowledgeEntrySummary } from "@opengeni/contracts";
import { prepareKnowledgeSave } from "./knowledge-preparation";

const context = {
  accountId: "account",
  workspaceId: "workspace",
  actor: { kind: "human", review: true },
} as never;
const db = {} as never;
const embedder = () => {
  throw new Error("not used by fake search");
};
function group(title: string, parentIds: string[] = []): KnowledgeEntryRecord {
  const id = crypto.randomUUID();
  return {
    id,
    scope: "workspace",
    version: 1,
    publishedRevisionId: id,
    latestRevisionId: id,
    archived: false,
    createdAt: "2026-09-14T00:00:00Z",
    updatedAt: "2026-09-14T00:00:00Z",
    revision: {
      id,
      entryId: id,
      number: 1,
      change: "upsert",
      previousRevisionId: null,
      restoredFromRevisionId: null,
      createdAt: "2026-09-14T00:00:00Z",
      createdBySessionId: null,
      reviewBatchId: null,
      outcome: "published",
      entry: {
        title,
        kind: "group",
        content: `Description of ${title}`,
        groupIds: parentIds,
        evidence: [],
        relationships: [],
      },
    },
  };
}
const summary = (record: KnowledgeEntryRecord) =>
  ({
    ...record,
    revision: {
      ...record.revision,
      title: record.revision.entry.title,
      kind: "group",
      preview: "preview",
      groupIds: record.revision.entry.groupIds,
      sourceKind: null,
    },
    excerpts: [],
  }) as KnowledgeEntrySummary;

test("one read returns the complete paginated hierarchy and separately labeled duplicate candidates", async () => {
  const parent = group("Engineering");
  const child = group("Product UI", [parent.id]);
  const pending = group("Proposed collection");
  pending.revision.outcome = "pending";
  const revoked = group("Revoked");
  const calls: unknown[] = [];
  const result = await prepareKnowledgeSave(
    db,
    context,
    { query: "plugin setup consistency" },
    embedder,
    {
      list: async (actualDb, actualContext, request) => {
        expect(actualDb).toBe(db);
        expect(actualContext).toBe(context);
        calls.push(request);
        if (request?.view === "needs_review")
          return { entries: [summary(pending)], nextCursor: null };
        return request?.cursor
          ? { entries: [summary(child), summary(revoked)], nextCursor: null }
          : { entries: [summary(parent)], nextCursor: "page2" };
      },
      get: async (_db, _context, id, options) => {
        expect(options?.revisionId).toBeUndefined();
        return [parent, child, pending].find((record) => record.id === id) ?? null;
      },
      search: async (_db, actualContext, request) => {
        expect(actualContext).toBe(context);
        expect(request.query).toBe("plugin setup consistency");
        expect(request.groupId).toBeUndefined();
        expect(request.scope).toBeUndefined();
        return {
          entries: [summary(request.view === "needs_review" ? pending : child)],
          nextCursor: null,
          searchMode: "hybrid",
        };
      },
    },
  );
  expect(calls).toHaveLength(3);
  expect(result.collections.complete).toBe(true);
  expect(result.collections.entries.map((entry) => entry.title)).toEqual([
    "Engineering",
    "Product UI",
    "Proposed collection",
  ]);
  expect(result.collections.entries[1]?.parentIds).toEqual([parent.id]);
  expect(result.collections.entries[0]?.description).toBe("Description of Engineering");
  expect(result.collections.entries[2]?.view).toBe("needs_review");
  expect(result.matches.published.entries[0]?.id).toBe(child.id);
  expect(result.matches.needs_review.entries[0]?.id).toBe(pending.id);
});

test("large collection maps explicitly continue and long descriptions report loss", async () => {
  const record = group("Large collection");
  record.revision.entry.content = "x".repeat(3000);
  let count = 0;
  const services: NonNullable<Parameters<typeof prepareKnowledgeSave>[4]> = {
    list: async (_db, _context, request) => {
      if (request?.view === "needs_review") return { entries: [], nextCursor: null };
      return { entries: [summary(record)], nextCursor: `page${++count}` };
    },
    get: async () => record,
    search: async () => ({ entries: [], nextCursor: null, searchMode: "keyword" }),
  };
  const result = await prepareKnowledgeSave(db, context, { query: "subject" }, embedder, services);
  expect(result.collections.complete).toBe(false);
  expect(result.collections.nextCursors.published).toBeTruthy();
  expect(result.collections.nextCursors.needs_review).toBeNull();
  expect(result.collections.entries[0]?.descriptionTruncated).toBe(true);
  expect(result.collections.entries[0]?.description).toHaveLength(2000);
  let requestedCursor: string | undefined;
  await prepareKnowledgeSave(
    db,
    context,
    { query: "subject", collectionCursors: result.collections.nextCursors },
    embedder,
    {
      ...services,
      list: async (_db, _context, request) => {
        expect(request?.view).toBe("published");
        requestedCursor = request?.cursor;
        return { entries: [], nextCursor: null };
      },
    },
  );
  expect(requestedCursor).toBe(result.collections.nextCursors.published!);
});

test("a catalog authorization failure is not disguised as an empty complete map", async () => {
  await expect(
    prepareKnowledgeSave(db, context, { query: "subject" }, embedder, {
      list: async () => {
        throw new Error("access revoked");
      },
      get: async () => null,
      search: async () => ({ entries: [], nextCursor: null, searchMode: "keyword" }),
    }),
  ).rejects.toThrow("access revoked");
});

test("read-only principals without proposal access fail before searching or embedding", async () => {
  let touched = false;
  await expect(
    prepareKnowledgeSave(
      db,
      {
        accountId: "account",
        workspaceId: "workspace",
        actor: { kind: "service", review: false },
      } as never,
      { query: "subject" },
      () => {
        touched = true;
        throw new Error("must not embed");
      },
      {
        list: async () => {
          touched = true;
          return { entries: [], nextCursor: null };
        },
        get: async () => {
          touched = true;
          return null;
        },
        search: async () => {
          touched = true;
          return { entries: [], nextCursor: null, searchMode: "keyword" };
        },
      },
    ),
  ).rejects.toMatchObject({ code: "42501" });
  expect(touched).toBe(false);
});

test("published and pending searches reuse one query embedding", async () => {
  let calls = 0;
  await prepareKnowledgeSave(
    db,
    context,
    { query: "plugin dialog" },
    () => ({
      model: "test",
      dimensions: 2,
      embedMany: async () => [],
      embedQuery: async () => {
        calls++;
        return [1, 0];
      },
    }),
    {
      list: async () => ({ entries: [], nextCursor: null }),
      get: async () => null,
      search: async (_db, _context, request, queryEmbedder) => {
        expect(await queryEmbedder().embedQuery(request.query!)).toEqual([1, 0]);
        return { entries: [], nextCursor: null, searchMode: "hybrid" };
      },
    },
  );
  expect(calls).toBe(1);
});

test("catalog rechecks current metadata after a collection changes", async () => {
  const old = group("Old name");
  const current = {
    ...old,
    version: 2,
    revision: {
      ...old.revision,
      id: crypto.randomUUID(),
      entry: { ...old.revision.entry, title: "New name" },
    },
  };
  const result = await prepareKnowledgeSave(db, context, { query: "subject" }, embedder, {
    list: async (_db, _context, request) => ({
      entries: request?.view === "published" ? [summary(old)] : [],
      nextCursor: null,
    }),
    get: async (_db, _context, _id, options) => {
      expect(options?.revisionId).toBeUndefined();
      return current;
    },
    search: async () => ({ entries: [], nextCursor: null, searchMode: "keyword" }),
  });
  expect(result.collections.entries[0]).toMatchObject({
    title: "New name",
    version: 2,
    revisionId: current.revision.id,
  });
});
