import type {
  AccessGrant,
  KnowledgeEntryReach,
  KnowledgeEntryReachRecord,
  KnowledgeEntryScope,
  Permission,
} from "@opengeni/contracts";
import {
  getKnowledgeEntryReach,
  listSharedWorkspaceIdsForAccount,
  namedSubjectPersonalWorkspaceId,
  ownRecordingWorkspaces,
  setKnowledgeEntryReach,
  type KnowledgeContext,
} from "@opengeni/db";
import { hasPermission, MissingPermissionRefusal, type AccessGrantAuthorization } from "../access";
import { requireLiveAgentAttemptAuthorization } from "../session-authorization";
import type { ApiRouteDeps } from "../dependencies";
import { HTTPException } from "hono/http-exception";

/** A delegated MCP gateway can retrieve shared Knowledge. Its subject label
 * does not establish personal ownership or human review authority. */
export async function knowledgeContextForGateway(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
): Promise<KnowledgeContext> {
  if (!hasPermission(grant.permissions, "documents:search"))
    throw new MissingPermissionRefusal("documents:search");
  if (grant.principalKind === "agent_attempt") {
    const sessionId = grant.metadata?.sessionId;
    if (typeof sessionId !== "string")
      throw new HTTPException(403, { message: "Knowledge attempt unavailable" });
    const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "agent",
        sessionId: attempt.callerSessionId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
      },
    };
  }
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "service",
      principalKind: "mcp_gateway",
      subjectId: grant.subjectId,
      writeScopes: [],
      review: false,
      settingsScopes: [],
    },
  };
}

/** One host boundary for HTTP, SDK-through-HTTP and first-party Knowledge tools. */
export async function knowledgeContextForAccess(
  deps: Pick<ApiRouteDeps, "db">,
  access: AccessGrantAuthorization,
  permission: Permission,
): Promise<KnowledgeContext> {
  const { grant } = access;
  if (!hasPermission(grant.permissions, permission)) {
    throw new MissingPermissionRefusal(permission);
  }
  if (grant.principalKind === "agent_attempt") {
    const sessionId = grant.metadata?.sessionId;
    if (typeof sessionId !== "string")
      throw new HTTPException(403, { message: "Knowledge attempt unavailable" });
    const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "agent",
        sessionId: attempt.callerSessionId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
      },
    };
  }
  if (
    grant.principalKind === "service" ||
    grant.principalKind === "api_key" ||
    grant.principalKind === "configured_key"
  ) {
    const writeScopes: Array<"workspace" | "organization"> = hasPermission(
      grant.permissions,
      "documents:manage",
    )
      ? ["workspace"]
      : [];
    if (writeScopes.length && access.accountGrant?.permissions.includes("account:admin"))
      writeScopes.push("organization");
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "service",
        principalKind: grant.principalKind,
        subjectId: grant.subjectId,
        writeScopes,
        review: false,
        settingsScopes: [],
      },
    };
  }
  if (
    grant.principalKind !== "human_session" ||
    !access.contextIntegrity ||
    access.authenticatedSubjectId !== grant.subjectId ||
    grant.serviceInitiator ||
    grant.serviceInitiatorContext ||
    grant.metadata?.attemptId !== undefined ||
    grant.metadata?.turnId !== undefined
  ) {
    throw new HTTPException(403, {
      message: "Knowledge management requires an authenticated human or agent attempt",
    });
  }
  const canWrite = hasPermission(grant.permissions, "documents:manage");
  const writeScopes: KnowledgeEntryScope[] = canWrite ? ["workspace", "personal"] : [];
  // Organization authority does not follow from the workspace-admin wildcard.
  if (canWrite && access.accountGrant?.permissions.includes("account:admin"))
    writeScopes.push("organization");
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: access.authenticatedSubjectId,
      writeScopes,
      review: canWrite,
      settingsScopes: [
        "personal",
        ...(hasPermission(grant.permissions, "workspace:admin") ? ["workspace" as const] : []),
      ],
    },
  };
}

export const KNOWLEDGE_REACH_WORKSPACE_MESSAGE =
  "Workspace Knowledge works only in its workspace. Organization and personal Knowledge can work in other workspaces.";
export const KNOWLEDGE_REACH_PERSONAL_SWITCH_MESSAGE =
  "Personal Knowledge always works in its owner's Personal workspace.";

/**
 * Change where an organization or personal entry works, from any workspace
 * that has it. Organization entries: whoever may write the organization's
 * Knowledge picks its shared workspaces. Personal entries: their owner picks
 * from the organization's workspaces they belong to. The workspace it was
 * added in always has it, and so does the owner's Personal workspace for a
 * personal entry, so neither is stored. Agents in a workspace it no longer
 * works in stop finding it on their next read.
 */
export async function changeKnowledgeEntryReach(
  deps: Pick<ApiRouteDeps, "db">,
  context: KnowledgeContext,
  entryId: string,
  reach: KnowledgeEntryReach,
): Promise<KnowledgeEntryReachRecord> {
  const current = await getKnowledgeEntryReach(deps.db, context, entryId);
  if (!current) throw new HTTPException(404, { message: "Knowledge entry not found" });
  if (current.scope === "workspace")
    throw new HTTPException(409, { message: KNOWLEDGE_REACH_WORKSPACE_MESSAGE });
  // Only the owner sees a personal entry, so a person who may change it owns it.
  if (!current.canChange || (current.scope === "personal" && context.actor.kind !== "human"))
    throw new HTTPException(403, {
      message:
        current.scope === "organization"
          ? "Only people who manage the organization's Knowledge change where it works."
          : "Only its owner changes where personal Knowledge works.",
    });
  let listed =
    reach.allowedWorkspaceIds === null
      ? null
      : [...new Set(reach.allowedWorkspaceIds)].filter((id) => id !== current.originWorkspaceId);
  if (current.scope === "personal") {
    if (!reach.allowPersonalWorkspaces)
      throw new HTTPException(422, { message: KNOWLEDGE_REACH_PERSONAL_SWITCH_MESSAGE });
    if (listed?.length) {
      const subjectId = context.actor.kind === "human" ? context.actor.subjectId : "";
      const [own, personalId] = await Promise.all([
        ownRecordingWorkspaces(deps.db, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          subjectId,
        }),
        namedSubjectPersonalWorkspaceId(deps.db, { accountId: context.accountId, subjectId }),
      ]);
      const known = new Set([context.workspaceId, ...own.map((workspace) => workspace.id)]);
      const unknown = listed.filter((id) => !known.has(id));
      if (unknown.length > 0)
        throw new HTTPException(422, {
          message: `These aren't workspaces of this organization you belong to: ${unknown.join(", ")}`,
        });
      listed = listed.filter((id) => id !== personalId);
    }
  } else if (listed?.length) {
    const shared = new Set(await listSharedWorkspaceIdsForAccount(deps.db, context.accountId));
    const unknown = listed.filter((id) => !shared.has(id));
    if (unknown.length > 0)
      throw new HTTPException(422, {
        message: `These aren't shared workspaces of this organization: ${unknown.join(", ")}`,
      });
  }
  return await setKnowledgeEntryReach(deps.db, context, {
    entryId,
    reach: { allowedWorkspaceIds: listed, allowPersonalWorkspaces: reach.allowPersonalWorkspaces },
  });
}
