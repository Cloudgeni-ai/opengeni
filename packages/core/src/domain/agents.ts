import {
  SessionAvatar,
  slackAgentHandle,
  slackAgentNameKey,
  type Agent,
  type AgentChat,
  type AgentRevision,
  type AgentSlackAvailability,
  type AgentSummary,
  type AgentVisibility,
  type AccessGrant,
} from "@opengeni/contracts";
import type {
  AgentChatRecord,
  AgentRecord,
  AgentRevisionRecord,
  AgentSlackInstallRecord,
  Database,
} from "@opengeni/db";
import { hasPermission } from "../access";
import { scheduledTaskViewerSubjectForGrant } from "./scheduled-task-audience";

/**
 * Agents (docs/agents.md): who may see and change one, and how it reads.
 *
 * A shared (`workspace`) agent is for everyone in its home workspace and
 * works in every Slack workspace linked to it; an Only me (`private`) one
 * exists only for its owner, like an Only me chat. "Anyone in <organization>"
 * (`organization`) is a shared agent that full members of its organization may
 * also use from chat integrations; choosing it needs an organization admin,
 * decided by the caller from the request. Whoever made an agent and the admins
 * of its workspace may change it (a workspace-level caller without a person
 * may too, as with bot templates).
 */

/**
 * Who reads an agent: the person (null for a service), whether they
 * administer the workspace, and whether they may start chats there.
 */
export type AgentViewer = { subjectId: string | null; admin: boolean; contributor: boolean };

/** The person a grant reads agents as (or the person an agent acts for). */
export async function agentViewerForGrant(db: Database, grant: AccessGrant): Promise<AgentViewer> {
  return {
    subjectId: await scheduledTaskViewerSubjectForGrant(db, grant),
    admin: hasPermission(grant.permissions, "workspace:admin", grant.permissionMode),
    contributor: hasPermission(grant.permissions, "sessions:create", grant.permissionMode),
  };
}

/** Whether the viewer may see the agent at all. */
export function agentVisibleTo(
  viewer: AgentViewer,
  agent: Pick<AgentRecord, "visibility" | "ownerSubjectId">,
): boolean {
  return (
    agent.visibility === "workspace" ||
    (viewer.subjectId !== null && agent.ownerSubjectId === viewer.subjectId)
  );
}

/** Whether the viewer may change or delete the agent: its creator or an admin. */
export function agentEditableBy(
  viewer: AgentViewer,
  agent: Pick<AgentRecord, "visibility" | "ownerSubjectId" | "createdBySubjectId">,
): boolean {
  if (!agentVisibleTo(viewer, agent)) return false;
  if (viewer.admin || viewer.subjectId === null) return true;
  if (!viewer.contributor) return false;
  return (
    viewer.subjectId === agent.createdBySubjectId ||
    (agent.visibility === "private" && viewer.subjectId === agent.ownerSubjectId)
  );
}

/**
 * Whether the viewer may make the agent Only me. It then belongs to the
 * person who made it, so only they or an admin may take a shared one away
 * from everyone; an agent no person made has nobody to keep it.
 */
export function agentViewerCanMakePrivate(
  viewer: AgentViewer,
  agent: Pick<AgentRecord, "visibility" | "ownerSubjectId" | "createdBySubjectId">,
): boolean {
  if (agent.visibility === "private") return agentEditableBy(viewer, agent);
  if (
    agent.createdBySubjectId === null ||
    agent.createdBySubjectId.startsWith("slack-agent:") ||
    agent.createdBySubjectId.startsWith("teams-agent:")
  ) {
    return false;
  }
  if (!agentEditableBy(viewer, agent)) return false;
  return viewer.admin || viewer.subjectId === agent.createdBySubjectId;
}

/** Who can use an agent, as the API says it. */
export function agentVisibilityValue(
  agent: Pick<AgentRecord, "visibility" | "organizationAccess">,
): AgentVisibility {
  if (agent.visibility === "private") return "private";
  return agent.organizationAccess ? "organization" : "workspace";
}

/**
 * A requested "Who can use it" as stored: the visibility, and whether anyone
 * in the organization can use it.
 */
