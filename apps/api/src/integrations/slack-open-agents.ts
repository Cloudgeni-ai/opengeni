/**
 * Open Slack agents: an agent an organization admin opened to the
 * organization's people in Slack.
 *
 * Members of the agent's workspace keep using it as themselves, exactly as
 * before. Anyone else may ask it only when, on every message:
 *
 * - Slack says they are a full member of the installation's own team (never a
 *   guest, an external Slack Connect user, a bot or a deleted user), in a
 *   conversation only that team can see (not shared, externally shared or a
 *   group DM);
 * - their Slack account is linked to Opengeni (`slack_bot_user_links`); and
 * - the linked person is an active, full member of the installation's
 *   Opengeni organization.
 *
 * They get a chat that runs as the agent itself: a server-minted service
 * principal `slack-agent:<agentId>` in the agent's workspace. That principal
 * is nobody's identity, so:
 *
 * - Personal connections are unreachable: a service grant is never a
 *   personal-connection delegation source
 *   (`personalConnectionDelegationSourceForGrant` returns `none`), so the chat
 *   freezes no personal delegation and no turn names a person whose accounts
 *   could be used. Only workspace-owned and workspace-shared connections apply.
 *   The linked person's Opengeni id is recorded as context only.
 * - It holds a small, fixed permission set and tool list: reads of the
 *   workspace's Knowledge, files, artifacts and shared connections, and its
 *   own chat. No secrets, no schedules, no Knowledge or instruction writes, no
 *   other chats (`agentAccess: "session"`), no Slack channel reads beyond the
 *   conversation it was asked in, no sandbox, Sandbox Environment or vault.
 *   Shared connections' own tools follow the workspace tool policy, and any
 *   call that needs approval is refused.
 * - It runs unattended: nobody is asked to approve anything or answer a
 *   question, and a call that needs approval is refused at once.
 * - The chat is visible to the workspace's members, and only to them: a
 *   non-member has no grant in the workspace, so they cannot open it.
 * - The real Slack asker is recorded on the chat's creator and on every turn
 *   as service-initiator context, and on the Slack interaction.
 */
import type {
  AccessGrant,
  CreateSessionRequest,
  FirstPartyMcpToolName,
  Permission,
  VaultPolicy,
} from "@opengeni/contracts";
import {
  allowedFirstPartyMcpToolsForSession,
  type FirstPartyMcpToolPolicySettings,
} from "@opengeni/config";
import type { SlackAgentRecord } from "@opengeni/db";

import { escapeSlackMrkdwn } from "./slack-app-home";

const OPEN_SLACK_AGENT_SUBJECT_PREFIX = "slack-agent:";

/** The service principal an open agent's chats run as. Never a person. */
export function openSlackAgentSubjectId(agentId: string): string {
  return `${OPEN_SLACK_AGENT_SUBJECT_PREFIX}${agentId}`;
}

/** Whether a chat's owner is an open agent rather than a person. */
export function isOpenSlackAgentSubject(subjectId: string | null | undefined): boolean {
  return typeof subjectId === "string" && subjectId.startsWith(OPEN_SLACK_AGENT_SUBJECT_PREFIX);
}

/** The agent an open chat's owner names, or null for a person. */
export function openSlackAgentIdFromSubject(subjectId: string | null | undefined): string | null {
  return isOpenSlackAgentSubject(subjectId)
    ? subjectId!.slice(OPEN_SLACK_AGENT_SUBJECT_PREFIX.length)
    : null;
}

/**
 * What an open chat's agent may do. Everything here reads what the workspace
 * shares or acts on the chat itself; `sessions:control` is for the chat's own
 * controls, since `agentAccess: "session"` keeps it out of every other chat.
 */
export const OPEN_SLACK_AGENT_SESSION_PERMISSIONS: readonly Permission[] = Object.freeze([
  "workspace:read",
  "sessions:read",
  "sessions:control",
  "documents:search",
  "files:read",
  "artifacts:read",
  "connections:read",
  "github:use",
]);

/** The Slack side also starts and continues the chat. */
export const OPEN_SLACK_AGENT_GRANT_PERMISSIONS: readonly Permission[] = Object.freeze([
  ...OPEN_SLACK_AGENT_SESSION_PERMISSIONS,
  "sessions:create",
]);

/**
 * The Opengeni tools an open chat gets: reads only. Not the Slack channel
 * tools (the bot may be in channels the asker is not), not handoff or the
 * agent's chat list (they would carry one asker's request to another), and
 * nothing that writes workspace state.
 */
export const OPEN_SLACK_AGENT_FIRST_PARTY_MCP_TOOLS: readonly FirstPartyMcpToolName[] =
  Object.freeze([
    "knowledge_search",
    "knowledge_get",
    "knowledge_browse",
    "artifacts_list",
    "artifacts_get_source",
    "github_repositories_list",
    "atlassian_sources_list",
    "atlassian_search",
    "atlassian_get",
    "set_session_title",
  ]);

