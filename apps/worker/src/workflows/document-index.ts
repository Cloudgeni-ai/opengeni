import { documentActivity } from "./activities";
import type { IndexDocumentInput } from "../activities/types";

export type DocumentIndexWorkflowInput = IndexDocumentInput;

export async function documentIndexWorkflow(input: DocumentIndexWorkflowInput) {
  return await documentActivity.indexDocument(input);
}
