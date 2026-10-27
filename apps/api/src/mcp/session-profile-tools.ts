import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BOT_SUGGESTION_REASON_MAX_LENGTH,
  BOT_SUGGESTION_SETUP_INSTRUCTIONS_MAX_LENGTH,
  BOT_TEMPLATE_NAME_MAX_LENGTH,
  BOT_TEMPLATE_SETUP_INSTRUCTIONS_MAX_LENGTH,
  CreateBotTemplateRequest,
  type SessionBotSuggestion,
  SESSION_AVATAR_ICONS,
  SESSION_DESCRIPTION_MAX_LENGTH,
  SessionAvatar,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  botTemplateViewerForGrant,
  createBotTemplateForViewer,
  updateSessionProfile,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getBotTemplate,
  getSessionForSubject,
  listBotTemplates,
  listWorkspaceBotSessions,
  setSessionBotSuggestion,
  storedSessionAvatar,
} from "@opengeni/db";
import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import * as z4 from "zod/v4";
import { requireUsableSessionAvatar } from "../routes/session-avatar";

/**
 * The bot half of the title tools and `bot_template_save`. A chat's
 * description and avatar are display metadata: the agent may set them, but
 * they never enter its context. See packages/contracts/src/bots.ts.
 */

export const SESSION_PROFILE_TOOL_GUIDANCE =
  'When a person or a bot template chose the name (a bot\'s name), keep it unless the person asks for a new one. Every field is optional. description and avatar are shown to people next to the name and are not added to your context; set them when the person asks you to change your name or look, or when setup instructions say so. description: one line about what the chat does (an empty string clears it). avatar: null clears it; otherwise {kind:"emoji",emoji,hue}, {kind:"icon",icon,hue}, {kind:"letters",letters,hue} (one or two letters or digits), with hue 0-359, or {kind:"image",artifactId} for an image file, such as one you generated. If other people can open this chat, publish the image so they can open it too first.';

const AvatarInput = z4
  .object({
    kind: z4.enum(["emoji", "icon", "letters", "image"]),
    emoji: z4.string().min(1).max(32).optional(),
    icon: z4.enum(SESSION_AVATAR_ICONS).optional(),
    letters: z4.string().min(1).max(2).optional(),
    hue: z4.number().int().min(0).max(359).optional(),
    artifactId: z4.string().uuid().optional(),
  })
  .nullable()
  .optional();

