import {
  WORKSPACE_STATE_MAX_BASES,
  WORKSPACE_STATE_MAX_TOPICS,
  WORKSPACE_STATE_TOPIC_MAX_CHARS,
  WorkspaceStateQuery,
  WorkspaceStateResponse,
} from "@opengeni/contracts";
import { hasPermission, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  getWorkspace,
  getCurrentPreferenceRegistryGovernanceMetadata,
  getWorkspaceStateAcceptedAttemptGovernance,
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
    const query = WorkspaceStateQuery.parse(context.req.query());
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const generatedAt = new Date().toISOString();
    const canInspectKnowledge = hasPermission(grant.permissions, "documents:search");

    const [workspace, policies, knowledge, attemptGovernance] = await Promise.all([
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
      query.attemptId
        ? getWorkspaceStateAcceptedAttemptGovernance(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            subjectId: grant.subjectId,
            attemptId: query.attemptId,
          }).then(async (snapshot) => {
            if (!snapshot) return { status: "unavailable" as const };
            const currentPreferences = await getCurrentPreferenceRegistryGovernanceMetadata(
              deps.db,
              {
                workspaceId,
                subjectId: grant.subjectId,
              },
            );
            return {
              status: "available" as const,
              attemptId: snapshot.attemptId,
              executionGeneration: snapshot.executionGeneration,
              acceptedAt: snapshot.acceptedAt,
              policySnapshot: snapshot.policySnapshot,
              preferenceSnapshot: snapshot.preferenceSnapshot
                ? {
                    id: snapshot.preferenceSnapshot.id,
                    descriptorHash: snapshot.preferenceSnapshot.descriptorHash,
                    descriptors: snapshot.preferenceSnapshot.descriptors.map((descriptor) => ({
                      id: descriptor.id,
                      revisionId: descriptor.revisionId,
                      contentHash: descriptor.contentHash,
                      activeVersion: descriptor.activeVersion,
                      scope: descriptor.scope,
                    })),
                    truncated: snapshot.preferenceSnapshot.truncated,
                    createdAt: snapshot.preferenceSnapshot.createdAt,
                  }
                : null,
              currentPreferences,
            };
          })
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
          attemptGovernance,
        }),
      ),
    );
  });
}
