import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AGENTS_PER_WORKSPACE_MAX,
  AGENT_DESCRIPTION_MAX_LENGTH,
  AGENT_FIRST_MESSAGE_MAX_LENGTH,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  CreateAgentRequest,
  SESSION_AVATAR_ICONS,
  SESSION_DESCRIPTION_MAX_LENGTH,
  SessionAvatar,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  agentViewerForGrant,
  requireLiveAgentAttemptAuthorization,
  updateSessionProfile,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  AgentLimitError,
  AgentPrivateOwnerError,
  createAgent,
  getSessionVisibility,
  withSessionRlsActorContext,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import * as z4 from "zod/v4";
import { ensureAgentMemoryCollection } from "../integrations/agent-memory-collection";
import { requireUsableSessionAvatar } from "../routes/session-avatar";

/**
 * The bot half of the title tools and `bot_template_save`. A chat's
 * description and avatar are display metadata: the agent may set them, but
 * they never enter its context. See packages/contracts/src/bots.ts.
 */

export const SESSION_PROFILE_TOOL_GUIDANCE =
  'When a person or an agent chose the name, keep it unless the person asks for a new one. description and avatar are shown to people, not to you; set them when the person asks or setup instructions say so. description: one line ("" clears it). avatar: null clears it; otherwise {kind:"emoji",emoji,hue}, {kind:"icon",icon,hue}, {kind:"letters",letters,hue} (one or two letters or digits) or {kind:"image",artifactId}. An image shows at about 16 pixels: one bold symbol on a solid colour, no text or fine detail.';

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
        "Make an agent from this chat when the person asks to make this an agent or a template. Write its Instructions, which every chat with it follows, from what this chat established: its job, how it works, its standing rules and preferences, and the Skills, plugins, connections and machines it relies on. Put one-time setup (installs, schedules, event triggers, first questions) in the optional First message, which starts each new chat's composer. Leave out one-off tasks, history, personal details and secrets. Show the person your draft first unless they asked you to save it directly. It is shared like this chat. avatar takes the same shapes as in set_session_title.",
      inputSchema: {
        name: z4.string().min(1).max(AGENT_NAME_MAX_LENGTH),
        description: z4.string().max(AGENT_DESCRIPTION_MAX_LENGTH).optional(),
        avatar: AvatarInput,
        instructions: z4.string().max(AGENT_INSTRUCTIONS_MAX_LENGTH).optional(),
        firstMessage: z4.string().max(AGENT_FIRST_MESSAGE_MAX_LENGTH).optional(),
        setupInstructions: z4
          .string()
          .max(AGENT_FIRST_MESSAGE_MAX_LENGTH)
          .optional()
          .describe("Older name for firstMessage."),
      },
    },
    async ({ name, description, avatar, instructions, firstMessage, setupInstructions }) => {
      await input.authorize();
      const exactAvatar = avatarFromToolInput(avatar) ?? null;
      // An agent is shared like the chat it was made from, so what an Only
      // me chat writes into one is never shown to the workspace by the agent.
      const visibility =
        (await getSessionVisibility(deps.db, grant.workspaceId, sessionId)) === "user_private"
          ? "private"
          : "workspace";
      const parsed = CreateAgentRequest.safeParse({
        name,
        description: description ?? "",
        avatar: exactAvatar,
        visibility,
        instructions: instructions ?? "",
        firstMessage: firstMessage?.trim() ? firstMessage : (setupInstructions ?? ""),
        sourceSessionId: sessionId,
      });
      if (!parsed.success) {
        throw new HTTPException(422, {
          message: parsed.error.issues
            .map((issue) =>
              issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
            )
            .join(" "),
        });
      }
      const request = parsed.data;
      if (!request.instructions && !request.firstMessage) {
        throw new HTTPException(422, {
          message: "Give the agent Instructions, a First message, or both.",
        });
      }
      const viewer = await agentViewerForGrant(deps.db, grant);
      if (visibility === "private" && viewer.subjectId === null) {
        throw new HTTPException(422, {
          message:
            "This chat is Only me and no person is behind this run, so its agent would belong to nobody. Ask the person to make it from Agents.",
        });
      }
      await requireUsableSessionAvatar(deps, grant, request.avatar, {
        sharedWithWorkspace: visibility === "workspace",
      });
      try {
        const home = { accountId: grant.accountId, workspaceId: grant.workspaceId };
        const { agent: created } = await createAgent(deps.db, home, {
          visibility: request.visibility,
          ownerSubjectId: request.visibility === "private" ? viewer.subjectId : null,
          name: request.name,
          description: request.description,
          avatar: request.avatar,
          instructions: request.instructions,
          firstMessage: request.firstMessage,
          // New agents remember by default, wherever they are made.
          memoryEnabled: true,
          origin: "app",
          sourceSessionId: sessionId,
          createdBySubjectId: viewer.subjectId,
          maxPerWorkspace: AGENTS_PER_WORKSPACE_MAX,
        });
        // Its Memory collection is saved by this chat, under its Agent learning.
        const agent = await ensureAgentMemoryCollection(deps.db, home, created, async (save) => {
          const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
          return await withSessionRlsActorContext(
            {
              subjectId: attempt.subjectId,
              initiatingHumanSubjectId: attempt.initiatingHumanSubjectId,
            },
            () =>
              save({
                accountId: grant.accountId,
                workspaceId: grant.workspaceId,
                actor: {
                  kind: "agent",
                  sessionId: attempt.callerSessionId,
                  turnId: attempt.turnId,
                  attemptId: attempt.attemptId,
                  executionGeneration: attempt.executionGeneration,
                },
              }),
          );
        });
        return input.json({
          ok: true,
          agent: {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            visibility: agent.visibility,
            revision: agent.currentRevision,
          },
        });
      } catch (error) {
        if (error instanceof AgentLimitError) {
          throw new HTTPException(409, { message: error.message });
        }
        if (error instanceof AgentPrivateOwnerError) {
          throw new HTTPException(422, { message: error.message });
        }
        throw error;
      }
    },
  );
}
