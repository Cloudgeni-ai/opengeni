import { configuredStaticUsageLimits } from "@opengeni/config";
import { documentEmbeddingCostMicros, paidDocumentEmbedding } from "@opengeni/core";
import {
  applyCreditDebitAfterUse,
  appendKnowledgeIndexChunks,
  claimKnowledgeIndexJobs,
  completeKnowledgeIndexJob,
  continueKnowledgeIndexJob,
  deferKnowledgeIndexJob,
  freezeKnowledgeIndexBillingMode,
  getBillingBalance,
  guardPaidKnowledgeIndexPublication,
  knowledgeIndexBillingActivationTime,
  readKnowledgeIndexSource,
  recordUsageEvent,
  sumUsageQuantity,
  withWorkspaceUsageLock,
  waitKnowledgeIndexForFunding,
} from "@opengeni/db";
import type { DocumentServices } from "@opengeni/documents";
import type { ControlActivityServices } from "./types";

export function createKnowledgeIndexingActivities(
  services: () => Promise<ControlActivityServices>,
  resolveDocumentServices?: () => Promise<DocumentServices>,
) {
  // Unpaid modes retain a conservative first-poll cutoff; paid mode uses the
  // operator's explicit timestamp so process restarts cannot change eligibility.
  let activationTime: Promise<Date> | undefined;
  return {
    indexKnowledge: async () => {
      const result = { completed: 0, advanced: 0, deferred: 0, unavailable: 0 };
      if (!resolveDocumentServices) return result;
      const { db, settings, observability } = await services();
      let policyActivatedAt: Date;
      if (paidDocumentEmbedding(settings)) {
        if (!settings.documentEmbeddingCreditsActivatedAt)
          throw new Error("paid Knowledge embedding requires an activation cutoff");
        policyActivatedAt = new Date(settings.documentEmbeddingCreditsActivatedAt);
      } else {
        activationTime ??= knowledgeIndexBillingActivationTime(db).catch((error) => {
          activationTime = undefined;
          throw error;
        });
        policyActivatedAt = await activationTime;
      }
      const { embedder } = await resolveDocumentServices();
      const { knowledgeIndexChunks } = await import("@opengeni/documents");
      const claims = await claimKnowledgeIndexJobs(db, {
        model: embedder.model,
        dimensions: embedder.dimensions,
        limit: 2,
      });
      for (const claim of claims) {
        try {
          const source = await readKnowledgeIndexSource(db, claim);
          if (!source) {
            result.unavailable++;
            continue;
          }
          // The checkpoint, usage and post-use debit commit together. A new
          // generation requires funding once; committed batches may finish even
          // if their accumulated cost takes the balance below zero.
          await withWorkspaceUsageLock(db, source.billingWorkspaceId, async (lockedDb) => {
            const current = await readKnowledgeIndexSource(lockedDb, claim);
            if (!current) {
              result.unavailable++;
              return;
            }
            const chunks = [];
            let more = false;
            for (const chunk of knowledgeIndexChunks(current.entry)) {
              if (chunk.index < current.nextIndex) continue;
              if (chunks.length === 32) {
                more = true;
                break;
              }
              chunks.push(chunk);
            }
            if (chunks.length) {
              const frozenPolicy = await freezeKnowledgeIndexBillingMode(
                lockedDb,
                claim,
                // Deterministic embeddings incur no provider charge; a valid
                // credits-mode config with zero tariff must still index them.
                // OpenAI shadow keeps its price snapshot for internal estimates.
                settings.documentEmbeddingProvider === "openai"
                  ? (settings.documentEmbeddingBillingMode ?? "usage_only")
                  : "usage_only",
                policyActivatedAt,
                settings.documentEmbeddingRateMicrosPerMillionBytes ?? 0,
              );
              if (frozenPolicy.mode === "awaiting_review") {
                result.deferred++;
                return;
              }
              if (frozenPolicy.mode === "obsolete") {
                result.unavailable++;
                return;
              }
              const paid = frozenPolicy.mode === "credits" && paidDocumentEmbedding(settings);
              if (paid && current.nextIndex === 0) {
                const balance = await getBillingBalance(lockedDb, claim.accountId);
                if (balance.balanceMicros <= 0) {
                  await waitKnowledgeIndexForFunding(lockedDb, claim);
                  result.deferred++;
                  return;
                }
              }
              if (settings.usageLimitsMode === "static" || settings.usageLimitsMode === "managed") {
                const limit =
                  configuredStaticUsageLimits(settings).maxDocumentIndexedChunksPerWorkspace;
                if (limit) {
                  const now = new Date();
                  const used = await sumUsageQuantity(lockedDb, {
                    workspaceId: current.billingWorkspaceId,
                    eventType: "document.indexed",
                    since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
                  });
                  if (used + chunks.length > limit)
                    throw new Error("monthly document indexing limit reached");
                }
              }
              const inputs = chunks.map((chunk) => chunk.embeddingInput);
              const bytes = inputs.reduce(
                (sum, input) => sum + Buffer.byteLength(input, "utf8"),
                0,
              );
              const vectors = await embedder.embedMany(inputs);
              if (vectors.length !== chunks.length)
                throw new Error("Incomplete Knowledge embeddings");
              // A reviewer may have rejected this revision during the provider
              // call. The DB guard holds its publication row through settlement.
              if (paid) {
                const publication = await guardPaidKnowledgeIndexPublication(lockedDb, claim);
                if (publication !== "published") {
                  if (publication === "obsolete") result.unavailable++;
                  else result.deferred++;
                  return;
                }
              }
              const appended = await appendKnowledgeIndexChunks(
                lockedDb,
                claim,
                current.nextIndex,
                chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index]! })),
              );
              if (appended.status !== "running") {
                result.unavailable++;
                return;
              }
              await recordUsageEvent(lockedDb, {
                accountId: claim.accountId,
                workspaceId: current.billingWorkspaceId,
                eventType: "document.indexed",
                quantity: chunks.length,
                unit: "chunk",
                sourceResourceType: "knowledge_revision",
                sourceResourceId: claim.revisionId,
                idempotencyKey: `knowledge.indexed:${claim.revisionId}:${claim.generation}:${current.nextIndex}`,
              });
              await recordUsageEvent(lockedDb, {
                accountId: claim.accountId,
                workspaceId: current.billingWorkspaceId,
                eventType: "document.embedding_bytes",
                quantity: bytes,
                unit: "byte",
                sourceResourceType: "knowledge_revision",
                sourceResourceId: claim.revisionId,
                idempotencyKey: `knowledge.embedding_bytes:${claim.revisionId}:${claim.generation}:${current.nextIndex}`,
              });
              if (frozenPolicy.mode === "shadow" && frozenPolicy.rateMicrosPerMillionBytes > 0) {
                const estimate = documentEmbeddingCostMicros(
                  {
                    ...settings,
                    documentEmbeddingRateMicrosPerMillionBytes:
                      frozenPolicy.rateMicrosPerMillionBytes,
                  },
                  bytes,
                );
                if (estimate > 0)
                  await recordUsageEvent(lockedDb, {
                    accountId: claim.accountId,
                    workspaceId: current.billingWorkspaceId,
                    eventType: "document.embedding_shadow_estimate",
                    quantity: estimate,
                    unit: "micro_usd",
                    sourceResourceType: "knowledge_revision",
                    sourceResourceId: claim.revisionId,
                    idempotencyKey: `knowledge.embedding_shadow:${claim.revisionId}:${claim.generation}:${current.nextIndex}`,
                  });
              }
              if (paid) {
                const cost = documentEmbeddingCostMicros(
                  {
                    ...settings,
                    documentEmbeddingRateMicrosPerMillionBytes:
                      frozenPolicy.rateMicrosPerMillionBytes,
                  },
                  bytes,
                );
                if (cost > 0)
                  await applyCreditDebitAfterUse(lockedDb, {
                    accountId: claim.accountId,
                    workspaceId: current.billingWorkspaceId,
                    type: "document_embedding_debit",
                    amountMicros: cost,
                    sourceType: "knowledge_revision",
                    sourceId: claim.revisionId,
                    idempotencyKey: `knowledge.embedding:${claim.revisionId}:${claim.generation}:${current.nextIndex}`,
                    metadata: {
                      model: claim.model,
                      bytes,
                      chunks: chunks.length,
                      rateMicrosPerMillionBytes: frozenPolicy.rateMicrosPerMillionBytes,
                    },
                  });
              }
            }
            if (more) {
              await continueKnowledgeIndexJob(lockedDb, claim);
              result.advanced++;
            } else {
              const completed = await completeKnowledgeIndexJob(
                lockedDb,
                claim,
                current.nextIndex + chunks.length,
              );
              if (completed.status === "ready") result.completed++;
              else result.unavailable++;
            }
          });
        } catch {
          // Provider failures retain the last completed projection. The durable
          // queue owns retry/backoff; do not retry an entire activity implicitly.
          await deferKnowledgeIndexJob(db, claim).catch(() => undefined);
          result.deferred++;
          observability.warn("Knowledge indexing batch deferred", {
            accountId: claim.accountId,
            entryId: claim.entryId,
            revisionId: claim.revisionId,
          });
        }
      }
      return result;
    },
  };
}
