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
  // Hybrid queries are natural language, not a conjunction of every synonym.
  // Keep lexical recall useful when embeddings or vector indexing are unavailable.
  // Explicit keyword syntax and keyword-mode queries retain their exact semantics.
  const lexicalQuery =
    /^[\p{L}\p{N}\s]+$/u.test(request.query) && !/\bOR\b/i.test(request.query)
      ? [...new Set(request.query.trim().split(/\s+/u))].map((term) => `"${term}"`).join(" OR ")
      : request.query;
  const lexicalRequest = KnowledgeEntryListRequest.safeParse({ ...request, query: lexicalQuery });
  const retrievalRequest =
    request.mode === "hybrid" && lexicalRequest.success ? lexicalRequest.data : request;
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
      ...(await listKnowledgeEntries(db, context, { ...retrievalRequest, mode: "keyword" })),
      searchMode: "keyword" as const,
    };
  }
  return {
    ...(await listKnowledgeEntries(db, context, retrievalRequest, embedding)),
    searchMode: request.mode,
  };
}
