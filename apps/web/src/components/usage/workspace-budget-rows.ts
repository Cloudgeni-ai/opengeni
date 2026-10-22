import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  getMyUsage,
  getWorkspaceAllowanceState,
  type WorkspaceAllowanceState,
  type WorkspaceUsageResponse,
} from "@opengeni/sdk/usage-allowances";

import { isForbidden } from "./use-workspace-budget";

export type WorkspaceBudgetRow = {
  state: WorkspaceAllowanceState | null;
  usage: WorkspaceUsageResponse | null;
  /** The budget could not be read (no authority, or an error). */
  unreadable: boolean;
};

/** Concurrent budget reads at most: a large organization must not fire one
 *  request per workspace at once. */
export const WORKSPACE_BUDGET_READ_CONCURRENCY = 4;

async function loadRow(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  readUsage: boolean,
): Promise<WorkspaceBudgetRow> {
  const [state, usage] = await Promise.allSettled([
    getWorkspaceAllowanceState(client, workspaceId),
    // Own usage needs a grant in the workspace; asking without one is a
    // guaranteed 403, so a non-member row shows the budget alone.
    readUsage ? getMyUsage(client, workspaceId) : Promise.resolve(null),
  ]);
  return {
    state: state.status === "fulfilled" ? state.value : null,
    // Not a member: the budget still shows; this month's total needs access.
    usage: usage.status === "fulfilled" ? usage.value : null,
    unreadable: state.status === "rejected" && !isForbidden(state.reason),
  };
}

/**
 * Read every row with at most `concurrency` workspaces in flight, reporting
 * each row as it lands. Own usage is requested only where `canReadUsage`.
 */
export async function loadWorkspaceBudgetRows({
  client,
  workspaceIds,
  canReadUsage,
  onRow,
  isActive = () => true,
  concurrency = WORKSPACE_BUDGET_READ_CONCURRENCY,
}: {
  client: OpenGeniBrowserClient;
  workspaceIds: readonly string[];
  canReadUsage: (workspaceId: string) => boolean;
  onRow: (workspaceId: string, row: WorkspaceBudgetRow) => void;
  isActive?: () => boolean;
  concurrency?: number;
}): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (isActive() && next < workspaceIds.length) {
      const workspaceId = workspaceIds[next++]!;
      const row = await loadRow(client, workspaceId, canReadUsage(workspaceId));
      if (isActive()) onRow(workspaceId, row);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, workspaceIds.length)) }, worker),
  );
}
