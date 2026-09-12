import { configuredStaticUsageLimits } from "@opengeni/config";
import {
  appendKnowledgeIndexChunks,
  claimKnowledgeIndexJobs,
  completeKnowledgeIndexJob,
  continueKnowledgeIndexJob,
  deferKnowledgeIndexJob,
  getBillingBalance,
  readKnowledgeIndexSource,
  recordUsageEvent,
  sumUsageQuantity,
  withWorkspaceUsageLock,
} from "@opengeni/db";
import type { DocumentServices } from "@opengeni/documents";
import type { ControlActivityServices } from "./types";

export function createKnowledgeIndexingActivities(
  services: () => Promise<ControlActivityServices>,
  resolveDocumentServices?: () => Promise<DocumentServices>,
) {
  return {
    indexKnowledge: async () => {
      const result = { completed: 0, advanced: 0, deferred: 0, unavailable: 0 };
      if (!resolveDocumentServices) return result;
      const { db, settings, observability } = await services();
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
          // Reuse the existing embedding budget and usage ledger. Each batch's
          // checkpoint and charge commit together, so a restart never charges
          // twice for an accepted projection. Canonical text is never changed.
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
              if (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed") {
                const balance = await getBillingBalance(lockedDb, claim.accountId);
                if (balance.balanceMicros <= 0) throw new Error("insufficient OpenGeni credits");
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
              const vectors = await embedder.embedMany(chunks.map((chunk) => chunk.embeddingInput));
              if (vectors.length !== chunks.length)
                throw new Error("Incomplete Knowledge embeddings");
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
