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

/**
 * Words people start ordinary sentences with. A bare name routes a message
 * that starts with it, so an agent called one of these would catch messages
 * meant for Opengeni. Compared by name key.
 */
export const SLACK_AGENT_SENTENCE_STARTERS: readonly string[] = [
  "a",
  "an",
  "and",
  "any",
  "anyone",
  "are",
  "but",
  "can",
  "could",
  "did",
  "do",
  "does",
  "fyi",
  "hello",
  "hey",
  "hi",
  "how",
  "i",
  "im",
  "is",
  "it",
  "just",
  "no",
  "ok",
  "okay",
  "please",
  "pls",
  "should",
  "so",
  "test",
  "testing",
  "thank",
  "thanks",
  "thankyou",
  "thx",
  "that",
  "the",
  "this",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "would",
  "yes",
  "yo",
  "you",
];

export type SlackAgentNameProblem =
  | "empty"
  | "reserved"
  | "invalid"
  /** Fewer than two letters, including names with no letters at all. */
  | "too_short"
  /** A word people start ordinary sentences with, such as "Hi" or "Test". */
  | "sentence_starter";

/**
 * Why a name cannot be used for a new or renamed agent, or null when it can.
 * An existing agent keeps its name: callers check only a name that changed.
 */
export function slackAgentNameProblem(name: string): SlackAgentNameProblem | null {
  const problem = slackAgentNameFormatProblem(name);
  if (problem) return problem;
  const trimmed = name.trim();
  if ((trimmed.match(/\p{L}/gu)?.length ?? 0) < 2) return "too_short";
  if (SLACK_AGENT_SENTENCE_STARTERS.includes(slackAgentNameKey(trimmed))) {
    return "sentence_starter";
  }
  return null;
}

/**
 * The rules every stored name already meets: not empty, not reserved, and
 * made of characters a name can be typed with. Saving an agent whose name did
 * not change checks only these.
 */
export function slackAgentNameFormatProblem(name: string): "empty" | "reserved" | "invalid" | null {
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

/** What a name problem means, in the words the form and the API both use. */
export function slackAgentNameProblemText(name: string, problem: SlackAgentNameProblem): string {
  const shown = name.trim();
  switch (problem) {
    case "empty":
      return "Give it a name.";
    case "reserved":
      return `"${shown}" already means something in Slack. Choose another name.`;
    case "invalid":
      return "Use letters, numbers, spaces and hyphens, starting with a letter or number.";
    case "too_short":
      return "Use at least two letters.";
    case "sentence_starter":
      return `Messages starting with "${shown}" would go to this agent. Choose another name.`;
  }
}

/**
 * A warning, not an error: a one-word name catches every message that starts
 * with that word after `@Opengeni`. Null for longer names.
 */
export function slackAgentNameWarning(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/gu, " ");
  if (slackAgentNameFormatProblem(trimmed) || trimmed.split(/[\s-]+/u).length > 1) return null;
  const example = /team$/iu.test(trimmed) ? `${trimmed} desk` : `${trimmed} team`;
  return `Messages starting with "${trimmed} …" go to this agent. Two words, like "${example}", are safer.`;
}

/** How Slack shows a mention of the Opengeni app when its user id is unknown. */
export const SLACK_OPENGENI_MENTION = "@Opengeni";

/**
 * How people ask an agent in Slack: `@Opengeni Data team`, with the name as
 * the admin wrote it. Pass the app's real mention (`<@U123>`) for Slack
 * messages. `+name` still works, but is never shown.
 */
export function slackAgentCallText(name: string, mention: string = SLACK_OPENGENI_MENTION): string {
  return `${mention} ${name.trim().replace(/\s+/gu, " ")}`;
}

/**
 * A description as one sentence: trimmed, capitalized and ending in a full
 * stop unless it already ends a sentence. Admins write verb phrases such as
 * "answers questions about metrics", so they read well after another sentence.
 */
