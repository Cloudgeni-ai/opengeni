import { KnowledgeEntryListRequest, type KnowledgeEntryListResponse } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import {
  applyCreditDebitAfterUse,
  checkWorkspaceAllowance,
  creditDebitAttributionForTurn,
  getBillingBalance,
  listKnowledgeEntries,
  recordUsageEvent,
  sumUsageQuantity,
  withKnowledgeQueryAccountLock,
  type Database,
  type KnowledgeContext,
  type CreditDebitAttribution,
} from "@opengeni/db";
import type { DocumentEmbedder } from "@opengeni/documents";
import type { z } from "zod";
import { documentEmbeddingCostMicros, paidDocumentEmbedding } from "../billing/limits";

// Safety ceilings, not a commercial tariff. Paid queries have no durable
// reusable vector cache, so each bounded request consumes the provider once.
const MAX_PAID_QUERY_BYTES = 4096;
const MAX_PAID_QUERY_MICROS = 1000;
const MAX_PAID_QUERY_BYTES_PER_MINUTE = 64 * 1024;
const MAX_PAID_QUERY_BYTES_PER_MONTH = 8 * 1024 * 1024;
const MAX_PAID_QUERY_MICROS_PER_MINUTE = 10_000;
const MAX_PAID_QUERY_MICROS_PER_MONTH = 1_000_000;

export class KnowledgeVectorFundingError extends Error {
  readonly code = "knowledge_vector_funding_required";
  constructor() {
    super("Knowledge vector search needs OpenGeni credits; keyword search remains available.");
    this.name = "KnowledgeVectorFundingError";
  }
}

export class KnowledgeVectorQueryRejectedError extends Error {
  constructor(
    public readonly code: "pagination_unavailable" | "query_limit" | "quota",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeVectorQueryRejectedError";
  }
}

