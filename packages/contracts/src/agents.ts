import { z } from "zod";
import { defineSchema } from "./define-schema";
import { SessionAvatar } from "./bots";
import { AutomationTemplateSchedule, AutomationTemplateTrigger } from "./automation-templates";
import {
  SlackAgentChannelListResponse,
  SlackAgentIntroRequest,
  SlackAgentIntroResponse,
} from "./slack-agents";

/**
 * Agents: one record behind what used to be bot templates and Slack agents.
 *
 * An agent has a name, an optional icon (initials otherwise), a description of
 * what it helps with, standing Instructions that every one of its chats
 * follows, an optional First message the app puts in the composer when a chat
 * starts, and an optional Memory. It belongs to one home workspace, where its
 * chats run, and is either Only me (`private`) or shared with everyone in that
 * workspace (`workspace`). It is always available in the app, and a shared
 * one also in every Slack workspace linked to its home workspace.
 *
 * Every change to the Instructions is a new revision that records who made
 * it. Agents no longer have a First message: one sent by an older client
 * joins the Instructions. Ids are kept from the records agents replaced, so a
 * bot template id and a Slack agent id are also agent ids.
 *
 * This module must not import `./index`.
 */

export const AGENT_NAME_MAX_LENGTH = 120;
export const AGENT_DESCRIPTION_MAX_LENGTH = 280;
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 20_000;
/**
 * Agents no longer have a First message: Instructions are the one text saying
 * what an agent does. The field is still accepted from older clients and
 * joins the Instructions (see {@link agentInstructionsWithFirstMessage}).
 */
export const AGENT_FIRST_MESSAGE_MAX_LENGTH = 20_000;
/** Above this, the editor suggests moving facts into Memory. A hint, not a limit. */
export const AGENT_INSTRUCTIONS_SOFT_LIMIT = 8_000;
/** Agents one workspace keeps; creating another past this is refused. */
export const AGENTS_PER_WORKSPACE_MAX = 500;

/**
 * What an older First message joined to the Instructions starts with: it was
 * what a new chat opened with, so it stays something for the start of a chat
 * rather than becoming a standing rule.
 */
export const AGENT_FIRST_MESSAGE_LEAD = "When a chat starts:";

/**
 * An agent's Instructions with an older First message joined as its own
 * paragraph after them, led by `AGENT_FIRST_MESSAGE_LEAD`. Nothing is added
 * when there is no First message or the Instructions already contain it, so
 * joining twice changes nothing. Migration 1452 joined stored revisions the
 * same way.
 */
export function agentInstructionsWithFirstMessage(
  instructions: string,
  firstMessage: string,
): string {
  const first = firstMessage.trim();
  if (first.length === 0) return instructions;
  if (instructions.includes(first)) return instructions;
  const paragraph = `${AGENT_FIRST_MESSAGE_LEAD}\n${first}`;
  const base = instructions.trim();
  return base.length === 0 ? paragraph : `${base}\n\n${paragraph}`;
}

/**
 * The avatar an agent without its own icon shows: the first letter or digit
 * of up to two words of its name, on a hue derived from its id. A name with
 * no letters or digits gets the bot icon.
 */
export function agentInitialsAvatar(name: string, id: string): SessionAvatar {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  const hue = hash % 360;
  const letters = name
    .trim()
    .split(/\s+/u)
    .map((word) => [...word].find((char) => /[\p{L}\p{N}]/u.test(char)))
    .filter((char): char is string => typeof char === "string")
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return /^[\p{L}\p{N}]{1,2}$/u.test(letters)
    ? { kind: "letters", letters, hue }
    : { kind: "icon", icon: "bot", hue };
}

