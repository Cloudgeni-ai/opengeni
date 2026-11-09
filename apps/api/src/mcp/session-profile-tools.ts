import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AGENTS_PER_WORKSPACE_MAX,
  AGENT_DESCRIPTION_MAX_LENGTH,
  AGENT_FIRST_MESSAGE_MAX_LENGTH,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  AGENT_SUGGESTION_FIRST_MESSAGE_MAX_LENGTH,
  AGENT_SUGGESTION_INSTRUCTIONS_MAX_LENGTH,
  AGENT_SUGGESTION_MIN_SIMILAR_REQUESTS,
  AGENT_SUGGESTION_REASON_MAX_LENGTH,
  CreateAgentRequest,
  type SessionAgentSuggestion,
  SESSION_AVATAR_ICONS,
  SESSION_DESCRIPTION_MAX_LENGTH,
  SessionAvatar,
  type AccessGrant,
} from "@opengeni/contracts";
import { agentViewerForGrant, updateSessionProfile, type ApiRouteDeps } from "@opengeni/core";
import {
  AgentLimitError,
  AgentPrivateOwnerError,
  agentMadeFromSession,
  claimSessionAgentSuggestion,
  countSessionHumanRequests,
  createAgent,
  getAgent,
  getSessionAgentId,
  getSessionForSubject,
  getSessionVisibility,
  listAgents,
  storedSessionAvatar,
  type AgentRecord,
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
        const { agent } = await createAgent(
          deps.db,
          { accountId: grant.accountId, workspaceId: grant.workspaceId },
          {
            visibility: request.visibility,
            ownerSubjectId: request.visibility === "private" ? viewer.subjectId : null,
            name: request.name,
            description: request.description,
            avatar: request.avatar,
            instructions: request.instructions,
            firstMessage: request.firstMessage,
            memoryEnabled: false,
            origin: "app",
            sourceSessionId: sessionId,
            createdBySubjectId: viewer.subjectId,
            maxPerWorkspace: AGENTS_PER_WORKSPACE_MAX,
          },
        );
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
  registerAgentSuggestTool(input);
}

/** The receipt a chat shows as an agent suggestion card. */
export const AGENT_SUGGESTION_RECEIPT_TYPE = "agent_suggestion";

function sameName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

/**
 * `agent_suggest`: when a chat keeps doing the same kind of work, the agent
 * may offer to make an agent of it (choosing the name, description and avatar
 * itself and drafting its Instructions and First message), or point to an
 * agent that already does this work. Nothing changes here: the suggestion is
 * recorded on the chat as display state and shown to people as a card; only a
 * person's own action makes an agent.
 */
