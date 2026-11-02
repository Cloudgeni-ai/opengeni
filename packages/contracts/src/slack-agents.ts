import { z } from "zod";
import { defineSchema } from "./define-schema";
import { SessionAvatar } from "./bots";

/**
 * Slack agents: named teammates people call through the one Opengeni Slack
 * app. Each belongs to one Slack installation and always works in one fixed
 * Opengeni workspace.
 */

export const SLACK_AGENT_NAME_MAX_LENGTH = 80;
export const SLACK_AGENT_DESCRIPTION_MAX_LENGTH = 200;
export const SLACK_AGENT_INSTRUCTIONS_MAX_LENGTH = 8_000;
/** Channels one intro post request may name. */
export const SLACK_AGENT_INTRO_CHANNELS_MAX = 20;

/**
 * Words a Slack agent cannot be called, because they already mean something
 * after `@Opengeni` or in Slack itself. Compared by name key.
 */
export const SLACK_AGENT_RESERVED_NAMES: readonly string[] = [
  "in",
  "info",
  "stop",
  "help",
  "create",
  "opengeni",
  "here",
  "channel",
  "everyone",
];

/**
 * The key two names are compared by: case, spaces and hyphens are ignored, so
 * "Data Team", "data-team" and "DATATEAM" are the same agent.
 */
export function slackAgentNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s-]+/gu, "");
}

/** How people type an agent's name after `+`, for example `+data-team`. */
export function slackAgentHandle(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "-");
}

/** Why a name cannot be used, or null when it can. */
export function slackAgentNameProblem(name: string): "empty" | "reserved" | "invalid" | null {
  const trimmed = name.trim();
  const key = slackAgentNameKey(trimmed);
  if (key.length === 0) return "empty";
  if (SLACK_AGENT_RESERVED_NAMES.includes(key)) return "reserved";
  // A name is matched at the start of a message and after `+`, so it must start
  // with a letter or digit and contain no Slack markup or punctuation that ends
  // a name when people type it.
  // It also ends with one, because a trailing "." or "'" ends a name in Slack text.
  if (!/^[\p{L}\p{N}](?:[\p{L}\p{N} \-_.']*[\p{L}\p{N}])?$/u.test(trimmed)) return "invalid";
  if ([...trimmed].length > SLACK_AGENT_NAME_MAX_LENGTH) return "invalid";
  return null;
}

const SlackAgentName = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .trim()
    .min(1)
    .max(SLACK_AGENT_NAME_MAX_LENGTH)
    .superRefine((value, context) => {
      const problem = slackAgentNameProblem(value);
      if (problem === "reserved") {
        context.addIssue({
          code: "custom",
          message: `"${value}" already means something in Slack. Choose another name.`,
        });
      } else if (problem) {
        context.addIssue({
          code: "custom",
          message: "Use letters, numbers, spaces and hyphens, starting with a letter or number.",
        });
      }
    }),
);
const SlackAgentDescription = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().min(1).max(SLACK_AGENT_DESCRIPTION_MAX_LENGTH),
);
const SlackAgentInstructions = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().max(SLACK_AGENT_INSTRUCTIONS_MAX_LENGTH),
);
export const SlackAgent = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
    slackTeamId: z.string(),
    /** The Slack workspace's name, when the reader can see it. */
    slackTeamName: z.string().nullable(),
    /** The Opengeni workspace this agent works in. Fixed at creation. */
    targetWorkspaceId: z.string().uuid(),
    targetWorkspaceName: z.string().nullable(),
    name: z.string(),
    /** What people type after `+`, for example `data-team`. */
    handle: z.string(),
    description: z.string(),
    avatar: SessionAvatar,
    /** Null for readers who cannot read the agent's workspace. */
    instructions: z.string().nullable(),
    /** The agent's Memory: a Knowledge collection in its workspace. */
    knowledgeCollectionId: z.string().uuid().nullable(),
    /** Anyone in Slack can use it, not only members of its workspace. */
    open: z.boolean(),
    version: z.number().int().positive(),
    /** Null for readers who cannot read the agent's workspace. */
    createdBySubjectId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** The reader administers the agent's workspace, so may edit or delete it. */
    viewerCanManage: z.boolean(),
    /** The workspace saves new Knowledge for review first, so Memory writes wait for review. */
    memoryReviewFirst: z.boolean(),
  }),
);
export type SlackAgent = z.infer<typeof SlackAgent>;

