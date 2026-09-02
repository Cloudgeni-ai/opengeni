import { OpenGeniApiError } from "@opengeni/sdk/browser";

/**
 * Delete once, then point-read the workspace when the mutation reports an
 * error. A missing workspace proves the requested end state was committed,
 * including when a competing request deleted it first.
 */
export async function deleteWorkspaceWithReconciliation(input: {
  deleteWorkspace: () => Promise<void>;
  readWorkspace: () => Promise<unknown>;
}): Promise<void> {
  try {
    await input.deleteWorkspace();
  } catch (mutationError) {
    try {
      await input.readWorkspace();
    } catch (readError) {
      if (readError instanceof OpenGeniApiError && readError.status === 404) {
        return;
      }
    }
    throw mutationError;
  }
}