/** Machine-readable `details.code` values on agent errors. */
export const AGENT_ERROR_CODES = [
  /** `expectedVersion` is stale: refresh and try again. */
  "agent_version_conflict",
  /** Another agent already answers to this name in that Slack workspace. */
  "agent_slack_name_taken",
  /** The name breaks a Slack name rule; `details.problem` says which. */
  "agent_slack_name_invalid",
  /** Only shared (`workspace`) agents can be available in Slack. */
  "agent_slack_requires_workspace_visibility",
  /**
   * @deprecated Never returned: an agent is available in every linked Slack
   * workspace at once. Kept so the exported type does not narrow within a major.
   */
  "agent_slack_single_install",
  /**
   * Agents are available in every Slack workspace linked to their workspace;
   * there is nothing to turn off. Make one Only me to keep it out of Slack.
   */
  "agent_slack_always_available",
  /** The Opengeni Slack app is not available in the agent's workspace. */
  "slack_bot_unavailable",
  /** A personal workspace's agents stay in the app. */
  "agent_slack_personal_workspace",
  /** The workspace keeps the most agents it can. */
  "agent_limit_reached",
  /** `POST /sessions`: the agent does not exist here or is someone else's Only me agent. */
  "agent_not_found",
  /** `POST /sessions`: an Only me agent's chats are Only me. */
  "agent_requires_private_chat",
  /**
   * @deprecated Never returned: a chat started from another chat can start an
   * agent (delegation, see `session_create`'s `agent`). Kept so the exported
   * type does not narrow within a major.
   */
  "agent_child_chat",
  /** A Can use rule or Skill list is malformed; `details.problem` says how. */
  "agent_setup_invalid",
  /** `POST /agent-templates/:key/agents`: no ready-made agent has this key. */
  "agent_template_not_found",
  /** Two agents the caller can use share this name: use the agent's id. */
  "agent_name_ambiguous",
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

const Uuid = /* @__PURE__ */ defineSchema(() => z.string().uuid());

const AgentName = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .trim()
    .min(1, { message: "Give the agent a name." })
    .max(AGENT_NAME_MAX_LENGTH, {
      message: `Use at most ${AGENT_NAME_MAX_LENGTH} characters for the name.`,
    }),
);
const AgentDescription = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .trim()
    .max(AGENT_DESCRIPTION_MAX_LENGTH, {
      message: `Use at most ${AGENT_DESCRIPTION_MAX_LENGTH} characters for what it helps with.`,
    }),
);
const AgentInstructions = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .trim()
    .max(AGENT_INSTRUCTIONS_MAX_LENGTH, {
      message: `Instructions can be at most ${AGENT_INSTRUCTIONS_MAX_LENGTH} characters. Move lasting facts into Memory instead.`,
    }),
);
const AgentFirstMessage = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .trim()
    .max(AGENT_FIRST_MESSAGE_MAX_LENGTH, {
      message: `The first message can be at most ${AGENT_FIRST_MESSAGE_MAX_LENGTH} characters.`,
    }),
);

/**
 * Who can use an agent: `private` (Only me) is its owner; `workspace` is
 * everyone in its home workspace; `organization` is also anyone in its
 * organization, from chat integrations such as Slack (their chats run in
 * the agent's workspace, which its members can see). Clients must tolerate
 * values added later.
 */
export const AgentVisibility = /* @__PURE__ */ defineSchema(() =>
  z.enum(["private", "workspace", "organization"]),
);
export type AgentVisibility = z.infer<typeof AgentVisibility>;

/** Shared with its workspace, and maybe beyond: anything but Only me. */
export function agentVisibilityIsShared(visibility: AgentVisibility): boolean {
  return visibility !== "private";
}

/** What an agent was made from. Display and support only; grants nothing. */
export const AgentOrigin = /* @__PURE__ */ defineSchema(() =>
  z.enum(["app", "slack", "bot_template", "slack_agent"]),
);
export type AgentOrigin = z.infer<typeof AgentOrigin>;

/** The agent's Memory: a Knowledge collection its chats read and add to. */
export const AgentMemory = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** "Remember across chats". Off: no Memory and no reading other chats. */
    enabled: z.boolean(),
    /**
     * The Knowledge collection (a `group` entry). Null until Memory is first
     * switched on; set even while the collection itself waits for review.
     */
    collectionId: Uuid.nullable(),
    /** `workspace` for a shared agent, `personal` for an Only me one. */
    scope: z.enum(["workspace", "personal"]),
    /** New Memory waits for review before other chats find it. */
    reviewFirst: z.boolean(),
  }),
);
export type AgentMemory = z.infer<typeof AgentMemory>;

/** The agent's availability in one connected Slack workspace. */
export const AgentSlackAvailability = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** The Opengeni Slack installation. */
    connectionId: Uuid,
    slackTeamId: z.string(),
    /** The Slack workspace's name, when the reader can see it. */
    slackTeamName: z.string().nullable(),
    /** What people may type after `+`, for example `data-team`. */
    handle: z.string(),
    /**
     * Open use: people outside the agent's workspace can use it there too.
     * This is the agent's own "Anyone in <organization>" (`visibility:
     * "organization"`), the same in every Slack workspace.
     */
    open: z.boolean(),
    enabledBySubjectId: z.string().nullable(),
    version: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type AgentSlackAvailability = z.infer<typeof AgentSlackAvailability>;

