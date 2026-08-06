import {
  WORKSPACE_STATE_MAX_BASES,
  WORKSPACE_STATE_MAX_TOPICS,
  WORKSPACE_STATE_TOPIC_MAX_CHARS,
  WorkspaceStateQuery,
  WorkspaceStateResponse,
  type AccessGrant,
  type WorkspaceStateQuery as WorkspaceStateQueryType,
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

import { serializeWorkspaceStateExport } from "../workspace-state-export";
import { projectWorkspaceState } from "../workspace-state-projection";

async function readWorkspaceState(
  deps: ApiRouteDeps,
  input: { workspaceId: string; query: WorkspaceStateQueryType; grant: AccessGrant },
) {
  const { workspaceId, query, grant } = input;
  const generatedAt = new Date().toISOString();
  const canInspectKnowledge = hasPermission(grant.permissions, "documents:search");

  const [workspace, policies, knowledge, currentPreferences, acceptedAttempt] = await Promise.all([
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
    getCurrentPreferenceRegistryGovernanceMetadata(deps.db, {
      workspaceId,
      subjectId: grant.subjectId,
    }),
    query.attemptId
      ? getWorkspaceStateAcceptedAttemptGovernance(deps.db, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          attemptId: query.attemptId,
        })
      : Promise.resolve(null),
  ]);

  if (!workspace) throw new HTTPException(404, { message: "workspace not found" });
  const attemptGovernance = query.attemptId
    ? acceptedAttempt
      ? {
          status: "available" as const,
          attemptId: acceptedAttempt.attemptId,
          executionGeneration: acceptedAttempt.executionGeneration,
          acceptedAt: acceptedAttempt.acceptedAt,
          policySnapshot: acceptedAttempt.policySnapshot,
          preferenceSnapshot: acceptedAttempt.preferenceSnapshot
            ? {
                id: acceptedAttempt.preferenceSnapshot.id,
                descriptorHash: acceptedAttempt.preferenceSnapshot.descriptorHash,
                descriptors: acceptedAttempt.preferenceSnapshot.descriptors.map((descriptor) => ({
                  id: descriptor.id,
                  revisionId: descriptor.revisionId,
                  contentHash: descriptor.contentHash,
                  activeVersion: descriptor.activeVersion,
                  scope: descriptor.scope,
                })),
                truncated: acceptedAttempt.preferenceSnapshot.truncated,
                createdAt: acceptedAttempt.preferenceSnapshot.createdAt,
              }
            : null,
          currentPreferences,
        }
      : { status: "unavailable" as const }
    : null;

  return WorkspaceStateResponse.parse(
    projectWorkspaceState({
      workspaceId,
      generatedAt,
      workspaceAgentInstructions: workspace.agentInstructions,
      policies,
      preferences: currentPreferences,
      knowledge,
      attemptGovernance,
    }),
  );
}

export function registerWorkspaceStateRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/workspace-state";

  app.get(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const query = WorkspaceStateQuery.parse(context.req.query());
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const state = await readWorkspaceState(deps, { workspaceId, query, grant });
    context.header("cache-control", "private, no-store");
    return context.json(state);
  });

  app.get(`${base}/export`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const query = WorkspaceStateQuery.parse(context.req.query());
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const state = await readWorkspaceState(deps, { workspaceId, query, grant });
    context.header("cache-control", "private, no-store");
    context.header("content-type", "application/json; charset=utf-8");
    context.header(
      "content-disposition",
      `attachment; filename="workspace-state-${workspaceId}-sanitized.json"`,
    );
    return context.body(serializeWorkspaceStateExport(state));
  });
}