function registerAgentSuggestTool(input: {
  server: McpServer;
  deps: ApiRouteDeps;
  grant: AccessGrant;
  sessionId: string;
  authorize: () => Promise<void>;
  json: (value: unknown) => { content: Array<{ type: "text"; text: string }> };
}): void {
  const { server, deps, grant, sessionId } = input;
  server.registerTool(
    "agent_suggest",
    {
      description:
        "Offer the person an agent for this work, shown as a card under this conversation. Use it at most once here, only when most of their requests are the same kind of work, including the last three or more in a row, and only if this chat is not already an agent's. Do not use it for a one-off task or because they might want something again. " +
        "kind=reuse names an agent that already does this work (agentId); prefer it when one fits (a kind=create whose name is taken returns the existing agents). " +
        "kind=create offers to make an agent from this conversation: choose a short name (a first name or a role, e.g. 'Invoice checker'), a one-line description and an avatar, and draft its Instructions, which every chat with it follows (its job, how it works, its standing rules, and the Skills, connections and machines it relies on), plus an optional First message for one-time setup. Leave out one-off tasks, history, personal details and secrets. " +
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
        name: z4.string().min(1).max(AGENT_NAME_MAX_LENGTH).optional(),
        description: z4.string().max(AGENT_DESCRIPTION_MAX_LENGTH).optional(),
        avatar: AvatarInput,
        instructions: z4
          .string()
          .max(AGENT_SUGGESTION_INSTRUCTIONS_MAX_LENGTH)
          .optional()
          .describe("kind=create: draft Instructions for the agent."),
        firstMessage: z4
          .string()
          .max(AGENT_SUGGESTION_FIRST_MESSAGE_MAX_LENGTH)
          .optional()
          .describe("kind=create: optional one-time setup that starts each new chat."),
        agentId: z4.string().uuid().optional().describe("kind=reuse: the agent."),
        reason: z4
          .string()
          .min(1)
          .max(AGENT_SUGGESTION_REASON_MAX_LENGTH)
          .describe("One sentence the person sees: why an agent fits this work."),
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
      if (current.agentSuggestion) {
        return notSuggested("already_suggested", "This chat already offered an agent.");
      }
      if (await getSessionAgentId(deps.db, { workspaceId: grant.workspaceId, sessionId })) {
        return notSuggested("already_an_agent", "This chat is already an agent's chat.");
      }
      // The agent judges similarity; people's real requests set the floor.
      const humanRequests = await countSessionHumanRequests(deps.db, {
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        sessionId,
      });
      if (
        Math.min(request.similarRequestsInARow, humanRequests) <
        AGENT_SUGGESTION_MIN_SIMILAR_REQUESTS
      ) {
        return notSuggested(
          "too_few_similar_requests",
          `An agent is for work that keeps coming back: wait until at least ${AGENT_SUGGESTION_MIN_SIMILAR_REQUESTS} requests in a row are the same kind of work.`,
        );
      }
      const home = { accountId: grant.accountId, workspaceId: grant.workspaceId };
      // The card and this receipt are read by everyone who can open the chat,
      // so a shared chat may only name shared agents: never this person's
      // own Only me ones, whose names others must not see.
      const viewer = await agentViewerForGrant(deps.db, grant);
      const sharedChat =
        (await getSessionVisibility(deps.db, grant.workspaceId, sessionId)) !== "user_private";
      const nameableHere = (agent: Pick<AgentRecord, "visibility" | "ownerSubjectId">) =>
        agent.visibility === "workspace" ||
        (!sharedChat && viewer.subjectId !== null && agent.ownerSubjectId === viewer.subjectId);
      let suggestion: SessionAgentSuggestion;
      if (request.kind === "reuse") {
        if (!request.agentId) {
          return notSuggested("agent_required", "kind=reuse needs agentId.");
        }
        const agent = await getAgent(deps.db, home, request.agentId);
        if (!agent || !nameableHere(agent)) {
          return notSuggested("not_found", "That agent does not exist here.");
        }
        suggestion = {
          id: randomUUID(),
          kind: "reuse",
          agentId: agent.id,
          name: agent.name,
          description: agent.description || null,
          avatar: storedSessionAvatar(agent.avatar),
          instructions: null,
          firstMessage: null,
          reason: request.reason,
          createdAt: new Date().toISOString(),
        };
      } else {
        if (await agentMadeFromSession(deps.db, home, sessionId)) {
          return notSuggested("already_made", "An agent was already made from this chat.");
        }
        const name = request.name?.trim();
        if (!name) return notSuggested("name_required", "kind=create needs a name.");
        const instructions = request.instructions?.trim() || null;
        const firstMessage = request.firstMessage?.trim() || null;
        if (!instructions && !firstMessage) {
          return notSuggested(
            "draft_required",
            "kind=create needs draft Instructions, a First message, or both.",
          );
        }
        const agents = (
          await listAgents(deps.db, home, { viewerSubjectId: viewer.subjectId })
        ).filter(nameableHere);
        if (agents.some((agent) => sameName(agent.name, name))) {
          return notSuggested(
            "name_taken",
            "An agent already has this name. Suggest it (kind=reuse) if it does this work, or choose another name.",
            {
              agents: agents.slice(0, 20).map((agent) => ({
                agentId: agent.id,
                name: agent.name,
                description: agent.description,
              })),
            },
          );
        }
        const avatar = avatarFromToolInput(request.avatar) ?? null;
        await requireUsableSessionAvatar(deps, grant, avatar, { sessionId });
        suggestion = {
          id: randomUUID(),
          kind: "create",
          agentId: null,
          name,
          description: request.description?.trim() || null,
          avatar,
          instructions,
          firstMessage,
          reason: request.reason,
          createdAt: new Date().toISOString(),
        };
      }
      // The checks above are only the cheap path: this write decides a race.
      const claimed = await claimSessionAgentSuggestion(deps.db, {
        workspaceId: grant.workspaceId,
        sessionId,
        suggestion,
      });
      if (!claimed) {
        return notSuggested("already_suggested", "This chat already offered an agent.");
      }
      return input.json({
        type: AGENT_SUGGESTION_RECEIPT_TYPE,
        status: "suggested",
        ...suggestion,
        note: "The person sees this as a card in the chat and decides. Nothing has changed yet.",
      });
    },
  );
}
