import { documentActivity } from "./activities";

export type DocumentIndexWorkflowInput = {
  workspaceId: string;
  documentId: string;
};

export async function documentIndexWorkflow(input: DocumentIndexWorkflowInput) {
  return await documentActivity.indexDocument(input);
}