export const SlackAgentListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    agents: z.array(SlackAgent),
    /** Slack agents need workspace routing; with it off, they do not answer. */
    routingEnabled: z.boolean(),
    /** This workspace saves new Knowledge for review first, so a new agent's Memory writes wait for review. */
    memoryReviewFirst: z.boolean(),
  }),
);
export type SlackAgentListResponse = z.infer<typeof SlackAgentListResponse>;

/** Create an agent that works in the workspace named in the path. */
export const CreateSlackAgentRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** The Opengeni Slack installation people will call it through. */
      connectionId: z.string().uuid(),
      name: SlackAgentName,
      description: SlackAgentDescription,
      avatar: SessionAvatar,
      instructions: SlackAgentInstructions.default(""),
    })
    .strict(),
);
export type CreateSlackAgentRequest = z.input<typeof CreateSlackAgentRequest>;

export const UpdateSlackAgentRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      expectedVersion: z.number().int().positive(),
      name: SlackAgentName.optional(),
      description: SlackAgentDescription.optional(),
      avatar: SessionAvatar.optional(),
      instructions: SlackAgentInstructions.optional(),
      /**
       * Anyone in Slack can use the agent. Only an organization admin can turn
       * it on; an admin of the agent's workspace can turn it off.
       */
      open: z.boolean().optional(),
    })
    .strict(),
);
export type UpdateSlackAgentRequest = z.input<typeof UpdateSlackAgentRequest>;

/** The label of the switch that opens an agent to anyone in Slack. */
export const SLACK_AGENT_OPEN_LABEL = "Anyone in Slack can use this agent";

/** What turning an agent open means, shown with the switch. */
export function slackAgentOpenDisclosure(agentName: string, workspaceName: string): string {
  const agent = agentName.trim() || "this agent";
  const workspace = workspaceName.trim()
    ? `the ${workspaceName.trim()} workspace`
    : "its workspace";
  return `Anyone in Slack can ask ${agent}. Its answers can use anything it can read in ${workspace} (Knowledge, files, chats, shared connections). What people tell it is visible to that workspace's members.`;
}

export const SlackAgentResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ agent: SlackAgent }),
);
export type SlackAgentResponse = z.infer<typeof SlackAgentResponse>;

/** Channels an agent can be introduced in: ones the Opengeni app is already in. */
export const SlackAgentChannelListResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    channels: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          name: z.string().min(1).max(256).nullable(),
          isPrivate: z.boolean(),
        }),
      )
      .max(200),
    nextCursor: z.string().max(1_024).nullable(),
  }),
);
export type SlackAgentChannelListResponse = z.infer<typeof SlackAgentChannelListResponse>;

/** Post a short intro of the agent in the chosen channels. */
export const SlackAgentIntroRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      channelIds: z
        .array(z.string().regex(/^[CG][A-Z0-9]{1,63}$/u))
        .min(1)
        .max(SLACK_AGENT_INTRO_CHANNELS_MAX),
    })
    .strict(),
);
export type SlackAgentIntroRequest = z.infer<typeof SlackAgentIntroRequest>;

export const SlackAgentIntroResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    results: z.array(
      z.object({
        channelId: z.string(),
        /** `not_in_channel`: add the Opengeni app to the channel first. */
        status: z.enum(["posted", "not_in_channel", "failed"]),
      }),
    ),
  }),
);
export type SlackAgentIntroResponse = z.infer<typeof SlackAgentIntroResponse>;

/** The Slack agent a chat was started for, as recorded on the chat. */
export const SessionSlackAgentMetadata = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
  }),
);
export type SessionSlackAgentMetadata = z.infer<typeof SessionSlackAgentMetadata>;

/** Session metadata key holding {@link SessionSlackAgentMetadata}. */
export const SESSION_SLACK_AGENT_METADATA_KEY = "slackAgent";

/** The Slack agent recorded on a chat's metadata, or null. */
export function sessionSlackAgent(
  metadata: Record<string, unknown> | null | undefined,
): SessionSlackAgentMetadata | null {
  const parsed = SessionSlackAgentMetadata.safeParse(metadata?.[SESSION_SLACK_AGENT_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}
