import { documentActivity } from "./activities";

export type DocumentIndexWorkflowInput = {
  accountId: string;
  workspaceId: string;
  documentId: string;
};

export async function documentIndexWorkflow(input: DocumentIndexWorkflowInput) {
  return await documentActivity.indexDocument(input);
}