export const AGENT_TOOL_PERMISSIONS_MAX = 200;
export const AGENT_SKILLS_MAX = 50;
export const AGENT_TEMPLATE_KEY_MAX_LENGTH = 120;

/**
 * One Can use choice for a tool in an agent's chats. `allow` follows the
 * connection's own setting; `ask` asks the person first; `block` refuses the
 * call. Agent rules only make chats stricter than the connection's settings.
 */
export const AgentToolPermission = /* @__PURE__ */ defineSchema(() =>
  z.enum(["allow", "ask", "block"]),
);
export type AgentToolPermission = z.infer<typeof AgentToolPermission>;

/**
 * One Can use rule. `connector` is a connection's server id (as the
 * tool-permissions API lists it), a provider domain such as `github.com`
 * (what ready-made agents use, matching any connection to that provider), or
 * `*` for every connection. `tool` is one tool name, or `*` for all of the
 * connector's tools. See {@link agentToolPermissionFor}.
 */
export const AgentToolPermissionRule = /* @__PURE__ */ defineSchema(() =>
  z.object({
    connector: z.string().trim().min(1).max(512),
    tool: z.string().trim().min(1).max(256).default("*"),
    permission: AgentToolPermission,
  }),
);
export type AgentToolPermissionRule = z.output<typeof AgentToolPermissionRule>;
export type AgentToolPermissionRuleInput = z.input<typeof AgentToolPermissionRule>;

const AgentToolPermissions = /* @__PURE__ */ defineSchema(() =>
  z.array(AgentToolPermissionRule).max(AGENT_TOOL_PERMISSIONS_MAX, {
    message: `An agent keeps at most ${AGENT_TOOL_PERMISSIONS_MAX} Can use rules.`,
  }),
);

/** A Skill the agent relies on, by name. Display only: Skills stay available to every chat. */
export const AgentSkillRef = /* @__PURE__ */ defineSchema(() =>
  z.object({ name: z.string().trim().min(1).max(200) }),
);
export type AgentSkillRef = z.infer<typeof AgentSkillRef>;

const AgentSkills = /* @__PURE__ */ defineSchema(() =>
  z.array(AgentSkillRef).max(AGENT_SKILLS_MAX, {
    message: `List at most ${AGENT_SKILLS_MAX} Skills.`,
  }),
);

/** The tool call a Can use choice is looked up for. */
export interface AgentToolPermissionTarget {
  /** The connection's canonical server id. */
  serverId: string;
  /** The provider's domain, such as `github.com`, when known. */
  providerDomain?: string | null | undefined;
  toolName: string;
}

function ruleConnectorRank(
  connector: string,
  target: AgentToolPermissionTarget,
): number | undefined {
  if (connector === target.serverId) return 3;
  const domain = target.providerDomain?.trim().toLowerCase();
  if (domain && connector.toLowerCase() === domain) return 2;
  if (connector === "*") return 1;
  return undefined;
}

const PERMISSION_STRICTNESS: Record<AgentToolPermission, number> = {
  allow: 0,
  ask: 1,
  block: 2,
};

/**
 * The agent's Can use choice for one tool call, or null when no rule names
 * it. The most specific rule wins: a server id beats a provider domain,
 * which beats `*`; at the same connector an exact tool beats `*`. Rules
 * equally specific resolve to the strictest.
 */
export function agentToolPermissionFor(
  rules: readonly AgentToolPermissionRuleInput[],
  target: AgentToolPermissionTarget,
): AgentToolPermission | null {
  return agentToolPermissionRuleFor(rules, target)?.permission ?? null;
}

/**
 * The rule {@link agentToolPermissionFor} decides by, with its tool
 * normalized (`*` when omitted), or null when no rule names the call.
 */
export function agentToolPermissionRuleFor(
  rules: readonly AgentToolPermissionRuleInput[],
  target: AgentToolPermissionTarget,
): AgentToolPermissionRule | null {
  let best: { rank: number; rule: AgentToolPermissionRule } | null = null;
  for (const rule of rules) {
    const connector = rule.connector.trim();
    const connectorRank = ruleConnectorRank(connector, target);
    if (connectorRank === undefined) continue;
    const tool = (rule.tool ?? "*").trim();
    if (tool !== "*" && tool !== target.toolName) continue;
    const rank = connectorRank * 2 + (tool === "*" ? 0 : 1);
    if (
      best === null ||
      rank > best.rank ||
      (rank === best.rank &&
        PERMISSION_STRICTNESS[rule.permission] > PERMISSION_STRICTNESS[best.rule.permission])
    ) {
      best = { rank, rule: { connector, tool, permission: rule.permission } };
    }
  }
  return best?.rule ?? null;
}

