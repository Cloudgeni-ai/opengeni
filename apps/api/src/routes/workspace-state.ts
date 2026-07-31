import {
  WORKSPACE_STATE_MAX_BASES,
  WORKSPACE_STATE_MAX_TOPICS,
  WORKSPACE_STATE_TOPIC_MAX_CHARS,
  WorkspaceStateResponse,
} from "@opengeni/contracts";
import { hasPermission, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  getWorkspace,
  listWorkspaceStateMemoryRecords,
  listWorkspaceInstructionPolicyRevisions,
} from "@opengeni/db";
import { getDocumentInventory } from "@opengeni/documents";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { projectWorkspaceState } from "../workspace-state-projection";

export function registerWorkspaceStateRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get("/v1/workspaces/:workspaceId/workspace-state", async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const generatedAt = new Date().toISOString();
    const canInspectKnowledge = hasPermission(grant.permissions, "documents:search");

    const [workspace, policies, knowledge] = await Promise.all([
      getWorkspace(deps.db, workspaceId),
      listWorkspaceInstructionPolicyRevisions(deps.db, workspaceId, { limit: 1 }),
      canInspectKnowledge
        ? (async () => {
            const [documents, memories] = await Promise.all([
              getDocumentInventory(deps.db, workspaceId, {
                baseLimit: WORKSPACE_STATE_MAX_BASES,
                topicLimit: WORKSPACE_STATE_MAX_TOPICS,
                topicMaxChars: WORKSPACE_STATE_TOPIC_MAX_CHARS,
                access: { viewerSubjectId: grant.subjectId },
              }),
              listWorkspaceStateMemoryRecords(deps.db, workspaceId),
            ]);
            return { documents, memories };
          })()
        : Promise.resolve(null),
    ]);

    if (!workspace) {
      throw new HTTPException(404, { message: "workspace not found" });
    }
    context.header("cache-control", "private, no-store");
    return context.json(
      WorkspaceStateResponse.parse(
        projectWorkspaceState({
          workspaceId,
          generatedAt,
          workspaceAgentInstructions: workspace.agentInstructions,
          policies,
          knowledge,
        }),
      ),
    );
  });
}
