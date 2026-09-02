import { OpenGeniApiError } from "@opengeni/sdk/browser";

function shouldReconcile(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof OpenGeniApiError && error.outcomeUnknown);
}

/**
 * Treat DELETE 404 as idempotent success. For an outcome-unknown mutation,
 * point-read the workspace and accept only an authoritative missing result.
 * Definitive mutation failures are preserved without reconciliation.
 */
export async function deleteWorkspaceWithReconciliation(input: {
  deleteWorkspace: () => Promise<void>;
  readWorkspace: () => Promise<unknown>;
}): Promise<void> {
  try {
    await input.deleteWorkspace();
  } catch (mutationError) {
    if (mutationError instanceof OpenGeniApiError && mutationError.status === 404) {
      return;
    }
    if (!shouldReconcile(mutationError)) {
      throw mutationError;
    }
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