/**
 * The connector key Can use names Opengeni's built-in GitHub tools by. It is
 * GitHub's domain, so one rule also covers every GitHub connection, as the
 * ready-made agents' rules do.
 */
export const AGENT_BUILT_IN_GITHUB_CONNECTOR = "github.com";

/** What the reader may do with an agent. */
export const AgentViewerAccess = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /**
     * Rename it, change its Instructions, First message, Memory and who can
     * use it, or delete it: whoever made it, or an admin of its workspace.
     */
    canEdit: z.boolean(),
    /** Make it available in Slack, or not: an admin of its workspace. */
    canManageSlack: z.boolean(),
    /**
     * Choose "Anyone in <organization>" under who can use it: an organization
     * admin. Narrowing it back needs `canEdit`.
     */
    canOpenInSlack: z.boolean(),
  }),
);
export type AgentViewerAccess = z.infer<typeof AgentViewerAccess>;

/** An agent as lists show it: everything but its Instructions and First message. */
export const AgentSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: Uuid,
    /** Its home workspace: where its chats run. */
    workspaceId: Uuid,
    name: z.string(),
    description: z.string(),
    /** Null shows the name's initials. */
    avatar: SessionAvatar.nullable(),
    visibility: AgentVisibility,
    /** Whose Only me agent it is; null for a shared one. */
    ownerSubjectId: z.string().nullable(),
    origin: AgentOrigin,
    /** The chat it was made from, when it was made from one. */
    sourceSessionId: Uuid.nullable(),
    createdBySubjectId: z.string().nullable(),
    /** The current revision of its Instructions. */
    revision: z.number().int().positive(),
    /** Always false: agents no longer have a First message. Kept for older clients. */
    hasFirstMessage: z.boolean(),
    memory: AgentMemory,
    /** Can use: per tool Allow, Ask first or Block in its chats. Absent from older servers. */
    toolPermissions: z.array(AgentToolPermissionRule).default([]),
    /** The Skills it relies on, listed on its page. Absent from older servers. */
    skills: z.array(AgentSkillRef).default([]),
    /** The ready-made agent it was added from, if any. Absent from older servers. */
    templateKey: z.string().nullable().default(null),
    /** Slack workspaces it is available in. The app is always on. */
    slack: z.array(AgentSlackAvailability),
    viewer: AgentViewerAccess,
    /** Optimistic concurrency: send it back as `expectedVersion`. */
    version: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type AgentSummary = z.infer<typeof AgentSummary>;

/** One agent with its current Instructions. */
export const Agent = /* @__PURE__ */ defineSchema(() =>
  AgentSummary.extend({
    /** What it does and how; any older First message is joined as its own paragraph. */
    instructions: z.string(),
    /** Always empty: agents no longer have a First message. Kept for older clients. */
    firstMessage: z.string(),
    /** Who made the current revision, and when. */
    revisionCreatedBySubjectId: z.string().nullable(),
    revisionCreatedAt: z.string(),
  }),
);
export type Agent = z.infer<typeof Agent>;

/** Which agents a list shows: all the reader can use, or only the ones they made or own. */
export const AgentListFilter = /* @__PURE__ */ defineSchema(() => z.enum(["all", "yours"]));
export type AgentListFilter = z.infer<typeof AgentListFilter>;

export const ListAgentsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ agents: z.array(AgentSummary) }),
);
export type ListAgentsResponse = z.infer<typeof ListAgentsResponse>;

export const AgentResponse = /* @__PURE__ */ defineSchema(() => z.object({ agent: Agent }));
export type AgentResponse = z.infer<typeof AgentResponse>;