/** No vault: open chats never resolve secret references. */
export const OPEN_SLACK_AGENT_VAULT_POLICY: VaultPolicy = Object.freeze({
  mode: "selected",
  vaultIds: [],
}) as VaultPolicy;

/**
 * What an open chat is created with, on top of the ordinary Slack create.
 * Every field narrows: nobody waits on a person, no other chat is reachable,
 * nothing is remembered, no sandbox (so no shell, files or web of its own),
 * no Sandbox Environment or vault, and exactly the read-only Opengeni tools
 * and permissions above. Tools of the workspace's shared connections follow
 * the workspace tool policy; one that needs approval is refused, since nobody
 * is there to approve it.
 */
export function openSlackAgentSessionOptions(settings: FirstPartyMcpToolPolicySettings) {
  return {
    unattended: true,
    sandboxBackend: "none",
    agentAccess: "session",
    memoryScope: "off",
    rigId: null,
    vaultPolicy: OPEN_SLACK_AGENT_VAULT_POLICY,
    firstPartyMcpTools: allowedFirstPartyMcpToolsForSession(
      settings,
      OPEN_SLACK_AGENT_FIRST_PARTY_MCP_TOOLS,
    ),
    firstPartyMcpPermissions: [...OPEN_SLACK_AGENT_SESSION_PERMISSIONS],
  } satisfies Partial<CreateSessionRequest>;
}

/** The Slack person behind one message to an open agent. */
export type OpenSlackAgentAsker = {
  slackTeamId: string;
  slackUserId: string;
  slackChannelId: string;
  providerEventId: string;
  /**
   * The Opengeni person the Slack account is linked to. Recorded as context
   * only: the chat never acts as them or uses their connections.
   */
  opengeniSubjectId: string;
};

/**
 * The grant one message to an open agent runs with: the agent's own service
 * principal in its workspace, with the asker recorded as context. Built per
 * message so each turn records who actually asked.
 */
export function openSlackAgentGrant(
  agent: Pick<SlackAgentRecord, "id" | "name" | "targetAccountId" | "targetWorkspaceId">,
  asker: OpenSlackAgentAsker,
): AccessGrant {
  const subjectId = openSlackAgentSubjectId(agent.id);
  const label = agent.name.slice(0, 250);
  return {
    accountId: agent.targetAccountId,
    workspaceId: agent.targetWorkspaceId,
    subjectId,
    subjectLabel: label,
    permissions: [...OPEN_SLACK_AGENT_GRANT_PERMISSIONS],
    permissionMode: "explicit",
    principalKind: "service",
    serviceInitiator: { kind: "service", subjectId, label },
    serviceInitiatorContext: {
      slackAgentId: agent.id,
      slackTeamId: asker.slackTeamId,
      slackUserId: asker.slackUserId,
      slackChannelId: asker.slackChannelId,
      slackEventId: asker.providerEventId.slice(0, 256),
      opengeniSubjectId: asker.opengeniSubjectId.slice(0, 1024),
    },
  };
}

/** Live Slack facts about someone asking an open agent. */
export type OpenSlackAgentAskerFacts = {
  conversation: {
    isShared: boolean;
    isExternallyShared: boolean;
    isOrgShared: boolean;
    isPendingExternallyShared: boolean;
    isMpim: boolean;
  };
  asker: {
    teamId: string | null;
    isGuest: boolean | null;
    isExternal: boolean | null;
    isBot: boolean;
    deleted: boolean;
    isStranger: boolean;
  };
};

export type OpenSlackAgentRefusal = "not_eligible" | "shared_conversation";

/**
 * Why this person cannot ask an open agent here, or null when they can. Fails
 * closed: Slack must positively say the person is a full member of the
 * installation's own team, and the conversation must be one only that team
 * can see.
 */
export function openSlackAgentRefusal(
  facts: OpenSlackAgentAskerFacts,
  installationTeamId: string,
): OpenSlackAgentRefusal | null {
  const { asker, conversation } = facts;
  if (
    asker.isGuest !== false ||
    asker.isExternal !== false ||
    asker.isBot ||
    asker.deleted ||
    asker.isStranger ||
    asker.teamId !== installationTeamId
  ) {
    return "not_eligible";
  }
  if (
    conversation.isShared ||
    conversation.isExternallyShared ||
    conversation.isOrgShared ||
    conversation.isPendingExternallyShared ||
    conversation.isMpim
  ) {
    return "shared_conversation";
  }
  return null;
}

/** Why a person Slack lets ask cannot ask as far as Opengeni knows them, or null. */
export type OpenSlackAgentPersonRefusal = "not_linked" | "not_organization_member";

/**
 * The Opengeni half of who may ask an open agent: the Slack account is linked
 * to someone who is an active, full member of the installation's organization
 * (both read live by the caller on every message).
 */
