import type { DocumentServices } from "@opengeni/documents";
import { configuredStaticUsageLimits } from "@opengeni/config";
import {
  getBillingBalance,
  recordUsageEvent,
  resolveDocumentIndexAuthority,
  rlsContextForWorkspace,
  sumUsageQuantity,
  withWorkspaceUsageLock,
} from "@opengeni/db";
import type { ControlActivityServices, IndexDocumentInput } from "./types";

export function createDocumentActivities(
  services: () => Promise<ControlActivityServices>,
  resolveDocumentServices?: () => Promise<DocumentServices>,
) {
  return {
    indexDocument: async (input: IndexDocumentInput) => {
      const { settings, db, objectStorage } = await services();
      if (!objectStorage) {
        throw new Error("object storage is not configured");
      }
      if (!resolveDocumentServices) {
        throw new Error("document services are not configured");
      }
      const [{ getDocument, indexDocumentNow }, documentServices] = await Promise.all([
        import("@opengeni/documents"),
        resolveDocumentServices(),
      ]);
      const context = await rlsContextForWorkspace(db, input.workspaceId);
      if (context.accountId !== input.accountId) {
        throw new Error("document account/workspace authority mismatch");
      }
      return await withWorkspaceUsageLock(db, input.workspaceId, async (lockedDb) => {
        const storedAuthority = await resolveDocumentIndexAuthority(lockedDb, input);
        if (!storedAuthority) {
          throw new Error("document authority was not found before indexing");
        }
        const suppliedAuthorityFields = [
          "authorityKind",
          "authorityWorkspaceId",
          "authoritySubjectId",
        ] as const;
        const suppliedCount = suppliedAuthorityFields.filter((field) =>
          Object.prototype.hasOwnProperty.call(input, field),
        ).length;
        const suppliedMismatch =
          (Object.prototype.hasOwnProperty.call(input, "authorityKind") &&
            input.authorityKind !== storedAuthority.authorityKind) ||
          (Object.prototype.hasOwnProperty.call(input, "authorityWorkspaceId") &&
            input.authorityWorkspaceId !== storedAuthority.authorityWorkspaceId) ||
          (Object.prototype.hasOwnProperty.call(input, "authoritySubjectId") &&
            input.authoritySubjectId !== storedAuthority.authoritySubjectId);
        if (suppliedMismatch) {
          throw new Error("document authority changed before indexing");
        }
        if (suppliedCount !== 0 && suppliedCount !== suppliedAuthorityFields.length) {
          throw new Error("document authority tuple is partial");
        }
        const claimedDocument = await getDocument(lockedDb, input.workspaceId, input.documentId, {
          viewerSubjectId: storedAuthority.authoritySubjectId,
        });
        if (
          !claimedDocument ||
          claimedDocument.authorityKind !== storedAuthority.authorityKind ||
          claimedDocument.authorityWorkspaceId !== storedAuthority.authorityWorkspaceId ||
          claimedDocument.authoritySubjectId !== storedAuthority.authoritySubjectId
        ) {
          throw new Error("document authority changed before indexing");
        }
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
          { viewerSubjectId: storedAuthority.authoritySubjectId },
        );
        if (
          document.authorityKind !== storedAuthority.authorityKind ||
          document.authorityWorkspaceId !== storedAuthority.authorityWorkspaceId ||
          document.authoritySubjectId !== storedAuthority.authoritySubjectId
        ) {
          throw new Error("document authority changed before indexing");
        }
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
