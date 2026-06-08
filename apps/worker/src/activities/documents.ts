import { indexDocumentNow } from "@opengeni/documents";
import type {
  ActivityServices,
  IndexDocumentInput,
} from "./types";

export function createDocumentActivities(services: () => Promise<ActivityServices>) {
  return {
    indexDocument: async (input: IndexDocumentInput) => {
      const { db, objectStorage, documentServices } = await services();
      if (!objectStorage) {
        throw new Error("object storage is not configured");
      }
      return await indexDocumentNow(db, objectStorage, input.workspaceId, input.documentId, documentServices);
    },
  };
}
