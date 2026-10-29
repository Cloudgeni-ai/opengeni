import { requireLiveAgentAttemptAuthorization } from "../session-authorization";
import {
  freezeAgentLearningPolicy,
  getSessionAuthorityProjection,
  learningPrivateFileOwner,
  type SessionRlsActorContext,
} from "@opengeni/db";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import { requirePermission, type AccessGrantAuthorization } from "../access";
import type { ApiRouteDeps } from "../dependencies";
import { knowledgeContextForAccess } from "./knowledge";

/**
 * The RLS actor for file access. For an agent, `chatOwnerSubjectId` is the
 * person its chat learns for (an Only me or user-memory chat), so a new file
 * follows the chat. It can differ from `privateFileOwnerSubjectId`: the owner's
 * own workspace chat in their Personal workspace reads their Only me files
 * but is not itself Only me (migration 1095).
 */
export type FileOwnerContext = SessionRlsActorContext & { chatOwnerSubjectId?: string | null };

/** Personal original-file access follows verified ownership, never a subject-shaped bearer. */
export async function fileOwnerContextForAccess(
  deps: Pick<ApiRouteDeps, "db">,
  access: AccessGrantAuthorization,
  permission: Permission,
): Promise<FileOwnerContext> {
  if (access.grant.principalKind === "agent_attempt")
    return fileOwnerContextForAgent(deps, access.grant, permission);
  const context = await knowledgeContextForAccess(deps, access, permission);
  if (context.actor.kind === "human")
    return {
      subjectId: context.actor.subjectId,
      privateFileOwnerSubjectId: context.actor.subjectId,
    };
  return { subjectId: access.grant.subjectId, privateFileOwnerSubjectId: null };
}

/** Internal MCP/core callers can prove an agent attempt without inventing a human authorization. */
export async function fileOwnerContextForAgent(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
  permission: Permission,
): Promise<FileOwnerContext> {
  requirePermission(grant, permission);
  const sessionId = grant.metadata?.sessionId;
  if (grant.principalKind !== "agent_attempt" || typeof sessionId !== "string")
    throw new Error("File access requires an exact agent attempt");
  const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
  const snapshot = await freezeAgentLearningPolicy(deps.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "agent",
      sessionId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration,
    },
  });
  const sessionAuthority = await getSessionAuthorityProjection(
    deps.db,
    grant.workspaceId,
    sessionId,
  );
  if (!sessionAuthority) throw new Error("File session authority unavailable");
  return {
    sessionAttachmentReadAccess: {
      sessionId,
      authorityEpoch: sessionAuthority.authorityEpoch,
      actor: attempt,
    },
    subjectId: grant.subjectId,
    initiatingHumanSubjectId: attempt.initiatingHumanSubjectId,
    agentRootSessionId: attempt.callerRootSessionId,
    privateFileOwnerSubjectId: learningPrivateFileOwner(snapshot),
    chatOwnerSubjectId: snapshot.defaultScope === "personal" ? snapshot.subjectId : null,
  };
}
