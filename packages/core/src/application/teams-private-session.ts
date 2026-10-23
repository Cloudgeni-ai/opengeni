import { HTTPException } from "hono/http-exception";
import {
  getPrivateSessionCreatePolicy,
  getSessionAuthorityProjection,
  getWorkspaceGrant,
  requireTeamsConversationProof,
  namedSubjectHasLiveWorkspaceAuthority,
  type Database,
  type TeamsConversationProof,
} from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import type { AppDependencies } from "../dependencies";
import { requirePermission } from "../access";
import { requireDeploymentAllowsOnlyMe } from "./organization-privacy";

/** Internal Teams message admission, distinct from cookie-based tenancy mutation.
 * Only the authenticated ingress writer can produce the matching durable inbox.
 * This grants admission of that exact message/session, never visibility mutation,
 * forks, approval authority or personal-workspace inheritance.
 */
export async function authorizeTeamsConversationAdmission(
  deps: Pick<AppDependencies, "db" | "settings">,
  grant: AccessGrant,
  input: {
    workspaceId: string;
    sessionId: string | undefined;
    privateCreate?: boolean;
    creating?: boolean;
    personal?: boolean;
    initialMessage: string;
    proof: TeamsConversationProof;
  },
): Promise<(tx: Database) => Promise<void>> {
  if (
    !input.sessionId ||
    grant.workspaceId !== input.workspaceId ||
    grant.metadata?.["sessionId"]
  ) {
    throw new HTTPException(403, { message: "teams_private_session_proof_invalid" });
  }
  requirePermission(grant, "sessions:create");
  const accepted = {
    accountId: grant.accountId,
    workspaceId: input.workspaceId,
    subjectId: grant.subjectId,
    sessionId: input.sessionId,
    initialMessage: input.initialMessage,
    proof: { ...input.proof },
    ...(input.personal !== undefined ? { personal: input.personal } : {}),
  };
  const verify = async (db: Database, requireExistingSession = false) => {
    let source: Awaited<ReturnType<typeof requireTeamsConversationProof>>;
    try {
      source = await requireTeamsConversationProof(db, accepted);
    } catch (error) {
      if (error instanceof Error && error.message === "teams_private_session_proof_invalid")
        throw new HTTPException(403, { message: error.message });
      throw error;
    }
    if (
      !(
        deps.settings.teamsBotEnabled ||
        deps.settings.teamsBotAllowedTenantIds.some(
          (id) => id.toLowerCase() === source.tenantId.toLowerCase(),
        )
      )
    ) {
      throw new HTTPException(403, { message: "teams_bot_disabled" });
    }
    if (
      !source.personal &&
      (!source.channelId ||
        !deps.settings.teamsBotAllowedChannelIds.includes(`${source.tenantId}:${source.channelId}`))
    ) {
      throw new HTTPException(403, { message: "teams_channel_disabled" });
    }
    const audience = await getSessionAuthorityProjection(
      db,
      accepted.workspaceId,
      accepted.sessionId,
    );
    if (
      (!audience && (requireExistingSession || !input.creating)) ||
      (audience &&
        (source.personal
          ? audience.visibility !== "user_private" || audience.ownerSubjectId !== accepted.subjectId
          : audience.visibility !== "workspace_shared"))
    ) {
      throw new HTTPException(403, { message: "teams_session_audience_changed" });
    }
    const liveGrant = await getWorkspaceGrant(db, accepted.subjectId, accepted.workspaceId);
    if (!liveGrant || liveGrant.accountId !== accepted.accountId) {
      throw new HTTPException(403, { message: "teams_actor_access_revoked" });
    }
    requirePermission(liveGrant, "sessions:create");
    if (!(await namedSubjectHasLiveWorkspaceAuthority(db, accepted))) {
      throw new HTTPException(403, { message: "teams_actor_access_revoked" });
    }
    if (!input.privateCreate) return;
    // This capability deliberately has no Personal-workspace exception.
    const policy = await getPrivateSessionCreatePolicy(db, {
      workspaceId: input.workspaceId,
      actorSubjectId: grant.subjectId,
    });
    if (policy.personalWorkspace || !policy.platformAvailable || !policy.organizationEnabled) {
      throw new HTTPException(403, { message: "teams_private_sessions_unavailable" });
    }
    await requireDeploymentAllowsOnlyMe(
      { ...deps, db },
      { workspaceId: input.workspaceId, actorSubjectId: grant.subjectId },
    );
  };
  await verify(deps.db);
  return async (tx) => verify(tx, true);
}
