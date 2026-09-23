import type { KnowledgeEntryRecord } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk/browser";

type ReadEntry = (
  id: string,
  options: { revisionId?: string; view?: "needs_review" },
) => Promise<KnowledgeEntryRecord>;

/** Follow exact pending prerequisites, including entries outside the loaded list page. */
export async function firstReviewableEntry(
  entryId: string,
  read: ReadEntry,
): Promise<KnowledgeEntryRecord> {
  const visited = new Set<string>();
  async function pendingLink(id: string, revisionId?: string) {
    try {
      const record = await read(id, revisionId ? { revisionId } : {});
      if (record.revision.outcome !== "pending") return null;
      // Exact historical reads use the published-link projection by default.
      // Request pending context explicitly so unpublished prerequisites remain visible.
      return read(id, { revisionId: record.revision.id, view: "needs_review" });
    } catch (error) {
      if (!(error instanceof OpenGeniApiError) || error.status !== 404) throw error;
      if (revisionId) return null; // Missing evidence must be edited or the finding rejected.
      try {
        return await read(id, { view: "needs_review" });
      } catch (pendingError) {
        if (pendingError instanceof OpenGeniApiError && pendingError.status === 404) return null;
        throw pendingError;
      }
    }
  }
  async function visit(record: KnowledgeEntryRecord): Promise<KnowledgeEntryRecord> {
    if (visited.has(record.id))
      throw new Error(
        "These changes depend on each other. Open a change from the list to edit its links before approving.",
      );
    visited.add(record.id);
    if (record.revision.change === "archive") return record;
    const entry = record.revision.entry;
    for (const evidence of entry.evidence) {
      const dependency = await pendingLink(evidence.entryId, evidence.revisionId);
      if (dependency?.revision.outcome === "pending") return visit(dependency);
    }
    for (const target of [...entry.groupIds, ...entry.relationships.map((link) => link.entryId)]) {
      const dependency = await pendingLink(target);
      if (dependency?.revision.outcome === "pending") return visit(dependency);
    }
    return record;
  }
  return visit(await read(entryId, { view: "needs_review" }));
}