export const CreateAgentRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: AgentName,
      description: AgentDescription.default(""),
      avatar: SessionAvatar.nullable().default(null),
      /** Only a person can keep an agent to themselves. */
      visibility: AgentVisibility.default("workspace"),
      instructions: AgentInstructions.default(""),
      /** Older field: joins the Instructions as its own paragraph. */
      firstMessage: AgentFirstMessage.default(""),
      /** "Remember across chats". Creates its Memory collection when on. */
      memoryEnabled: z.boolean().default(false),
      /** A chat in this workspace the caller can open ("Make this an agent"). */
      sourceSessionId: Uuid.nullable().default(null),
      toolPermissions: AgentToolPermissions.default([]),
      skills: AgentSkills.default([]),
    })
    .strict(),
);
export type CreateAgentRequest = z.input<typeof CreateAgentRequest>;
export type ParsedCreateAgentRequest = z.output<typeof CreateAgentRequest>;

/** Changes only what it names, at the version the reader last saw. */
export const UpdateAgentRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedVersion: z.number().int().positive(),
      name: AgentName.optional(),
      description: AgentDescription.optional(),
      avatar: SessionAvatar.nullable().optional(),
      visibility: AgentVisibility.optional(),
      instructions: AgentInstructions.optional(),
      /** Older field: joins the Instructions as its own paragraph. */
      firstMessage: AgentFirstMessage.optional(),
      memoryEnabled: z.boolean().optional(),
      /** Replaces every Can use rule. */
      toolPermissions: AgentToolPermissions.optional(),
      /** Replaces the Skills list. */
      skills: AgentSkills.optional(),
    })
    .strict(),
);
export type UpdateAgentRequest = z.input<typeof UpdateAgentRequest>;
export type ParsedUpdateAgentRequest = z.output<typeof UpdateAgentRequest>;

export const DeleteAgentResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ deleted: z.boolean() }),
);
export type DeleteAgentResponse = z.infer<typeof DeleteAgentResponse>;

/** One saved version of an agent's Instructions and First message. */
export const AgentRevision = /* @__PURE__ */ defineSchema(() =>
  z.object({
    revision: z.number().int().positive(),
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    firstMessage: z.string(),
    createdBySubjectId: z.string().nullable(),
    createdAt: z.string(),
  }),
);
export type AgentRevision = z.infer<typeof AgentRevision>;

/** Newest first. Pass `nextCursor` as `?cursor=` for older ones. */
export const ListAgentRevisionsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    revisions: z.array(AgentRevision),
    nextCursor: z.string().nullable(),
  }),
);
export type ListAgentRevisionsResponse = z.infer<typeof ListAgentRevisionsResponse>;

/** Whose chats with an agent to list: the reader's own, or everyone's the reader can open. */
export const AgentChatsFilter = /* @__PURE__ */ defineSchema(() => z.enum(["yours", "everyone"]));
export type AgentChatsFilter = z.infer<typeof AgentChatsFilter>;

/** One chat with an agent. Only me chats are listed only to their owner. */
export const AgentChat = /* @__PURE__ */ defineSchema(() =>
  z.object({
    sessionId: Uuid,
    title: z.string().nullable(),
    visibility: z.enum(["private", "workspace"]),
    /** Who started it, when known. */
    createdBySubjectId: z.string().nullable(),
    /** Where it was started. */
    source: z.enum(["app", "slack"]),
    /** For a Slack chat: where in Slack it was started. */
    slack: z
      .object({
        connectionId: Uuid,
        channelId: z.string(),
        threadTs: z.string(),
        initiatingSlackUserId: z.string().nullable(),
      })
      .nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type AgentChat = z.infer<typeof AgentChat>;

/** Newest first. Pass `nextCursor` as `?cursor=` for older ones. */
export const ListAgentChatsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    chats: z.array(AgentChat),
    nextCursor: z.string().nullable(),
  }),
);
export type ListAgentChatsResponse = z.infer<typeof ListAgentChatsResponse>;

/** One connected Slack workspace and whether the agent is available there. */
export const AgentSlackInstall = /* @__PURE__ */ defineSchema(() =>
  z.object({
    connectionId: Uuid,
    slackTeamId: z.string(),
    slackTeamName: z.string().nullable(),
    /**
     * The Opengeni app's name in this Slack workspace, which people mention
     * (`Opengeni Staging`). Absent from older servers and for an installation
     * no longer linked here; read it as `Opengeni`.
     */
    botDisplayName: z.string().optional(),
    /** Null when the agent is not available in this Slack workspace. */
    availability: AgentSlackAvailability.nullable(),
    /**
     * Why it isn't, when it isn't: an `AGENT_ERROR_CODES` value such as
     * `agent_slack_name_taken`. Shared agents are available in every linked
     * Slack workspace unless something here stops it.
     */
    unavailable: z.enum(AGENT_ERROR_CODES).nullable().default(null),
    /**
     * False when this Slack app can't sign posts with the agent's name and
     * icon (no `chat:write.customize`): its replies show as Opengeni until
     * Slack is updated. Absent from older servers and for an installation no
     * longer linked here.
     */
    postsAsAgent: z.boolean().optional(),
    /**
     * The Opengeni workspace that holds this Slack installation, where an
     * admin updates it. Absent with `postsAsAgent`.
     */
    installWorkspaceId: Uuid.optional(),
  }),
);
export type AgentSlackInstall = z.infer<typeof AgentSlackInstall>;