export function agentVisibilityRecord(visibility: AgentVisibility): {
  visibility: "private" | "workspace";
  organizationAccess: boolean;
} {
  return visibility === "private"
    ? { visibility: "private", organizationAccess: false }
    : { visibility: "workspace", organizationAccess: visibility === "organization" };
}

export type AgentViewContext = {
  viewer: AgentViewer;
  installs: readonly AgentSlackInstallRecord[];
  slackTeamNames: ReadonlyMap<string, string | null>;
  memoryReviewFirst: boolean;
  /** The request carries an organization admin's proof. */
  viewerIsOrganizationAdmin: boolean;
};

function slackAvailability(
  agent: AgentRecord,
  install: AgentSlackInstallRecord,
  teamNames: ReadonlyMap<string, string | null>,
): AgentSlackAvailability {
  return {
    connectionId: install.connectionId,
    slackTeamId: install.slackTeamId,
    slackTeamName: teamNames.get(install.connectionId) ?? null,
    // Slack routes by the installation's name key; an older name stored under
    // another key is reached by that key.
    handle:
      slackAgentNameKey(agent.name) === install.nameKey
        ? slackAgentHandle(agent.name)
        : install.nameKey,
    // Anyone in the organization is the agent's own setting
    // (`agents.organization_access`); installations no longer decide it.
    open: agent.organizationAccess,
    enabledBySubjectId: install.enabledBySubjectId,
    version: install.version,
    createdAt: install.createdAt.toISOString(),
    updatedAt: install.updatedAt.toISOString(),
  };
}

export function agentSlackAvailabilityView(
  agent: AgentRecord,
  install: AgentSlackInstallRecord,
  teamNames: ReadonlyMap<string, string | null>,
): AgentSlackAvailability {
  return slackAvailability(agent, install, teamNames);
}

/** An agent as lists show it. */
export function agentSummaryView(agent: AgentRecord, context: AgentViewContext): AgentSummary {
  const avatar = SessionAvatar.safeParse(agent.avatar);
  const canEdit = agentEditableBy(context.viewer, agent);
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    name: agent.name,
    description: agent.description,
    avatar: avatar.success ? avatar.data : null,
    visibility: agentVisibilityValue(agent),
    ownerSubjectId: agent.ownerSubjectId,
    origin: agent.origin,
    sourceSessionId: agent.sourceSessionId,
    createdBySubjectId: agent.createdBySubjectId,
    revision: agent.currentRevision,
    hasFirstMessage: false,
    memory: {
      enabled: agent.memoryEnabled,
      collectionId: agent.memoryCollectionId,
      scope: agent.visibility === "private" ? "personal" : "workspace",
      reviewFirst: context.memoryReviewFirst,
    },
    slack: context.installs
      .filter((install) => install.agentId === agent.id)
      .map((install) => slackAvailability(agent, install, context.slackTeamNames)),
    viewer: {
      canEdit,
      canManageSlack: context.viewer.admin && agent.visibility === "workspace",
      canOpenInSlack:
        context.viewer.admin &&
        context.viewerIsOrganizationAdmin &&
        agent.visibility === "workspace",
    },
    version: agent.version,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

/** One agent with its current Instructions (its First message fields are always empty). */
export function agentView(agent: AgentRecord, context: AgentViewContext): Agent {
  return {
    ...agentSummaryView(agent, context),
    instructions: agent.content?.instructions ?? "",
    firstMessage: "",
    revisionCreatedBySubjectId: agent.content?.createdBySubjectId ?? null,
    revisionCreatedAt: (agent.content?.createdAt ?? agent.updatedAt).toISOString(),
  };
}

export function agentRevisionView(revision: AgentRevisionRecord): AgentRevision {
  return {
    revision: revision.revision,
    name: revision.name,
    description: revision.description,
    instructions: revision.instructions,
    firstMessage: "",
    createdBySubjectId: revision.createdBySubjectId,
    createdAt: revision.createdAt.toISOString(),
  };
}

export function agentChatView(chat: AgentChatRecord): AgentChat {
  return {
    sessionId: chat.sessionId,
    title: chat.title,
    visibility: chat.visibility,
    createdBySubjectId: chat.createdBySubjectId,
    source: chat.slack ? "slack" : "app",
    slack: chat.slack,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}
