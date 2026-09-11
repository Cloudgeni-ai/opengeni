import { KnowledgeEntryListRequest } from "@opengeni/contracts";
import { listKnowledgeEntries, type Database, type KnowledgeContext } from "@opengeni/db";
import type { DocumentEmbedder } from "@opengeni/documents";
import type { z } from "zod";

/** Shared search path for HTTP and both first-party retrieval servers. */
export async function searchKnowledgeEntries(
  db: Database,
  context: KnowledgeContext,
  input: z.input<typeof KnowledgeEntryListRequest>,
  embedder: () => DocumentEmbedder,
) {
  const request = KnowledgeEntryListRequest.parse(input);
  if (!request.query || request.mode === "keyword") {
    return {
      ...(await listKnowledgeEntries(db, context, request)),
      searchMode: "keyword" as const,
    };
  }
  let embedding: { model: string; values: number[] };
  try {
    const provider = embedder();
    const values = await provider.embedQuery(request.query);
    if (
      values.length !== provider.dimensions ||
      values.some((value) => !Number.isFinite(value)) ||
      !values.some((value) => value !== 0)
    ) {
      throw new Error("Knowledge query embedding is unavailable");
    }
    embedding = { model: provider.model, values };
  } catch (error) {
    // Exact vector requests cannot silently change meaning. Hybrid search can
    // continue using the transactional keyword index while a provider is down.
    if (request.mode === "vector") throw error;
    return {
      ...(await listKnowledgeEntries(db, context, { ...request, mode: "keyword" })),
      searchMode: "keyword" as const,
    };
  }
  return {
    ...(await listKnowledgeEntries(db, context, request, embedding)),
    searchMode: request.mode,
  };
}
