import { HTTPException } from "hono/http-exception";
import {
  getPrivateSessionCreatePolicy,
  getSessionAuthorityProjection,
  getTeamsAgentInWorkspace,
  getWorkspaceGrant,
  TEAMS_ORGANIZATION_AGENT_ROUTE_PREFIX,
  teamsOrganizationAgentIdFromSubject,
  requireTeamsConversationProof,
  namedSubjectHasLiveWorkspaceAuthority,
  namedSubjectIsActiveOrganizationMember,
  namedSubjectPersonalWorkspaceId,
  resolveNamedManagedPersonalWorkspaceGrant,
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
 * forks or approval authority. A 1:1 route may hold its session in the sender's
 * own Personal workspace or, with Teams workspace routing, in another
 * workspace of the organization where the sender may start work; every other
 * route stays in the installation's.
 *
 * With workspace routing, a 1:1 route can also run as an agent anyone in the
 * organization may use, for a sender who isn't a member of the agent's
 * workspace (see `teamsOrganizationAgentGrant` in the API). That grant is the
 * agent's own service principal; the sender it acts for is the route's linked
 * person (`serviceInitiatorContext.opengeniSubjectId`), who must still be an
 * active full member of the organization, and the agent must still be open
 * to the organization and live in the session's workspace. Its chat is
 * visible to that workspace's members, never Only me.
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
  const organizationAgentId = teamsOrganizationAgentIdFromSubject(grant.subjectId);
  const asker = grant.serviceInitiatorContext?.["opengeniSubjectId"];
  if (
    organizationAgentId &&
    (grant.principalKind !== "service" ||
      typeof asker !== "string" ||
      !asker ||
      teamsOrganizationAgentIdFromSubject(asker) !== null ||
      grant.serviceInitiatorContext?.["teamsAgentId"] !== organizationAgentId ||
      !deps.settings.teamsWorkspaceRoutingEnabled ||
      input.privateCreate)
  ) {
    throw new HTTPException(403, { message: "teams_private_session_proof_invalid" });
  }
  const accepted = {
    accountId: grant.accountId,
    workspaceId: input.workspaceId,
    // The route, its inbox and its link name the person; an organization
    // agent's grant carries them as its initiator context.
    subjectId: organizationAgentId ? (asker as string) : grant.subjectId,
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
    if (organizationAgentId) {
      // Only a 1:1 route made for this agent's open use, in the agent's own
      // workspace, while the agent is still open to the organization and the
      // person an active full member of it.
      const agent = source.personal
        ? await getTeamsAgentInWorkspace(db, {
            accountId: accepted.accountId,
            workspaceId: accepted.workspaceId,
            agentId: organizationAgentId,
          })
        : null;
      if (
        !source.personal ||
        source.groupAudience ||
        source.agentId?.toLowerCase() !== organizationAgentId.toLowerCase() ||
        !source.routeId.startsWith(TEAMS_ORGANIZATION_AGENT_ROUTE_PREFIX) ||
        !agent?.organizationAccess ||
        !(await namedSubjectIsActiveOrganizationMember(db, accepted))
      )
        throw new HTTPException(403, { message: "teams_actor_access_revoked" });
      const audience = await getSessionAuthorityProjection(
        db,
        accepted.workspaceId,
        accepted.sessionId,
      );
      if (
        (!audience && (requireExistingSession || !input.creating)) ||
        (audience && audience.visibility !== "workspace_shared")
      )
        throw new HTTPException(403, { message: "teams_session_audience_changed" });
      return;
    }
    // Every other route is the person's own, never one made for an agent's
    // open use.
    if (source.routeId.startsWith(TEAMS_ORGANIZATION_AGENT_ROUTE_PREFIX))
      throw new HTTPException(403, { message: "teams_actor_access_revoked" });
    if (
      !source.personal &&
      !source.groupAudience &&
      (!source.channelId ||
        !deps.settings.teamsBotAllowedChannelIds.includes(`${source.tenantId}:${source.channelId}`))
    ) {
      throw new HTTPException(403, { message: "teams_channel_disabled" });
    }
    // A session outside the installation's workspace is only ever the 1:1
    // sender's own chat. Without workspace routing it is in their Personal
    // workspace, and they must still be able to use the installation's
    // workspace, where their Teams link lives. With it, the link is an
    // organization fact: the sender must be an active full member of the
    // organization, and their own access to the target is checked below.
    const elsewhere = source.installationWorkspaceId !== accepted.workspaceId;
    const ownPersonal =
      elsewhere &&
      (await namedSubjectPersonalWorkspaceId(db, {
        accountId: accepted.accountId,
        subjectId: accepted.subjectId,
      })) === accepted.workspaceId;
    const routing = deps.settings.teamsWorkspaceRoutingEnabled;
    if (
      elsewhere &&
      (!source.personal ||
        source.groupAudience ||
        (routing
          ? !(await namedSubjectIsActiveOrganizationMember(db, accepted))
          : !ownPersonal ||
            !(await namedSubjectHasLiveWorkspaceAuthority(db, {
              ...accepted,
              workspaceId: source.installationWorkspaceId,
            }))))
    ) {
      throw new HTTPException(403, { message: "teams_actor_access_revoked" });
    }
    if (source.groupAudience) {
      if (
        !deps.settings.teamsBotAllowedGroupChatIds.includes(
          `${source.tenantId}:${source.conversationId}`,
        )
      )
        throw new HTTPException(403, { message: "teams_group_disabled" });
      for (const member of source.groupAudience) {
        const memberGrant = await getWorkspaceGrant(db, member.subjectId, accepted.workspaceId);
        if (
          !memberGrant ||
          memberGrant.accountId !== accepted.accountId ||
          !(await namedSubjectHasLiveWorkspaceAuthority(db, {
            ...accepted,
            subjectId: member.subjectId,
          }))
        )
          throw new HTTPException(403, { message: "teams_group_audience_changed" });
        requirePermission(memberGrant, "sessions:read");
      }
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
    // The sender's own Personal workspace grant comes from their active
    // membership pointer; it has no workspace membership row. Any other
    // workspace needs their own membership there.
    const liveGrant = ownPersonal
      ? await resolveNamedManagedPersonalWorkspaceGrant(db, accepted)
      : await getWorkspaceGrant(db, accepted.subjectId, accepted.workspaceId);
    if (!liveGrant || liveGrant.accountId !== accepted.accountId) {
      throw new HTTPException(403, { message: "teams_actor_access_revoked" });
    }
    requirePermission(liveGrant, "sessions:create");
    if (!(await namedSubjectHasLiveWorkspaceAuthority(db, accepted))) {
      throw new HTTPException(403, { message: "teams_actor_access_revoked" });
    }
    if (!input.privateCreate) return;
    const policy = await getPrivateSessionCreatePolicy(db, {
      workspaceId: input.workspaceId,
      actorSubjectId: grant.subjectId,
    });
    // In the sender's own Personal workspace an Only me chat needs no
    // organization setting for shared workspaces, as anywhere else there. A
    // Personal workspace is reachable only through a 1:1 route that names it,
    // and only the sender's own.
    if (
      policy.personalWorkspace !== ownPersonal ||
      !policy.platformAvailable ||
      (!policy.personalWorkspace && !policy.organizationEnabled)
    ) {
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
