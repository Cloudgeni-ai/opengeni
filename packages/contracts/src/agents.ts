import { z } from "zod";
import { defineSchema } from "./define-schema";
import { SessionAvatar } from "./bots";
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
 * workspace (`workspace`). It is always available in the app; it can also be
 * made available in a connected Slack workspace.
 *
 * Every change to the Instructions or First message is a new revision that
 * records who made it. Ids are kept from the records agents replaced, so a
 * bot template id and a Slack agent id are also agent ids.
 *
 * This module must not import `./index`.
 */

export const AGENT_NAME_MAX_LENGTH = 120;
export const AGENT_DESCRIPTION_MAX_LENGTH = 280;
export const AGENT_INSTRUCTIONS_MAX_LENGTH = 20_000;
export const AGENT_FIRST_MESSAGE_MAX_LENGTH = 20_000;
/** Above this, the editor suggests moving facts into Memory. A hint, not a limit. */
export const AGENT_INSTRUCTIONS_SOFT_LIMIT = 8_000;
/** Agents one workspace keeps; creating another past this is refused. */
export const AGENTS_PER_WORKSPACE_MAX = 500;

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
 * everyone in its home workspace. The same two words, and the same schema
 * shape, a chat uses; kept unexported so the public surface keeps naming it
 * `SessionVisibility`.
 */
const AgentVisibility = /* @__PURE__ */ defineSchema(() => z.enum(["private", "workspace"]));
export type AgentVisibility = z.infer<typeof AgentVisibility>;

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
    /** Open use: people outside the agent's workspace can use it there too. */
    open: z.boolean(),
    enabledBySubjectId: z.string().nullable(),
    version: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type AgentSlackAvailability = z.infer<typeof AgentSlackAvailability>;

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
    /** Turn open use in Slack on: an organization admin. Turning it off needs `canManageSlack`. */
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
    /** The current revision of its Instructions and First message. */
    revision: z.number().int().positive(),
    /** Whether a First message is set; read it from the agent itself. */
    hasFirstMessage: z.boolean(),
    memory: AgentMemory,
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

/** One agent with its current Instructions and First message. */
export const Agent = /* @__PURE__ */ defineSchema(() =>
  AgentSummary.extend({
    instructions: z.string(),
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
      firstMessage: AgentFirstMessage.default(""),
      /** "Remember across chats". Creates its Memory collection when on. */
      memoryEnabled: z.boolean().default(false),
      /** A chat in this workspace the caller can open ("Make this an agent"). */
      sourceSessionId: Uuid.nullable().default(null),
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
      firstMessage: AgentFirstMessage.optional(),
      memoryEnabled: z.boolean().optional(),
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
    /** Null when the agent is not available in this Slack workspace. */
    availability: AgentSlackAvailability.nullable(),
  }),
);
export type AgentSlackInstall = z.infer<typeof AgentSlackInstall>;

/** The Slack workspaces an agent can be made available in, seen from its home workspace. */
export const ListAgentSlackInstallsResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    installs: z.array(AgentSlackInstall),
    /** Slack agents need workspace routing; with it off, they do not answer. */
    routingEnabled: z.boolean(),
  }),
);
export type ListAgentSlackInstallsResponse = z.infer<typeof ListAgentSlackInstallsResponse>;

/**
 * Make the agent available in one Slack workspace, or change how. Idempotent.
 * Needs a shared (`workspace`) agent, an admin of its workspace, and a name
 * Slack can use; turning `open` on needs an organization admin.
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
  /** For now an agent is available in at most one Slack workspace. */
  "agent_slack_single_install",
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
  /** `POST /sessions`: a chat started from another chat cannot start an agent. */
  "agent_child_chat",
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];