export function openSlackAgentPersonRefusal(input: {
  linkedSubjectId: string | null;
  organizationMember: boolean;
}): OpenSlackAgentPersonRefusal | null {
  if (!input.linkedSubjectId) return "not_linked";
  if (!input.organizationMember) return "not_organization_member";
  return null;
}

/** Slack trigger kinds that can start or continue an open agent's chat. */
export const OPEN_SLACK_AGENT_TRIGGER_KINDS: ReadonlySet<string> = new Set([
  "app_mention",
  "dm",
  "thread_reply",
]);

/** The first message of an open chat. No link: only members can open the chat. */
export function renderSlackOpenAgentStartLine(input: {
  agentName: string;
  workspaceName: string | null;
  handedOffByName: string | null;
  notice: boolean;
}): string {
  const passed = input.handedOffByName
    ? ` · Passed on by *${escapeSlackMrkdwn(input.handedOffByName)}*`
    : "";
  const notice = input.notice
    ? `\n${slackOpenAgentNoticeText(input.agentName, input.workspaceName)}`
    : "";
  return `*${escapeSlackMrkdwn(input.agentName)}* is on it${passed}${notice}`;
}

/** Shown once per person and agent, the first time someone outside the workspace asks. */
export function slackOpenAgentNoticeText(agentName: string, workspaceName: string | null): string {
  const where = workspaceName
    ? `members of the *${escapeSlackMrkdwn(workspaceName)}* workspace`
    : "members of its workspace";
  return `_What you tell ${escapeSlackMrkdwn(agentName)} is visible to ${where}._`;
}

/** The private reply to someone whose Slack account isn't linked to Opengeni. */
export function slackOpenAgentLinkRequiredText(agentName: string, linkUrl: string): string {
  return `To ask ${agentName}, link your Slack account to Opengeni: ${linkUrl}. No chat was started.`;
}

/** The private reply to a linked person who isn't an active member of the organization. */
export function slackOpenAgentOrganizationMembersOnlyText(agentName: string): string {
  return `${agentName} only answers members of this Opengeni organization. No chat was started.`;
}

/** The private reply to a guest, an external user or a bot. */
export function slackOpenAgentNotEligibleText(agentName: string): string {
  return `${agentName} doesn't take requests from guests or people outside this Slack workspace. No chat was started.`;
}

/** The private reply in a conversation shared beyond this Slack workspace. */
export function slackOpenAgentSharedConversationText(agentName: string): string {
  return `${agentName} doesn't answer people outside its workspace in conversations shared with other teams. Message it directly instead. No chat was started.`;
}

/** The private reply to a non-member in a member's chat. */
export function slackOpenAgentMembersOnlyThreadText(
  agentName: string,
  workspaceName: string | null,
): string {
  const where = workspaceName ? `the ${workspaceName} workspace` : "its workspace";
  return `Only members of ${where} can continue this chat. Ask ${agentName} in a new message instead.`;
}

/** The private reply in an open chat whose agent is no longer open, or gone. */
export function slackOpenAgentClosedThreadText(agentName: string | null): string {
  return `${agentName ?? "This agent"} no longer answers people outside its workspace, so this chat can't continue. Start a new message to ask again.`;
}

/**
 * The private reply to a shortcut or Ask form in an open chat's thread: an
 * open chat continues only from a mention or a thread reply.
 */
export function slackOpenAgentMentionOnlyThreadText(agentName: string): string {
  return `To ask ${agentName} in this thread, mention Opengeni here. Your request wasn't sent.`;
}

/** What an open chat's agent is told, after its ordinary agent instructions. */
export function slackOpenAgentSessionInstructions(workspaceName: string | null): string {
  const workspace = workspaceName ? `the ${workspaceName} workspace` : "this workspace";
  return `Organization members outside ${workspace} can ask you here. You act as yourself, not as the asker, with only what ${workspace} shares. For anything that needs approval or a member's access, say what is left and that a member of ${workspace} can help. What people tell you here is visible to the workspace's members.`;
}

/** The whole agent part of an open chat's instructions. */
export function openSlackAgentInstructions(
  agent: Pick<SlackAgentRecord, "name" | "description" | "instructions" | "knowledgeCollectionId">,
  workspaceName: string | null,
): string {
  const lines = [
    `You are ${agent.name}, a Slack agent: ${agent.description} Your Slack messages post as ${agent.name}.`,
  ];
  const adminInstructions = agent.instructions.trim();
  if (adminInstructions.length > 0) {
    lines.push(`Instructions for ${agent.name}:\n${adminInstructions}`);
  }
  if (agent.knowledgeCollectionId) {
    lines.push(
      `Your Memory is Knowledge collection ${agent.knowledgeCollectionId}; when context is missing, search it with knowledge_search (groupId ${agent.knowledgeCollectionId}). This chat can read it but not save to it.`,
    );
  }
  lines.push(slackOpenAgentSessionInstructions(workspaceName));
  return lines.join("\n\n");
}
