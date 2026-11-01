import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BOT_SUGGESTION_MIN_SIMILAR_REQUESTS,
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
  countSessionHumanRequests,
  getSessionForSubject,
  getSessionVisibility,
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
  'When a person or a bot template chose the name (a bot\'s name), keep it unless the person asks for a new one. Every field is optional. description and avatar are shown to people next to the name and are not added to your context; set them when the person asks you to change your name or look, or when setup instructions say so. description: one line about what the chat does (an empty string clears it). avatar: null clears it; otherwise {kind:"emoji",emoji,hue}, {kind:"icon",icon,hue}, {kind:"letters",letters,hue} (one or two letters or digits), with hue 0-359, or {kind:"image",artifactId} for an image file, such as one you generated. Avatars are usually shown at about 16 pixels, so make an image a flat icon filling the whole square: one bold symbol for the chat\'s job on a solid, strong colour unlike other bots\' avatars, with no frame, faces, fine detail or text. If other people can open this chat, publish the image so they can open it too first.';

export const AvatarInput = z4
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

/** A project's avatar: the same shapes as a chat's. */
export const PROJECT_AVATAR_TOOL_GUIDANCE =
  'avatar is shown to people instead of the project\'s folder icon and is not added to your context: null clears it; otherwise {kind:"emoji",emoji,hue}, {kind:"icon",icon,hue}, {kind:"letters",letters,hue} (one or two letters or digits), with hue 0-359, or {kind:"image",artifactId} for an image file shared with the workspace, since everyone in the workspace sees the project.';

/**
 * A project avatar from the tool's flat input, checked like a chat's in a
 * shared chat: projects are visible to the whole workspace.
 */
export async function projectAvatarFromToolInput(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  avatar: AvatarInputValue,
): Promise<SessionAvatar | null | undefined> {
  const exact = avatarFromToolInput(avatar);
  await requireUsableSessionAvatar(deps, grant, exact, { sharedWithWorkspace: true });
  return exact;
}

type AvatarInputValue = z4.infer<typeof AvatarInput>;

/** The tool's flat avatar object as the contract's exact avatar, or a clear refusal. */
export function avatarFromToolInput(avatar: AvatarInputValue): SessionAvatar | null | undefined {
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
        "Save a bot template that people can start new bots from, usually when the person asks you to make a template of yourself or this chat. A template is a name, a one-line description, an optional avatar and setup instructions, which become the first message of every new chat started from it. Write the setup instructions to that new agent from what this chat has established: its job, the Skills and plugins to install, the connections and machines it needs, the schedules and event triggers to create, and the standing rules and preferences it was given. Leave out one-off tasks, history, personal details and secrets. When setup differs per person, tell the new agent to ask how they work today and set up what fits; when it is simple, name exactly what to install and create so the agent can set itself up without asking. Show the person your draft first unless they asked you to save it directly. The template is shared like this chat: from an Only me chat only the person sees it until they share it from Bot templates; otherwise everyone in the workspace can start bots from it. avatar takes the same shapes as in set_session_title.",
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
      // A template is shared like the chat it was saved from, so what an Only
      // me chat writes into one is never shown to the workspace by the agent.
      const visibility =
        (await getSessionVisibility(deps.db, grant.workspaceId, sessionId)) === "user_private"
          ? "private"
          : "workspace";
      await requireUsableSessionAvatar(deps, grant, exactAvatar, {
        sharedWithWorkspace: visibility === "workspace",
      });
      const request = CreateBotTemplateRequest.parse({
        name,
        description: description ?? "",
        avatar: exactAvatar,
        setupInstructions,
        visibility,
        sourceSessionId: sessionId,
      });
      const viewer = await botTemplateViewerForGrant(deps.db, grant);
      if (visibility === "private" && viewer.subjectId === null) {
        throw new HTTPException(422, {
          message:
            "This chat is Only me and no person is behind this run, so its template would belong to nobody. Ask the person to save it from Bot templates.",
        });
      }
      const template = await createBotTemplateForViewer({
        db: deps.db,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        viewer,
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
        "Offer the person a bot, shown as a card under this conversation. Use it at most once here, only when most of their requests are the same kind of work, including the last three or more in a row, and only if this is not already a bot. Do not use it for a one-off task or because they might want something again. " +
        "kind=reuse names a bot that already does this work: sessionId for a running bot, or templateId for a bot template; prefer it when one fits (a kind=create whose name is taken returns the existing ones). " +
        "kind=create offers to make this conversation a bot: choose a short name (a first name or a role, e.g. 'Invoice checker'), a one-line description, an avatar, and draft setup instructions for a template a new bot could start from (its job, Skills, connections, schedules and standing rules; no one-off tasks or secrets). " +
        "Nothing changes until the person acts on the card. Do not mention the card in your reply. avatar takes the same shapes as in set_session_title.",
      inputSchema: {
        kind: z4.enum(["create", "reuse"]),
        similarRequestsInARow: z4
          .number()
          .int()
          .min(1)
          .describe(
            "How many of the person's latest requests in a row are the same kind of work. Count honestly: fewer than three is declined.",
          ),
        name: z4.string().min(1).max(BOT_TEMPLATE_NAME_MAX_LENGTH).optional(),
        description: z4.string().max(SESSION_DESCRIPTION_MAX_LENGTH).optional(),
        avatar: AvatarInput,
        setupInstructions: z4
          .string()
          .max(BOT_SUGGESTION_SETUP_INSTRUCTIONS_MAX_LENGTH)
          .optional()
          .describe("kind=create: draft setup instructions for a template."),
        sessionId: z4.string().uuid().optional().describe("kind=reuse: the running bot."),
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
      // Once per chat, so a card someone dismissed never comes back.
      if (current.botSuggestion) {
        return notSuggested("already_suggested", "This chat already offered a bot.");
      }
      // The agent judges similarity; people's real requests set the floor.
      const humanRequests = await countSessionHumanRequests(deps.db, {
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        sessionId,
      });
      if (
        Math.min(request.similarRequestsInARow, humanRequests) < BOT_SUGGESTION_MIN_SIMILAR_REQUESTS
      ) {
        return notSuggested(
          "too_few_similar_requests",
          `A bot is for work that keeps coming back: wait until at least ${BOT_SUGGESTION_MIN_SIMILAR_REQUESTS} requests in a row are the same kind of work.`,
        );
      }
      const viewer = await botTemplateViewerForGrant(deps.db, grant);
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
          // Only templates this person can see: never someone else's Only me one.
          const templates = await listBotTemplates(deps.db, grant.workspaceId, viewer.subjectId);
          const template = templates.find((entry) => entry.id === request.templateId);
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
          listBotTemplates(deps.db, grant.workspaceId, viewer.subjectId),
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
