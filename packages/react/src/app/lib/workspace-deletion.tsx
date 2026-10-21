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
  readWorkspace: () => Promise<unknown | null>;
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
      const workspace = await input.readWorkspace();
      if (workspace === null) {
        return;
      }
    } catch (readError) {
      if (readError instanceof OpenGeniApiError && readError.status === 404) {
        return;
      }
    }
    throw mutationError;
  }
}

/** Reconcile organization-admin deletion through its content-blind overview. */
export async function deleteOrganizationWorkspaceWithReconciliation(input: {
  client: {
    deleteOrganizationWorkspace: (organizationId: string, workspaceId: string) => Promise<void>;
    getOrganizationAdministrationOverview: (
      organizationId: string,
    ) => Promise<{ workspaces: readonly { id: string }[] }>;
  };
  organizationId: string;
  workspaceId: string;
}): Promise<{ workspaces: readonly { id: string }[] } | null> {
  let reconciledOverview: { workspaces: readonly { id: string }[] } | null = null;
  await deleteWorkspaceWithReconciliation({
    deleteWorkspace: async () =>
      await input.client.deleteOrganizationWorkspace(input.organizationId, input.workspaceId),
    readWorkspace: async () => {
      const overview = await input.client.getOrganizationAdministrationOverview(
        input.organizationId,
      );
      reconciledOverview = overview;
      return overview.workspaces.find((workspace) => workspace.id === input.workspaceId) ?? null;
    },
  });
  if (reconciledOverview) {
    return reconciledOverview;
  }
  try {
    return await input.client.getOrganizationAdministrationOverview(input.organizationId);
  } catch {
    // Deletion already succeeded (or was authoritatively absent). A failed
    // navigation refresh must not turn that irreversible result into an error.
    return null;
  }
}

/**
 * Once deletion is authoritative, refresh and navigation are best-effort
 * follow-up work. Attempt both, but never turn their failure into a mutation
 * failure that invites the user to retry an already-committed deletion.
 */
export async function completeWorkspaceDeletionFollowUp(input: {
  refreshAccess: () => Promise<void>;
  navigate: () => Promise<void>;
}): Promise<{ status: "completed" } | { status: "failed"; error: unknown }> {
  let firstError: unknown;
  let failed = false;
  try {
    await input.refreshAccess();
  } catch (error) {
    firstError = error;
    failed = true;
  }
  try {
    await input.navigate();
  } catch (error) {
    if (!failed) firstError = error;
    failed = true;
  }
  return failed ? { status: "failed", error: firstError } : { status: "completed" };
}
