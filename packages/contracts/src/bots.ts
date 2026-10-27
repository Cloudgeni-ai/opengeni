import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * Bots. A bot is an ordinary long-lived chat: its title is its name, and any
 * chat may also carry a short description and an avatar. Both are display
 * metadata for people; they never reach the model. People and the chat's own
 * agent may change them at any time.
 *
 * A bot template is where a new bot starts: a name, description and avatar,
 * plus setup instructions that become the new chat's first message. The
 * agent then sets itself up with its ordinary tools (Skills, connections,
 * schedules, machines) and the chat simply continues. A workspace keeps the
 * templates its people and agents save.
 *
 * This module must not import `./index`.
 */

export const SESSION_DESCRIPTION_MAX_LENGTH = 280;

/** Curated icon names (the web maps each to a Lucide glyph). */
export const SESSION_AVATAR_ICONS = [
  "bot",
  "bug",
  "mail",
  "git-pull-request",
  "telescope",
  "chart-line",
  "file-text",
  "shield-check",
  "wrench",
  "search",
  "calendar-clock",
  "megaphone",
  "receipt",
  "rocket",
  "database",
  "code",
  "briefcase",
  "book-open",
  "flask-conical",
  "globe",
  "headset",
  "pen-tool",
  "users",
  "sparkles",
] as const;
export const SessionAvatarIcon = /* @__PURE__ */ defineSchema(() => z.enum(SESSION_AVATAR_ICONS));
export type SessionAvatarIcon = z.infer<typeof SessionAvatarIcon>;

const SESSION_AVATAR_EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** True when `value` is exactly one user-perceived character that is an emoji. */
export function isSingleSessionAvatarEmoji(value: string): boolean {
  if (!SESSION_AVATAR_EMOJI_PATTERN.test(value)) return false;
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  if (!segmenter) return [...value].length <= 8;
  let count = 0;
  for (const _segment of segmenter.segment(value)) {
    count += 1;
    if (count > 1) return false;
  }
  return count === 1;
}

/** Hue (0-359) of the avatar tile's background. */
export const SessionAvatarHue = /* @__PURE__ */ defineSchema(() =>
  z.number().int().min(0).max(359),
);

/**
 * What a chat looks like in lists and its header. `image` names an image file
 * in the workspace (for example one the agent generated); each viewer opens it
 * with their own access, and anyone who cannot sees the chat's initials.
 */
export const SessionAvatar = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("emoji"),
        emoji: z.string().min(1).max(32).refine(isSingleSessionAvatarEmoji, {
          message: "emoji must be a single emoji",
        }),
        hue: SessionAvatarHue,
      })
      .strict(),
    z
      .object({
        kind: z.literal("icon"),
        icon: SessionAvatarIcon,
        hue: SessionAvatarHue,
      })
      .strict(),
    z
      .object({
        kind: z.literal("letters"),
        letters: z.string().regex(/^[\p{L}\p{N}]{1,2}$/u, {
          message: "letters must be one or two letters or digits",
        }),
        hue: SessionAvatarHue,
      })
      .strict(),
    z.object({ kind: z.literal("image"), artifactId: z.string().uuid() }).strict(),
  ]),
);
export type SessionAvatar = z.infer<typeof SessionAvatar>;

/** An avatar a file can carry to another workspace: anything but an image. */
export const PortableSessionAvatar = /* @__PURE__ */ defineSchema(() =>
  SessionAvatar.refine((avatar) => avatar.kind !== "image", {
    message: "an image avatar stays in its workspace",
  }),
);

/** Stored descriptions are trimmed; an empty one is no description. */
export const SessionDescription = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .trim()
    .max(SESSION_DESCRIPTION_MAX_LENGTH)
    .transform((value) => (value.length > 0 ? value : null)),
);

// --- Bot templates --------------------------------------------------------

export const BOT_TEMPLATE_NAME_MAX_LENGTH = 120;
export const BOT_TEMPLATE_SETUP_INSTRUCTIONS_MAX_LENGTH = 20_000;
/** Saved templates a workspace keeps; saving another past this is refused. */
export const BOT_TEMPLATES_PER_WORKSPACE_MAX = 200;

const Uuid = /* @__PURE__ */ defineSchema(() => z.string().uuid());
const BotTemplateName = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().min(1).max(BOT_TEMPLATE_NAME_MAX_LENGTH),
);
const BotTemplateDescription = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().max(SESSION_DESCRIPTION_MAX_LENGTH),
);
/** The new chat's first message: what the agent does to set itself up. */
const BotTemplateSetupInstructions = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().min(1).max(BOT_TEMPLATE_SETUP_INSTRUCTIONS_MAX_LENGTH),
);