/** Shared search path for HTTP and both first-party retrieval servers. */
export async function searchKnowledgeEntries(
  db: Database,
  context: KnowledgeContext,
  input: z.input<typeof KnowledgeEntryListRequest>,
  embedder: () => DocumentEmbedder,
  settings?: Settings,
): Promise<KnowledgeEntryListResponse> {
  const request = KnowledgeEntryListRequest.parse(input);
  // Copy trusted actor fields before any provider/lock await. Request lifetime
  // mutation cannot replace the initiating identity between admission/debit.
  const billingActor = { ...context.actor };
  let paidAttribution: CreditDebitAttribution =
    billingActor.kind === "human"
      ? { kind: "human", initiatingHumanSubjectId: billingActor.subjectId }
      : billingActor.kind === "service"
        ? { kind: "service" }
        : { kind: "unknown" };
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
  const keywordFallback = async (
    queryDb: Database,
    error: unknown,
    fallbackReason: "awaiting_funding" | "quota" | "provider_unavailable" | "query_limit",
  ) => {
    if (request.mode === "vector") throw error;
    return {
      ...(await listKnowledgeEntries(queryDb, context, { ...retrievalRequest, mode: "keyword" })),
      searchMode: "keyword" as const,
      fallbackReason,
    };
  };
  const bytes = Buffer.byteLength(request.query, "utf8");
  const paidSettings = settings && paidDocumentEmbedding(settings) ? settings : undefined;
  // Paid cursors would re-embed and re-charge on each page. Until a durable
  // vector cache exists, require explicit keyword mode to paginate instead.
  if (paidSettings && request.cursor)
    throw new KnowledgeVectorQueryRejectedError(
      "pagination_unavailable",
      "Paid semantic Knowledge pagination is unavailable; use keyword mode",
    );
  const cost = paidSettings ? documentEmbeddingCostMicros(paidSettings, bytes) : 0;
  if (paidSettings && (bytes > MAX_PAID_QUERY_BYTES || cost > MAX_PAID_QUERY_MICROS))
    return keywordFallback(
      db,
      new KnowledgeVectorQueryRejectedError(
        "query_limit",
        "Paid Knowledge query exceeds the per-request limit",
      ),
      "query_limit",
    );

  const retrieveThenSettle = async (queryDb: Database) => {
    let embedding: { model: string; values: number[] };
    try {
      const provider = embedder();
      const values = await provider.embedQuery(request.query!);
      if (
        values.length !== provider.dimensions ||
        values.some((value) => !Number.isFinite(value)) ||
        !values.some((value) => value !== 0)
      )
        throw new Error("Knowledge query embedding is unavailable");
      embedding = { model: provider.model, values };
    } catch (error) {
      // Only provider failure may fall back. Retrieval and settlement errors
      // after use surface; they never masquerade as a successful keyword hit.
      return keywordFallback(queryDb, error, "provider_unavailable");
    }
    // Read before billing, in the same transaction for the paid mode. Failure
    // here leaves no customer charge and no vector result to return.
    const found = await listKnowledgeEntries(queryDb, context, retrievalRequest, embedding);
    if (settings) {
      const usageId = crypto.randomUUID();
      await recordUsageEvent(queryDb, {
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        eventType: "document.query_embedding_bytes",
        quantity: bytes,
        unit: "byte",
        sourceResourceType: "knowledge_query",
        sourceResourceId: usageId,
        idempotencyKey: `knowledge.query_bytes:${usageId}`,
      });
      if (paidSettings && cost > 0)
        await recordUsageEvent(queryDb, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          eventType: "document.query_embedding_cost",
          quantity: cost,
          unit: "micro_usd",
          sourceResourceType: "knowledge_query",
          sourceResourceId: usageId,
          idempotencyKey: `knowledge.query_cost:${usageId}`,
          // Durable receipt inserted before the debit in this same transaction.
          // The service is the writer, not an inferred causal human.
          initiator: { kind: "service", subjectId: "worker:knowledge-query" },
          initiatorContext: { creditDebitAttribution: paidAttribution },
        });
      if (paidSettings && cost > 0)
        await applyCreditDebitAfterUse(queryDb, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          type: "document_embedding_debit",
          amountMicros: cost,
          sourceType: "knowledge_query",
          sourceId: usageId,
          idempotencyKey: `knowledge.query_embedding:${usageId}`,
          metadata: {
            model: embedding.model,
            bytes,
            // This context is constructed by the trusted HTTP/MCP host, never
            // from request input. The ledger resolves the immutable exact turn;
            // an API key's subject (or a session creator) is not a human.
            ...(billingActor.kind === "agent"
              ? { turnId: billingActor.turnId }
              : billingActor.kind === "human"
                ? { initiatingHumanSubjectId: billingActor.subjectId }
                : {}),
          },
        });
    }
    return { ...found, searchMode: request.mode };
  };
  if (!paidSettings) return retrieveThenSettle(db);
  // Serialize paid queries across all workspaces of the account before
  // checking balance. This is an execution fence, not a credit reservation.
  return withKnowledgeQueryAccountLock(
    db,
    context.accountId,
    context.workspaceId,
    async (lockedDb) => {
      const balance = await getBillingBalance(lockedDb, context.accountId);
      if (balance.balanceMicros <= 0)
        return keywordFallback(lockedDb, new KnowledgeVectorFundingError(), "awaiting_funding");
      const attribution =
        billingActor.kind === "agent"
          ? await creditDebitAttributionForTurn(lockedDb, {
              accountId: context.accountId,
              workspaceId: context.workspaceId,
              turnId: billingActor.turnId,
            })
          : null;
      if (attribution) paidAttribution = attribution;
      const refusal = await checkWorkspaceAllowance(lockedDb, {
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        subjectId:
          billingActor.kind === "human"
            ? billingActor.subjectId
            : attribution?.kind === "turn"
              ? attribution.initiatingHumanSubjectId
              : null,
      });
      if (refusal)
        return keywordFallback(
          lockedDb,
          Object.assign(new Error(refusal.message), refusal),
          "quota",
        );
      const now = new Date();
      const minuteBytes = await sumUsageQuantity(lockedDb, {
        accountId: context.accountId,
        eventType: "document.query_embedding_bytes",
        since: new Date(now.getTime() - 60_000),
      });
      const monthBytes = await sumUsageQuantity(lockedDb, {
        accountId: context.accountId,
        eventType: "document.query_embedding_bytes",
        since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      });
      const minuteMicros = await sumUsageQuantity(lockedDb, {
        accountId: context.accountId,
        eventType: "document.query_embedding_cost",
        since: new Date(now.getTime() - 60_000),
      });
      const monthMicros = await sumUsageQuantity(lockedDb, {
        accountId: context.accountId,
        eventType: "document.query_embedding_cost",
        since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      });
      if (
        minuteBytes + bytes > MAX_PAID_QUERY_BYTES_PER_MINUTE ||
        monthBytes + bytes > MAX_PAID_QUERY_BYTES_PER_MONTH ||
        minuteMicros + cost > MAX_PAID_QUERY_MICROS_PER_MINUTE ||
        monthMicros + cost > MAX_PAID_QUERY_MICROS_PER_MONTH
      )
        return keywordFallback(
          lockedDb,
          new KnowledgeVectorQueryRejectedError("quota", "Paid Knowledge query rate limit reached"),
          "quota",
        );
      return retrieveThenSettle(lockedDb);
    },
  );
}
