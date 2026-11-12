/**
 * Teams 1:1 chats with an agent anyone in the organization may use ("Who can
 * use it: Anyone in <organization>"), for a linked person who isn't a member
 * of the agent's workspace. The Teams half of organization-agents.ts, with
 * the same rules as Slack's open agents (slack-open-agents.ts):
 *
 * - Teams must positively say the person is a full member of the connected
 *   tenant (`userRole` "user" in that tenant), never a guest, an anonymous
 *   or external user; read live from Teams for every message.
 * - Only 1:1 chats: group chats and channels never route to agents.
 * - Their Teams account is linked, and the linked person is an active, full
 *   member of the agent's organization, read live when the message is
 *   queued, at session admission and before every delivery.
 * - The chat runs as the agent's own read-only service principal in its
 *   workspace (`teams-agent:<agentId>`), with Slack's open-agent permissions,
 *   tools and session options; the person is recorded as context only.
 * - The chat is visible to the workspace's members, and the person is told
 *   so once, on the first reply of their chat with that agent.
 *
 * Members of the agent's workspace keep using it as themselves, as always.
 */
import { createHash } from "node:crypto";
import type { AccessGrant } from "@opengeni/contracts";
import {
  TEAMS_ORGANIZATION_AGENT_ROUTE_PREFIX,
  teamsOrganizationAgentSubjectId,
  type TeamsAgentDirectoryEntry,
  type TeamsRoute,
} from "@opengeni/db";
import {
  OPEN_SLACK_AGENT_GRANT_PERMISSIONS,
  slackOpenAgentSessionInstructions,
} from "./slack-open-agents";
import type { TeamsMessage } from "./teams-protocol";

export { openSlackAgentSessionOptions as teamsOrganizationAgentSessionOptions } from "./slack-open-agents";

/**
 * The route of one person's chat with one organization agent. Its own route,
 * apart from the chat the person would have as a member of the agent's
 * workspace, so neither ever continues as the other.
 */
export function teamsOrganizationAgentRouteId(
  message: Pick<TeamsMessage, "routeIdentity">,
  generation: string,
  subjectId: string,
  sessionWorkspaceId: string | null,
  agentId: string,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "organization-agent",
        message.routeIdentity,
        generation,
        subjectId,
        sessionWorkspaceId,
        agentId,
      ]),
    )
    .digest("hex");
  return `${TEAMS_ORGANIZATION_AGENT_ROUTE_PREFIX}${digest}`;
}

/** Whether a route's chat runs as an organization agent. Route ids are server-made. */
export function isTeamsOrganizationAgentRoute(r: Pick<TeamsRoute, "route_id">): boolean {
  return r.route_id.startsWith(TEAMS_ORGANIZATION_AGENT_ROUTE_PREFIX);
}

/** The Teams person behind one message to an organization agent. */
export type TeamsOrganizationAgentAsker = {
  tenantId: string;
  actorId: string;
  /** Recorded as context only: the chat never acts as them or uses their connections. */
  opengeniSubjectId: string;
};

/**
 * The grant an organization agent's Teams chat runs with: the agent's own
 * service principal in its workspace, with the asker recorded as context.
 * Built from live checks each time it is needed, never stored.
 */
export function teamsOrganizationAgentGrant(
  agent: Pick<TeamsAgentDirectoryEntry, "id" | "name" | "accountId" | "workspaceId">,
  asker: TeamsOrganizationAgentAsker,
): AccessGrant {
  const subjectId = teamsOrganizationAgentSubjectId(agent.id);
  const label = agent.name.slice(0, 250);
  return {
    accountId: agent.accountId,
    workspaceId: agent.workspaceId,
    subjectId,
    subjectLabel: label,
    permissions: [...OPEN_SLACK_AGENT_GRANT_PERMISSIONS],
    permissionMode: "explicit",
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId, label },
    serviceInitiatorContext: {
      teamsAgentId: agent.id,
      teamsTenantId: asker.tenantId,
      teamsActorId: asker.actorId,
      opengeniSubjectId: asker.opengeniSubjectId.slice(0, 1024),
    },
  };
}

/** What Teams says about the sender of a 1:1 message (Connector `getMemberById`). */
export type TeamsMemberFacts = {
  aadObjectId?: string | null;
  tenantId?: string | null;
  userRole?: string | null;
};

/**
 * Whether Teams positively says the sender is a full member of the connected
 * tenant. Fails closed: a missing or different tenant, a role other than
 * "user" (a guest or anonymous user), or another person is not.
 */
export function teamsFullTenantMember(
  facts: TeamsMemberFacts | null,
  expected: { tenantId: string; actorId: string },
): boolean {
  return Boolean(
    facts &&
    facts.userRole === "user" &&
    typeof facts.tenantId === "string" &&
    facts.tenantId.toLowerCase() === expected.tenantId.toLowerCase() &&
    typeof facts.aadObjectId === "string" &&
    facts.aadObjectId.toLowerCase() === expected.actorId.toLowerCase(),
  );
}

/** For a guest, an anonymous user or someone Teams can't vouch for. */
export function teamsOrganizationAgentNotEligibleText(agentName: string): string {
  return `**${agentName}** doesn't take requests from guests or people outside your organization's Microsoft Teams. No chat was started.`;
}

/** For a linked person who isn't an active member of the organization. */
export function teamsOrganizationAgentMembersOnlyText(agentName: string): string {
  return `**${agentName}** only answers members of this Opengeni organization. No chat was started.`;
}

/** When an organization agent's chat can't take a message: the agent closed, or access changed. */
export function teamsOrganizationAgentUnavailableText(agentName: string): string {
  return `**${agentName}** isn't available to you right now. Send **switch** to choose another workspace or agent. No chat was started.`;
}

/** Shown once, on the first reply of a person's chat with an organization agent. */
export function teamsOrganizationAgentNoticeText(
  agentName: string,
  workspaceName: string | null,
): string {
  const where = workspaceName
    ? `members of the **${workspaceName}** workspace`
    : "members of its workspace";
  return `What you tell **${agentName}** is visible to ${where}.`;
}

/** What the agent is told in such a chat, after the Teams instructions. */
export function teamsOrganizationAgentInstructions(workspaceName: string | null): string {
  return slackOpenAgentSessionInstructions(workspaceName);
}
