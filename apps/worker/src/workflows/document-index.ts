import { documentActivity } from "./activities";
import type { DocumentAuthorityKind } from "@opengeni/contracts";

export type DocumentIndexWorkflowInput = {
  accountId: string;
  workspaceId: string;
  documentId: string;
  authorityKind: DocumentAuthorityKind;
  authorityWorkspaceId: string | null;
  authoritySubjectId: string | null;
};

export async function documentIndexWorkflow(input: DocumentIndexWorkflowInput) {
  return await documentActivity.indexDocument(input);
}
