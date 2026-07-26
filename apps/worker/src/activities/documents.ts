import { indexDocumentNow } from "@opengeni/documents";
import { configuredStaticUsageLimits } from "@opengeni/config";
import {
  getBillingBalance,
  recordUsageEvent,
  sumUsageQuantity,
  withWorkspaceUsageLock,
} from "@opengeni/db";
import type { ActivityServices, IndexDocumentInput } from "./types";

export function createDocumentActivities(services: () => Promise<ActivityServices>) {
  return {
    indexDocument: async (input: IndexDocumentInput) => {
      const { settings, db, objectStorage, documentServices } = await services();
      if (!objectStorage) {
        throw new Error("object storage is not configured");
      }
      return await withWorkspaceUsageLock(db, input.workspaceId, async (lockedDb) => {
        const document = await indexDocumentNow(
          lockedDb,
          objectStorage,
          input.workspaceId,
          input.documentId,
          documentServices,
          {
            beforeEmbed: async ({ chunkCount }) => {
              if (settings.billingMode === "stripe" || settings.usageLimitsMode === "managed") {
                const balance = await getBillingBalance(lockedDb, input.accountId);
                if (balance.balanceMicros <= 0) {
                  throw new Error("insufficient OpenGeni credits");
                }
              }
              if (settings.usageLimitsMode !== "static" && settings.usageLimitsMode !== "managed") {
                return;
              }
              const limit =
                configuredStaticUsageLimits(settings).maxDocumentIndexedChunksPerWorkspace;
              if (!limit) {
                return;
              }
              const used = await sumUsageQuantity(lockedDb, {
                workspaceId: input.workspaceId,
                eventType: "document.indexed",
                since: startOfUtcMonth(),
              });
              if (used + chunkCount > limit) {
                throw new Error(`monthly document indexing limit reached (${limit} chunks)`);
              }
            },
          },
        );
        if (document.status === "ready") {
          await recordUsageEvent(lockedDb, {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            eventType: "document.indexed",
            quantity: document.chunkCount,
            unit: "chunk",
            sourceResourceType: "document",
            sourceResourceId: document.id,
            idempotencyKey: `document.indexed:${input.workspaceId}:${document.id}:${document.updatedAt}`,
          });
        }
        return document;
      });
    },
  };
}

function startOfUtcMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}
