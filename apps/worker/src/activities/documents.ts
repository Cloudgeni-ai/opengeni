import type { DocumentServices } from "@opengeni/documents";
import {
  resolveDocumentIndexAuthority,
  rlsContextForWorkspace,
  withSessionRlsActorContext,
  withWorkspaceUsageLock,
} from "@opengeni/db";
import type { ControlActivityServices, IndexDocumentInput } from "./types";

export function createDocumentActivities(
  services: () => Promise<ControlActivityServices>,
  resolveDocumentServices?: () => Promise<DocumentServices>,
) {
  return {
    indexDocument: async (input: IndexDocumentInput) => {
      const { db, objectStorage } = await services();
      if (!objectStorage) {
        throw new Error("object storage is not configured");
      }
      if (!resolveDocumentServices) {
        throw new Error("document services are not configured");
      }
      const [{ getDocumentForIndexing, indexDocumentNow }, documentServices] = await Promise.all([
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
        const claimedDocument = await getDocumentForIndexing(
          lockedDb,
          input.workspaceId,
          input.documentId,
        );
        if (
          !claimedDocument ||
          claimedDocument.authorityKind !== storedAuthority.authorityKind ||
          claimedDocument.authorityWorkspaceId !== storedAuthority.authorityWorkspaceId ||
          claimedDocument.authoritySubjectId !== storedAuthority.authoritySubjectId
        ) {
          throw new Error("document authority changed before indexing");
        }
        const document = await withSessionRlsActorContext(
          {
            subjectId: "service:document-preparation",
            privateFileOwnerSubjectId:
              storedAuthority.authorityKind === "personal"
                ? storedAuthority.authoritySubjectId
                : null,
          },
          () =>
            indexDocumentNow(
              lockedDb,
              objectStorage,
              input.workspaceId,
              input.documentId,
              documentServices,
              { viewerSubjectId: storedAuthority.authoritySubjectId },
            ),
        );
        if (
          document.authorityKind !== storedAuthority.authorityKind ||
          document.authorityWorkspaceId !== storedAuthority.authorityWorkspaceId ||
          document.authoritySubjectId !== storedAuthority.authoritySubjectId
        ) {
          throw new Error("document authority changed before indexing");
        }
        return document;
      });
    },
  };
}
