import {
  WORKSPACE_STATE_MAX_BASES,
  WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT,
  WorkspaceStateResponse,
} from "@opengeni/contracts";
import { hasPermission, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  getWorkspace,
  listKnowledgeMemories,
  listWorkspaceInstructionPolicyRevisions,
} from "@opengeni/db";
import { listDocumentBases, listDocuments } from "@opengeni/documents";
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
            const bases = await listDocumentBases(deps.db, workspaceId);
            const selectedBases = bases.slice(0, WORKSPACE_STATE_MAX_BASES);
            const [documentEntries, memories] = await Promise.all([
              Promise.all(
                selectedBases.map(
                  async (base) =>
                    [
                      base.id,
                      await listDocuments(deps.db, workspaceId, base.id, {
                        viewerSubjectId: grant.subjectId,
                      }),
                    ] as const,
                ),
              ),
              listKnowledgeMemories(deps.db, workspaceId, {
                limit: WORKSPACE_STATE_MEMORY_SAMPLE_LIMIT,
              }),
            ]);
            return { bases, documentsByBase: new Map(documentEntries), memories };
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
