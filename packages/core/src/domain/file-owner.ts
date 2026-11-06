import { requireLiveAgentAttemptAuthorization } from "../session-authorization";
import {
  freezeAgentLearningPolicy,
  getSessionAuthorityProjection,
  getSlackPrivateSessionOwnerSubjectId,
  type SessionRlsActorContext,
} from "@opengeni/db";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import { requirePermission, type AccessGrantAuthorization } from "../access";
import type { ApiRouteDeps } from "../dependencies";
import { knowledgeContextForAccess } from "./knowledge";

/**
 * Whose personal files an agent of a session produces and reads. A session
 * whose root a private Slack interaction owns is fenced to that person, so it
 * is theirs like an Only-me session; otherwise the frozen learning destination
 * decides, as before. The Slack owner never changes the learning destination.
 */
export function agentPrivateFileOwnerSubjectId(
  learning: { defaultScope: string; subjectId: string | null },
  slackPrivateOwnerSubjectId: string | null,
): string | null {
  if (slackPrivateOwnerSubjectId) return slackPrivateOwnerSubjectId;
  return learning.defaultScope === "personal" ? learning.subjectId : null;
}

/**
 * File scope for a trusted in-process entry point (the Slack bot) that acts for
 * a person without a request authorization: inside that person's own private
 * Slack session, the files they sent it are theirs to attach. Undefined
 * everywhere else, where such a caller keeps no personal file owner.
 */
export async function inProcessFileOwnerContext(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
  sessionId: string | null | undefined,
  resources: unknown,
): Promise<SessionRlsActorContext | undefined> {
  if (grant.principalKind !== "human_session" || !sessionId) return undefined;
  const attachesFiles =
    Array.isArray(resources) &&
    resources.some(
      (resource: unknown) =>
        typeof resource === "object" &&
        resource !== null &&
        (resource as { kind?: unknown }).kind === "file",
    );
  if (!attachesFiles) return undefined;
  const owner = await getSlackPrivateSessionOwnerSubjectId(deps.db, grant.workspaceId, sessionId);
  if (owner === null || owner !== grant.subjectId) return undefined;
  return { subjectId: grant.subjectId, privateFileOwnerSubjectId: owner };
}

/** Personal original-file access follows verified ownership, never a subject-shaped bearer. */
export async function fileOwnerContextForAccess(
  deps: Pick<ApiRouteDeps, "db">,
  access: AccessGrantAuthorization,
  permission: Permission,
): Promise<SessionRlsActorContext> {
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
): Promise<SessionRlsActorContext> {
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
  const slackPrivateOwner = await getSlackPrivateSessionOwnerSubjectId(
    deps.db,
    grant.workspaceId,
    sessionId,
  );
  return {
    sessionAttachmentReadAccess: {
      sessionId,
      authorityEpoch: sessionAuthority.authorityEpoch,
      actor: attempt,
    },
    subjectId: grant.subjectId,
    initiatingHumanSubjectId: attempt.initiatingHumanSubjectId,
    agentRootSessionId: attempt.callerRootSessionId,
    privateFileOwnerSubjectId: agentPrivateFileOwnerSubjectId(snapshot, slackPrivateOwner),
  };
}
