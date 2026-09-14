import {
  KnowledgeSavePreparationRequest,
  type KnowledgeSavePreparationResponse,
} from "@opengeni/contracts";
import {
  getKnowledgeEntry,
  listKnowledgeEntries,
  type Database,
  type KnowledgeContext,
} from "@opengeni/db";
import type { DocumentEmbedder } from "@opengeni/documents";
import { searchKnowledgeEntries } from "./knowledge-search";

const defaults = {
  get: getKnowledgeEntry,
  list: listKnowledgeEntries,
  search: searchKnowledgeEntries,
};
// Normal workspaces return the whole map in one call. Larger maps explicitly
// continue at a complete page boundary, never silently omit collections.
const CATALOG_PAGE_SIZE = 25;
const CATALOG_PAGE_BUDGET = 40;
const DESCRIPTION_CHARS = 2000;
const CATALOG_BYTES = 256 * 1024;

export async function prepareKnowledgeSave(
  db: Database,
  context: KnowledgeContext,
  input: KnowledgeSavePreparationRequest,
  embedder: () => DocumentEmbedder,
  services = defaults,
): Promise<KnowledgeSavePreparationResponse> {
  const request = KnowledgeSavePreparationRequest.parse(input);
  if (context.actor.kind !== "agent" && !(context.actor.kind === "human" && context.actor.review)) {
    throw Object.assign(
      new Error("Preparing Knowledge requires a live agent or human Knowledge reviewer"),
      { code: "42501" },
    );
  }
  let provider: DocumentEmbedder | undefined;
  let queryEmbedding: Promise<number[]> | undefined;
  const sharedEmbedder = (): DocumentEmbedder => {
    provider ??= embedder();
    const current = provider;
    return {
      model: current.model,
      dimensions: current.dimensions,
      embedMany: (texts) => current.embedMany(texts),
      embedQuery: (query) => (queryEmbedding ??= current.embedQuery(query)),
    };
  };
  const collections: KnowledgeSavePreparationResponse["collections"] = {
    entries: [],
    complete: true,
    nextCursors: { published: null, needs_review: null },
  };
  // Search is independent of collection placement and always includes the
  // separate unapproved view. No authoring policy or write is invoked here.
  const matches = {
    published: await services.search(
      db,
      context,
      { query: request.query, limit: request.limit, view: "published" },
      sharedEmbedder,
    ),
    needs_review: await services.search(
      db,
      context,
      { query: request.query, limit: request.limit, view: "needs_review" },
      sharedEmbedder,
    ),
  };
  for (const view of ["published", "needs_review"] as const) {
    if (request.collectionCursors && request.collectionCursors[view] === null) continue;
    let cursor = request.collectionCursors?.[view] ?? undefined;
    let bytes = 0;
    for (let pageNumber = 0; pageNumber < CATALOG_PAGE_BUDGET; pageNumber++) {
      const page = await services.list(db, context, {
        kind: "group",
        view,
        limit: CATALOG_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      const records: Array<Awaited<ReturnType<typeof getKnowledgeEntry>>> = [];
      for (let offset = 0; offset < page.entries.length; offset += 4) {
        records.push(
          ...(await Promise.all(
            page.entries
              .slice(offset, offset + 4)
              .map((summary) => services.get(db, context, summary.id, { view })),
          )),
        );
      }
      for (const record of records) {
        // Re-read the current view: an exact historical revision may remain
        // readable after replacement and must not be called the current map.
        if (
          !record ||
          record.archived ||
          record.revision.entry.kind !== "group" ||
          record.revision.outcome !== (view === "published" ? "published" : "pending")
        )
          continue;
        const entry = record.revision.entry;
        const descriptor = {
          id: record.id,
          revisionId: record.revision.id,
          version: record.version,
          scope: record.scope,
          view,
          title: entry.title,
          description: entry.content.slice(0, DESCRIPTION_CHARS),
          descriptionTruncated: entry.content.length > DESCRIPTION_CHARS,
          parentIds: entry.groupIds,
        };
        collections.entries.push(descriptor);
        bytes += Buffer.byteLength(JSON.stringify(descriptor), "utf8");
      }
      cursor = page.nextCursor ?? undefined;
      if (!cursor || bytes >= CATALOG_BYTES) break;
    }
    collections.nextCursors[view] = cursor ?? null;
    if (cursor) collections.complete = false;
  }
  return { collections, matches };
}
