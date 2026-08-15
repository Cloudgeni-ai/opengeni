import {
  CompanyBrainOkfPackage,
  type WorkspaceInstructionPolicyRevision,
} from "@opengeni/contracts";
import { hasPermission, requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  getCurrentPreferenceRegistryGovernanceMetadata,
  getWorkspace,
  getWorkspaceInstructionPolicyRevision,
  listActivatedCompanyBrainPolicyRevisionIds,
  listCompanyBrainPreferenceGuidance,
  listCompanyProfile,
  listWorkspaceInstructionPolicyRevisions,
  listWorkspaceStateMemoryRecords,
} from "@opengeni/db";
import { getDocumentInventory } from "@opengeni/documents";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { createCompanyBrainOkfPackage, serializeCompanyBrainOkf } from "../company-brain-okf";
import { projectWorkspaceState } from "../workspace-state-projection";

const BASE_LIMIT = 24;
const TOPIC_LIMIT = 24;
const TOPIC_MAX_CHARS = 96;

async function readCompanyBrainPackage(
  deps: ApiRouteDeps,
  input: {
    workspaceId: string;
    accountId: string;
    subjectId: string;
    canInspectKnowledge: boolean;
  },
) {
  const generatedAt = new Date().toISOString();
  const [
    workspace,
    instructionPolicies,
    companyProfile,
    preferences,
    currentPreferences,
    knowledge,
  ] = await Promise.all([
    getWorkspace(deps.db, input.workspaceId),
    listWorkspaceInstructionPolicyRevisions(deps.db, input.workspaceId, { limit: 100 }),
    listCompanyProfile(deps.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      limit: 100,
    }),
    listCompanyBrainPreferenceGuidance(deps.db, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
    }),
    getCurrentPreferenceRegistryGovernanceMetadata(deps.db, {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
    }),
    input.canInspectKnowledge
      ? Promise.all([
          getDocumentInventory(deps.db, input.workspaceId, {
            baseLimit: BASE_LIMIT,
            topicLimit: TOPIC_LIMIT,
            topicMaxChars: TOPIC_MAX_CHARS,
            access: { viewerSubjectId: input.subjectId },
          }),
          listWorkspaceStateMemoryRecords(deps.db, input.workspaceId),
        ]).then(([documents, memories]) => ({ documents, memories }))
      : Promise.resolve(null),
  ]);
  if (!workspace) throw new HTTPException(404, { message: "workspace not found" });

  const listedRevisionIds = new Set(instructionPolicies.revisions.map((revision) => revision.id));
  const missingActiveIds = instructionPolicies.activeHeads
    .map((head) => head.revisionId)
    .filter((revisionId) => !listedRevisionIds.has(revisionId));
  const activeInstructionPolicyRevisions: WorkspaceInstructionPolicyRevision[] = [
    ...instructionPolicies.revisions.filter((revision) =>
      instructionPolicies.activeHeads.some((head) => head.revisionId === revision.id),
    ),
    ...(await Promise.all(
      missingActiveIds.map((revisionId) =>
        getWorkspaceInstructionPolicyRevision(deps.db, input.workspaceId, revisionId),
      ),
    )),
  ];
  const activatedInstructionPolicyRevisionIds = await listActivatedCompanyBrainPolicyRevisionIds(
    deps.db,
    {
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      revisionIds: [...instructionPolicies.revisions, ...activeInstructionPolicyRevisions].map(
        (revision) => revision.id,
      ),
    },
  );

  const state = projectWorkspaceState({
    workspaceId: input.workspaceId,
    generatedAt,
    workspaceAgentInstructions: workspace.agentInstructions,
    policies: instructionPolicies,
    preferences: currentPreferences,
    knowledge,
    attemptGovernance: null,
  });
  return createCompanyBrainOkfPackage({
    workspaceId: input.workspaceId,
    generatedAt,
    companyProfile,
    instructionPolicies,
    activeInstructionPolicyRevisions,
    activatedInstructionPolicyRevisionIds,
    preferences,
    knowledge: state.knowledge,
  });
}

export function registerCompanyBrainRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/company-brain";

  app.get(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const result = await readCompanyBrainPackage(deps, {
      workspaceId,
      accountId: grant.accountId,
      subjectId: grant.subjectId,
      canInspectKnowledge: hasPermission(grant.permissions, "documents:search"),
    });
    context.header("cache-control", "private, no-store");
    return context.json(CompanyBrainOkfPackage.parse(result));
  });

  app.get(`${base}/export`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "workspace:read");
    const result = await readCompanyBrainPackage(deps, {
      workspaceId,
      accountId: grant.accountId,
      subjectId: grant.subjectId,
      canInspectKnowledge: hasPermission(grant.permissions, "documents:search"),
    });
    context.header("cache-control", "private, no-store");
    context.header("content-type", "text/markdown; charset=utf-8");
    context.header(
      "content-disposition",
      `attachment; filename="company-brain-${workspaceId}.okf.md"`,
    );
    return context.body(serializeCompanyBrainOkf(result));
  });
}