export function slackAgentDescriptionSentence(description: string): string {
  const text = description.replace(/\s+/gu, " ").trim();
  if (text.length === 0) return "";
  const [first = "", ...rest] = [...text];
  const capitalized = `${first.toLocaleUpperCase()}${rest.join("")}`;
  return /[.!?…]["'”’)\]]*$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}

/** A piece of a Slack message line, rendered as mrkdwn by the API and as text by the preview. */
export type SlackAgentMessageSegment =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  /** A mention of the Opengeni app. */
  | { kind: "opengeni" }
  /** A mention of a person, by Slack user id; the name is for previews. */
  | { kind: "person"; slackUserId: string | null; name: string };

export type SlackAgentMessageLine = {
  italic?: boolean;
  segments: SlackAgentMessageSegment[];
};

/**
 * The intro an agent posts, under its own name, in channels an admin picks:
 *
 * > Hi, I'm *Data team*, an Opengeni agent. Answers questions about metrics.
 * > Ask me in any channel: @Opengeni Data team, then your question.
 * > _Added by @Bendik_
 *
 * The same lines feed the post and the form's preview.
 */
export function slackAgentIntroLines(input: {
  name: string;
  description: string;
  /** Who posts it. Omitted when their Slack account is unknown. */
  addedBy?: { slackUserId: string | null; name: string } | null;
}): SlackAgentMessageLine[] {
  const name = input.name.trim().replace(/\s+/gu, " ");
  const description = slackAgentDescriptionSentence(input.description);
  const lines: SlackAgentMessageLine[] = [
    {
      segments: [
        { kind: "text", text: "Hi, I'm " },
        { kind: "bold", text: name },
        { kind: "text", text: `, an Opengeni agent.${description ? ` ${description}` : ""}` },
      ],
    },
    {
      segments: [
        { kind: "text", text: "Ask me in any channel: " },
        { kind: "opengeni" },
        { kind: "text", text: ` ${name}, then your question.` },
      ],
    },
  ];
  if (input.addedBy) {
    lines.push({
      italic: true,
      segments: [
        { kind: "text", text: "Added by " },
        { kind: "person", slackUserId: input.addedBy.slackUserId, name: input.addedBy.name },
      ],
    });
  }
  return lines;
}

/** Slack's three escaped characters in message text. */
export function escapeSlackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const SLACK_USER_ID = /^[UWB][A-Z0-9]{1,63}$/u;

/** Message lines as Slack mrkdwn, with real mentions where the ids are known. */
export function slackAgentMessageMrkdwn(
  lines: readonly SlackAgentMessageLine[],
  options: { botUserId: string | null },
): string {
  return lines
    .map((line) => {
      const text = line.segments
        .map((segment) => {
          switch (segment.kind) {
            case "text":
              return escapeSlackText(segment.text);
            case "bold":
              return `*${escapeSlackText(segment.text)}*`;
            case "opengeni":
              return options.botUserId && SLACK_USER_ID.test(options.botUserId)
                ? `<@${options.botUserId}>`
                : SLACK_OPENGENI_MENTION;
            case "person":
              return segment.slackUserId && SLACK_USER_ID.test(segment.slackUserId)
                ? `<@${segment.slackUserId}>`
                : `@${escapeSlackText(segment.name)}`;
          }
        })
        .join("");
      return line.italic ? `_${text}_` : text;
    })
    .join("\n");
}

/** Message lines as plain text, for notifications and previews. */
export function slackAgentMessagePlainText(lines: readonly SlackAgentMessageLine[]): string {
  return lines
    .map((line) =>
      line.segments
        .map((segment) => {
          switch (segment.kind) {
            case "text":
            case "bold":
              return segment.text;
            case "opengeni":
              return SLACK_OPENGENI_MENTION;
            case "person":
              return `@${segment.name}`;
          }
        })
        .join(""),
    )
    .join("\n");
}

function slackAgentNameSchema(check: (name: string) => SlackAgentNameProblem | null) {
  return z
    .string()
    .trim()
    .min(1)
    .max(SLACK_AGENT_NAME_MAX_LENGTH)
    .superRefine((value, context) => {
      const problem = check(value);
      if (problem) {
        context.addIssue({ code: "custom", message: slackAgentNameProblemText(value, problem) });
      }
    });
}
/** A new agent's name: every rule. */
const SlackAgentName = /* @__PURE__ */ defineSchema(() =>
  slackAgentNameSchema(slackAgentNameProblem),
);
/**
 * A name in an edit. Only the format rules here, so an agent whose name
 * predates the stricter rules can still be saved; the API checks every rule
 * when the name actually changes.
 */
const SlackAgentNameEdit = /* @__PURE__ */ defineSchema(() =>
  slackAgentNameSchema(slackAgentNameFormatProblem),
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
    /**
     * What people may type after `+`, for example `data-team`. Still accepted,
     * but people are shown {@link slackAgentCallText} instead.
     */
    handle: z.string(),
    description: z.string(),
    avatar: SessionAvatar,
    /** Null for readers who cannot read the agent's workspace. */
    instructions: z.string().nullable(),
    /** The agent's Memory: a Knowledge collection in its workspace. */
    knowledgeCollectionId: z.string().uuid().nullable(),
    /** Linked members of the organization can use it in Slack, not only members of its workspace. */
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
      name: SlackAgentNameEdit.optional(),
      description: SlackAgentDescription.optional(),
      avatar: SessionAvatar.optional(),
      instructions: SlackAgentInstructions.optional(),
      /**
       * Linked members of the organization can use the agent in Slack, even
       * without access to its workspace. Only an organization admin can turn
       * it on; an admin of the agent's workspace can turn it off.
       */
      open: z.boolean().optional(),
    })
    .strict(),
);
export type UpdateSlackAgentRequest = z.input<typeof UpdateSlackAgentRequest>;

/** The label of the switch that opens an agent to the organization's people in Slack. */
export const SLACK_AGENT_OPEN_LABEL = "Organization members can use this agent in Slack";

/** What turning an agent open means, shown with the switch. */
export function slackAgentOpenDisclosure(agentName: string, workspaceName: string): string {
  const agent = agentName.trim() || "this agent";
  const workspace = workspaceName.trim()
    ? `the ${workspaceName.trim()} workspace`
    : "its workspace";
  return `People in your organization can ask ${agent} after linking their Slack account, even without access to ${workspace}. Its answers can use anything it can read there (Knowledge, files, chats, shared connections). What people tell it is visible to that workspace's members.`;
}

/**
 * Shown with the switch of an agent that is open now: open use used to take
 * anyone in the Slack workspace.
 */
export const SLACK_AGENT_OPEN_NARROWED_NOTICE =
  "Changed: only organization members who linked their Slack account can use it now. Everyone else is asked to link or told why not.";

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
          /** This agent's intro was already posted here. */
          introduced: z.boolean().default(false),
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
        /**
         * `not_in_channel`: add the Opengeni app to the channel first.
         * `restricted`: Slack lets only some people post there (for example
         * admins in an announcement channel), so retrying won't help.
         */
        status: z.enum(["posted", "not_in_channel", "restricted", "failed"]),
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
