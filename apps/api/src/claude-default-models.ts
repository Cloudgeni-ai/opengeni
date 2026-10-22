import type { ApiRouteDeps } from "@opengeni/core";
import {
  seedOrganizationClaudeDefaultModels,
  seedWorkspaceClaudeDefaultModels,
} from "@opengeni/db";

type ClaudeConnectionScope =
  | { organizationId: string; workspaceId?: undefined }
  | { accountId: string; workspaceId: string };

/**
 * After a Claude account connects, offer the default models where this scope
 * never configured any. The connection has already succeeded, so a failure
 * here is reported and leaves the model list as it was; people can still add
 * models themselves.
 */
export async function offerClaudeDefaultModels(
  deps: Pick<ApiRouteDeps, "db">,
  scope: ClaudeConnectionScope & {
    actorSubjectId: string;
    providerKind: "anthropic" | "claude_subscription";
  },
): Promise<void> {
  try {
    if (scope.workspaceId === undefined) {
      await seedOrganizationClaudeDefaultModels(deps.db, scope);
    } else {
      await seedWorkspaceClaudeDefaultModels(deps.db, scope);
    }
  } catch (error) {
    console.warn("[api] could not add the default Claude models", {
      providerKind: scope.providerKind,
      scope: scope.workspaceId === undefined ? "organization" : "workspace",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