export const sessionProfileToolInputShape = {
  description: z4.string().max(SESSION_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  avatar: AvatarInput,
};

type AvatarInputValue = z4.infer<typeof AvatarInput>;

/** The tool's flat avatar object as the contract's exact avatar, or a clear refusal. */
function avatarFromToolInput(avatar: AvatarInputValue): SessionAvatar | null | undefined {
  if (avatar === undefined || avatar === null) return avatar;
  const parsed = SessionAvatar.safeParse(
    Object.fromEntries(Object.entries(avatar).filter(([, value]) => value !== undefined)),
  );
  if (!parsed.success) {
    throw new HTTPException(422, {
      message: `Invalid avatar: ${parsed.error.issues.map((issue) => issue.message).join("; ")}. Give exactly the fields its kind needs.`,
    });
  }
  return parsed.data;
}

export async function setSessionProfileFromTool(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  input: {
    title?: string | undefined;
    description?: string | null | undefined;
    avatar?: AvatarInputValue;
  },
) {
  if (input.title === undefined && input.description === undefined && input.avatar === undefined) {
    throw new HTTPException(422, { message: "Name a title, description or avatar to change." });
  }
  const avatar = avatarFromToolInput(input.avatar);
  await requireUsableSessionAvatar(deps, grant, avatar, { sessionId });
  const description =
    input.description === undefined
      ? undefined
      : input.description === null || input.description.trim() === ""
        ? null
        : input.description.trim();
  const result = await updateSessionProfile(
    deps,
    grant,
    sessionId,
    {
      title: input.title,
      description,
      avatar,
    },
    "agent",
  );
  return {
    ok: true as const,
    updated: result.titleUpdated || result.profileUpdated,
    title: result.title ?? input.title ?? null,
    description: result.description,
    avatar: result.avatar,
  };
}

export function registerBotTemplateTools(input: {
  server: McpServer;
  deps: ApiRouteDeps;
  grant: AccessGrant;
  sessionId: string;
  authorize: () => Promise<void>;
  json: (value: unknown) => { content: Array<{ type: "text"; text: string }> };
}): void {
  const { server, deps, grant, sessionId } = input;
  server.registerTool(
    "bot_template_save",
    {
      description:
        "Save a bot template that people can start new bots from, usually when the person asks you to make a template of yourself or this chat. A template is a name, a one-line description, an optional avatar and setup instructions, which become the first message of every new chat started from it. Write the setup instructions to that new agent from what this chat has established: its job, the Skills to install, the connections and machines it needs, the schedules and event triggers to create, and the standing rules and preferences it was given. Leave out one-off tasks, history, personal details and secrets. When setup differs per person, tell the new agent to ask how they work today and set up what fits; when it is simple, name exactly what to install and create so the agent can set itself up without asking. Show the person your draft first unless they asked you to save it directly. avatar takes the same shapes as in set_session_title.",
      inputSchema: {
        name: z4.string().min(1).max(BOT_TEMPLATE_NAME_MAX_LENGTH),
        description: z4.string().max(SESSION_DESCRIPTION_MAX_LENGTH).optional(),
        avatar: AvatarInput,
        setupInstructions: z4.string().min(1).max(BOT_TEMPLATE_SETUP_INSTRUCTIONS_MAX_LENGTH),
      },
    },
    async ({ name, description, avatar, setupInstructions }) => {
      await input.authorize();
      const exactAvatar = avatarFromToolInput(avatar) ?? null;
      await requireUsableSessionAvatar(deps, grant, exactAvatar, { sharedWithWorkspace: true });
      const request = CreateBotTemplateRequest.parse({
        name,
        description: description ?? "",
        avatar: exactAvatar,
        setupInstructions,
        sourceSessionId: sessionId,
      });
      const template = await createBotTemplateForViewer({
        db: deps.db,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        viewer: await botTemplateViewerForGrant(deps.db, grant),
        request,
      });
      return input.json({ ok: true, template });
    },
  );
  registerBotSuggestTool(input);
}

/** The receipt a chat shows as a bot suggestion card. */
export const BOT_SUGGESTION_RECEIPT_TYPE = "bot_suggestion";

function sameName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

/**
 * `bot_suggest`: when a chat keeps doing the same kind of work, the agent may
 * offer to make it a bot (choosing the name, description and avatar itself,
 * and drafting setup instructions for a template), or point to a bot chat or
 * bot template that already does this work. Nothing changes here: the
 * suggestion is recorded on the chat as display state and shown to people as
 * a card; only a person's own action renames the chat or saves a template.
 */
function registerBotSuggestTool(input: {
  server: McpServer;
  deps: ApiRouteDeps;
  grant: AccessGrant;
  sessionId: string;
  authorize: () => Promise<void>;
  json: (value: unknown) => { content: Array<{ type: "text"; text: string }> };
}): void {
  const { server, deps, grant, sessionId } = input;
  server.registerTool(
    "bot_suggest",
    {
      description:
        "Suggest a bot to the person, shown as a card in their chat. Use it at most once per chat, when the person has asked for the same kind of work several times here or says they will want it again, and only if this chat is not already a bot. " +
        "kind=reuse points to a bot that already does this work: a bot chat (sessionId) or a bot template (templateId); prefer it when one fits (a kind=create whose name is taken returns the existing bots and templates). " +
        "kind=create offers to make this chat a bot: choose a short name (a first name or a role, e.g. 'Invoice checker'), a one-line description, an avatar, and draft setup instructions for a template a new bot could start from (what this chat has established: its job, Skills, connections, schedules and standing rules; no one-off tasks or secrets). " +
        "Nothing changes until the person acts on the card. Do not mention the card in your reply, and do not suggest again in this chat after the person dismisses it. avatar takes the same shapes as in set_session_title.",
      inputSchema: {
        kind: z4.enum(["create", "reuse"]),
        name: z4.string().min(1).max(BOT_TEMPLATE_NAME_MAX_LENGTH).optional(),
        description: z4.string().max(SESSION_DESCRIPTION_MAX_LENGTH).optional(),
        avatar: AvatarInput,
        setupInstructions: z4
          .string()
          .max(BOT_SUGGESTION_SETUP_INSTRUCTIONS_MAX_LENGTH)
          .optional()
          .describe("kind=create: draft setup instructions for a template."),
        sessionId: z4.string().uuid().optional().describe("kind=reuse: the bot chat."),
        templateId: z4.string().uuid().optional().describe("kind=reuse: the bot template."),
        reason: z4
          .string()
          .min(1)
          .max(BOT_SUGGESTION_REASON_MAX_LENGTH)
          .describe("One sentence the person sees: why a bot fits this work."),
      },
    },
    async (request) => {
      await input.authorize();
      const notSuggested = (code: string, message: string, extra: Record<string, unknown> = {}) =>
        input.json({ status: "not_suggested", code, message, ...extra });
      const current = await getSessionForSubject(
        deps.db,
        grant.workspaceId,
        sessionId,
        grant.subjectId,
      );
      if (!current) throw new HTTPException(404, { message: "session not found" });
      let suggestion: SessionBotSuggestion;
      if (request.kind === "reuse") {
        if (Boolean(request.sessionId) === Boolean(request.templateId)) {
          return notSuggested(
            "invalid_target",
            "kind=reuse needs exactly one of sessionId (a bot chat) or templateId (a bot template).",
          );
        }
        if (request.sessionId) {
          if (request.sessionId === sessionId) {
            return notSuggested("already_here", "That bot is this chat.");
          }
          const bot = await getSessionForSubject(
            deps.db,
            grant.workspaceId,
            request.sessionId,
            grant.subjectId,
          );
          if (!bot || !bot.title || (!bot.avatar && !bot.description)) {
            return notSuggested("not_a_bot", "That chat is not a bot this person can open.");
          }
          suggestion = {
            id: randomUUID(),
            kind: "reuse",
            sessionId: bot.id,
            templateId: null,
            name: bot.title.slice(0, BOT_TEMPLATE_NAME_MAX_LENGTH),
            description: bot.description,
            avatar: bot.avatar,
            setupInstructions: null,
            reason: request.reason,
            createdAt: new Date().toISOString(),
          };
        } else {
          const template = await getBotTemplate(deps.db, grant.workspaceId, request.templateId!);
          if (!template) return notSuggested("not_found", "That bot template does not exist.");
          suggestion = {
            id: randomUUID(),
            kind: "reuse",
            sessionId: null,
            templateId: template.id,
            name: template.name,
            description: template.description || null,
            avatar: storedSessionAvatar(template.avatar),
            setupInstructions: null,
            reason: request.reason,
            createdAt: new Date().toISOString(),
          };
        }
      } else {
        if (current.avatar || current.description) {
          return notSuggested(
            "already_a_bot",
            "This chat is already a bot. To share it, offer to save it as a template (bot_template_save) when the person asks.",
          );
        }
        const name = request.name?.trim();
        if (!name) return notSuggested("name_required", "kind=create needs a name.");
        const [bots, templates] = await Promise.all([
          listWorkspaceBotSessions(deps.db, {
            workspaceId: grant.workspaceId,
            subjectId: grant.subjectId,
            limit: 50,
          }),
          listBotTemplates(deps.db, grant.workspaceId),
        ]);
        if (
          bots.some((bot) => sameName(bot.title, name)) ||
          templates.some((template) => sameName(template.name, name))
        ) {
          return notSuggested(
            "name_taken",
            "A bot or bot template already has this name. Suggest reusing it (kind=reuse) if it does this work, or choose another name.",
            {
              bots: bots.slice(0, 20).map((bot) => ({
                sessionId: bot.id,
                name: bot.title,
                description: bot.description,
              })),
              templates: templates.slice(0, 20).map((template) => ({
                templateId: template.id,
                name: template.name,
                description: template.description,
              })),
            },
          );
        }
        const avatar = avatarFromToolInput(request.avatar) ?? null;
        await requireUsableSessionAvatar(deps, grant, avatar, { sessionId });
        const description = request.description?.trim() || null;
        suggestion = {
          id: randomUUID(),
          kind: "create",
          sessionId: null,
          templateId: null,
          name,
          description,
          avatar,
          setupInstructions: request.setupInstructions?.trim() || null,
          reason: request.reason,
          createdAt: new Date().toISOString(),
        };
      }
      await setSessionBotSuggestion(deps.db, {
        workspaceId: grant.workspaceId,
        sessionId,
        suggestion,
      });
      return input.json({
        type: BOT_SUGGESTION_RECEIPT_TYPE,
        status: "suggested",
        ...suggestion,
        note: "The person sees this as a card in the chat and decides. Nothing has changed yet.",
      });
    },
  );
}
