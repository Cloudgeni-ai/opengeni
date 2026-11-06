import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BOT_TEMPLATE_NAME_MAX_LENGTH,
  BOT_TEMPLATE_SETUP_INSTRUCTIONS_MAX_LENGTH,
  CreateBotTemplateRequest,
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
import { getSessionVisibility } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import * as z4 from "zod/v4";
import { requireUsableSessionAvatar } from "../routes/session-avatar";

/**
 * The bot half of the title tools and `bot_template_save`. A chat's
 * description and avatar are display metadata: the agent may set them, but
 * they never enter its context. See packages/contracts/src/bots.ts.
 */

export const SESSION_PROFILE_TOOL_GUIDANCE =
  'When a person or a bot template chose the name, keep it unless the person asks for a new one. All fields are optional. description and avatar are shown to people, not to you; set them when the person asks or setup instructions say so. description: one line ("" clears it). avatar: null clears it; otherwise {kind:"emoji",emoji,hue}, {kind:"icon",icon,hue} or {kind:"letters",letters,hue} (one or two characters) with hue 0-359, or {kind:"image",artifactId}. An image shows at about 16 pixels: one bold symbol on a solid colour, no text or fine detail.';

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
        "Save a bot template people can start new bots from, when the person asks to make a template of you or this chat. Its setup instructions become the first message of every chat started from it: write them to the new agent from what this chat established (its job, the Skills, plugins, connections and machines it needs, the schedules and event triggers to create, its standing rules and preferences), without one-off tasks, history, personal details or secrets. Show the person your draft first unless they asked you to save it directly. The template is shared like this chat. avatar takes the same shapes as in set_session_title.",
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
}