/** The Slack workspaces linked to an agent's home workspace, and whether it is available in each. */
export const ListAgentSlackInstallsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    installs: z.array(AgentSlackInstall),
    /** Slack agents need workspace routing; with it off, they do not answer. */
    routingEnabled: z.boolean(),
  }),
);
export type ListAgentSlackInstallsResponse = z.infer<typeof ListAgentSlackInstallsResponse>;

/**
 * Change how the agent works in one Slack workspace (open use), making it
 * available there first if it isn't yet. Idempotent. Needs a shared
 * (`workspace`) agent, an admin of its workspace, and a name Slack can use;
 * turning `open` on needs an organization admin.
 */
export const PutAgentSlackAvailabilityRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** The availability's version, when changing an existing one. */
      expectedVersion: z.number().int().positive().optional(),
      open: z.boolean().optional(),
    })
    .strict(),
);
export type PutAgentSlackAvailabilityRequest = z.input<typeof PutAgentSlackAvailabilityRequest>;

export const AgentSlackAvailabilityResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ agent: Agent, availability: AgentSlackAvailability.nullable() }),
);
export type AgentSlackAvailabilityResponse = z.infer<typeof AgentSlackAvailabilityResponse>;

/** Channels and intro posts: the same shapes as a Slack agent's. */
export const AgentSlackChannelListResponse = SlackAgentChannelListResponse;
export type AgentSlackChannelListResponse = z.infer<typeof AgentSlackChannelListResponse>;
export const AgentSlackIntroRequest = SlackAgentIntroRequest;
export type AgentSlackIntroRequest = z.infer<typeof AgentSlackIntroRequest>;
export const AgentSlackIntroResponse = SlackAgentIntroResponse;
export type AgentSlackIntroResponse = z.infer<typeof AgentSlackIntroResponse>;

/**
 * A trigger a ready-made agent suggests. Nothing is created until the person
 * opens it, picks the repository, channel or source, and saves: it becomes
 * an ordinary automation that starts a chat with the agent.
 */
export const AgentTemplateTrigger = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** Short, for the agent page: "When a pull request opens". */
    name: z.string().min(1).max(120),
    /** What each run asks the agent to do. */
    instructions: z.string().min(1).max(AGENT_INSTRUCTIONS_MAX_LENGTH),
    /** Null: it runs only on its events. */
    schedule: AutomationTemplateSchedule.nullable().default(null),
    triggers: z.array(AutomationTemplateTrigger).default([]),
  }),
);
export type AgentTemplateTrigger = z.output<typeof AgentTemplateTrigger>;

/** A ready-made agent people can add from the "Add an agent" gallery. Content, not code. */
export const AgentTemplate = /* @__PURE__ */ defineSchema(() =>
  z.object({
    key: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
      .max(AGENT_TEMPLATE_KEY_MAX_LENGTH),
    name: AgentName,
    description: AgentDescription,
    avatar: SessionAvatar.nullable().default(null),
    instructions: AgentInstructions,
    memoryEnabled: z.boolean().default(true),
    toolPermissions: AgentToolPermissions.default([]),
    skills: AgentSkills.default([]),
    suggestedTriggers: z.array(AgentTemplateTrigger).max(10).default([]),
  }),
);
export type AgentTemplate = z.output<typeof AgentTemplate>;

export const ListAgentTemplatesResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ templates: z.array(AgentTemplate) }),
);
export type ListAgentTemplatesResponse = z.output<typeof ListAgentTemplatesResponse>;

/** Add a ready-made agent. Optional overrides; everything else comes from the template. */
export const CreateAgentFromTemplateRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: AgentName.optional(),
      visibility: AgentVisibility.optional(),
    })
    .strict(),
);
export type CreateAgentFromTemplateRequest = z.input<typeof CreateAgentFromTemplateRequest>;