/** A template saved in a workspace. */
export const WorkspaceBotTemplate = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: Uuid,
    workspaceId: Uuid,
    name: z.string(),
    description: z.string(),
    avatar: SessionAvatar.nullable(),
    setupInstructions: z.string(),
    /** The chat it was saved from, when it was saved from one. */
    sourceSessionId: Uuid.nullable(),
    /** Who saved it; null when a workspace-level caller did. */
    createdBySubjectId: z.string().nullable(),
    /** `manage`: the reader may rename, change or delete it. */
    viewerAccess: z.enum(["manage", "use"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type WorkspaceBotTemplate = z.output<typeof WorkspaceBotTemplate>;

export const CreateBotTemplateRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: BotTemplateName,
      description: BotTemplateDescription.default(""),
      avatar: SessionAvatar.nullable().default(null),
      setupInstructions: BotTemplateSetupInstructions,
      sourceSessionId: Uuid.nullable().default(null),
    })
    .strict(),
);
export type CreateBotTemplateRequest = z.input<typeof CreateBotTemplateRequest>;
export type ParsedCreateBotTemplateRequest = z.output<typeof CreateBotTemplateRequest>;

/** Changes only what it names. */
export const UpdateBotTemplateRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      name: BotTemplateName.optional(),
      description: BotTemplateDescription.optional(),
      avatar: SessionAvatar.nullable().optional(),
      setupInstructions: BotTemplateSetupInstructions.optional(),
    })
    .strict(),
);
export type UpdateBotTemplateRequest = z.input<typeof UpdateBotTemplateRequest>;
export type ParsedUpdateBotTemplateRequest = z.output<typeof UpdateBotTemplateRequest>;

export const ListBotTemplatesResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ templates: z.array(WorkspaceBotTemplate) }),
);
export type ListBotTemplatesResponse = z.output<typeof ListBotTemplatesResponse>;

export const BotTemplateResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ template: WorkspaceBotTemplate }),
);
export type BotTemplateResponse = z.output<typeof BotTemplateResponse>;

// --- Bot suggestions ------------------------------------------------------

/** The longest setup-instructions draft a suggestion carries (a template may hold more). */
export const BOT_SUGGESTION_SETUP_INSTRUCTIONS_MAX_LENGTH = 8_000;
export const BOT_SUGGESTION_REASON_MAX_LENGTH = 400;

/**
 * The newest bot suggestion the agent made in a chat with `bot_suggest`,
 * shown to people as a card. `create`: make this chat a bot (and, if they
 * like, save it as a template). `reuse`: a bot chat (`sessionId`) or bot
 * template (`templateId`) that already does this work. Display state only:
 * it never changes a chat or saves a template by itself.
 */
export const SessionBotSuggestion = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: Uuid,
      kind: z.enum(["create", "reuse"]),
      sessionId: Uuid.nullable(),
      templateId: Uuid.nullable(),
      name: z.string().min(1).max(BOT_TEMPLATE_NAME_MAX_LENGTH),
      description: z.string().max(SESSION_DESCRIPTION_MAX_LENGTH).nullable(),
      avatar: SessionAvatar.nullable(),
      setupInstructions: z.string().max(BOT_SUGGESTION_SETUP_INSTRUCTIONS_MAX_LENGTH).nullable(),
      reason: z.string().max(BOT_SUGGESTION_REASON_MAX_LENGTH).nullable(),
      createdAt: z.string(),
    })
    .strict(),
);
export type SessionBotSuggestion = z.output<typeof SessionBotSuggestion>;

export const BOT_TEMPLATE_FILE_FORMAT = "opengeni.bot-template";

/**
 * A template as a file, to share outside its workspace. It carries no ids,
 * owner or image: importing it saves a new template in the importer's
 * workspace, and an image avatar becomes the name's initials.
 */
export const BotTemplateFile = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      format: z.literal(BOT_TEMPLATE_FILE_FORMAT),
      version: z.literal(1),
      name: BotTemplateName,
      description: BotTemplateDescription.default(""),
      avatar: PortableSessionAvatar.nullable().default(null),
      setupInstructions: BotTemplateSetupInstructions,
    })
    .strict(),
);
export type BotTemplateFile = z.input<typeof BotTemplateFile>;

/** The file for a template; an image avatar is dropped (see {@link BotTemplateFile}). */
export function botTemplateFile(
  template: Pick<WorkspaceBotTemplate, "name" | "description" | "avatar" | "setupInstructions">,
): z.output<typeof BotTemplateFile> {
  return {
    format: BOT_TEMPLATE_FILE_FORMAT,
    version: 1,
    name: template.name,
    description: template.description,
    avatar: template.avatar && template.avatar.kind !== "image" ? template.avatar : null,
    setupInstructions: template.setupInstructions,
  };
}
