import { OpenGeniApiError } from "@opengeni/sdk/browser";

function shouldReconcile(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof OpenGeniApiError && error.outcomeUnknown);
}

/**
 * When a delete's response is lost, the server may still be committing it: a
 * large workspace takes seconds, and a read during that transaction still sees
 * the workspace. Confirm over about half a minute before reporting failure.
 */
export const WORKSPACE_DELETION_CONFIRM_DELAYS_MS: readonly number[] = [
  0, 500, 1_000, 2_000, 4_000, 8_000, 15_000,
];

const defaultSleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

type ReadOutcome = "deleted" | "present" | "unanswered" | "refused";

async function readDeletionOutcome(
  readWorkspace: () => Promise<unknown | null>,
): Promise<ReadOutcome> {
  try {
    return (await readWorkspace()) === null ? "deleted" : "present";
  } catch (readError) {
    if (readError instanceof OpenGeniApiError) {
      if (readError.status === 404) return "deleted";
      // A definitive refusal (for example signed out) won't change by waiting.
      return readError.retryable || readError.outcomeUnknown ? "unanswered" : "refused";
    }
    return "unanswered";
  }
}

/**
 * Treat DELETE 404 as idempotent success. For an outcome-unknown mutation,
 * point-read the workspace until an authoritative missing result confirms the
 * delete or the confirmation window ends. A read that still finds the
 * workspace may be racing the delete's own commit, so it is retried too.
 * Definitive mutation failures are preserved without reconciliation, and the
 * original mutation error is reported if deletion is never confirmed.
 */
export async function deleteWorkspaceWithReconciliation(input: {
  deleteWorkspace: () => Promise<void>;
  readWorkspace: () => Promise<unknown | null>;
  confirmDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
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
    const sleep = input.sleep ?? defaultSleep;
    for (const delayMs of input.confirmDelaysMs ?? WORKSPACE_DELETION_CONFIRM_DELAYS_MS) {
      if (delayMs > 0) await sleep(delayMs);
      const outcome = await readDeletionOutcome(input.readWorkspace);
      if (outcome === "deleted") return;
      if (outcome === "refused") break;
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
  confirmDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
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
    ...(input.confirmDelaysMs ? { confirmDelaysMs: input.confirmDelaysMs } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {}),
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
