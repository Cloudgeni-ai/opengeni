import { activity } from "./activities";

export type DocumentIndexWorkflowInput = {
  documentId: string;
};

export async function documentIndexWorkflow(input: DocumentIndexWorkflowInput) {
  return await activity.indexDocument(input);
}
