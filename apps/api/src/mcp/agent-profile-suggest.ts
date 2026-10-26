import {
  AGENT_PROFILE_NAME_MAX_CHARS,
  AGENT_PROFILE_ROLE_MAX_CHARS,
  AGENT_INSTRUCTIONS_MAX_CHARACTERS,
  isSingleAgentAvatarEmoji,
  type AccessGrant,
  type AgentAvatar,
  type SessionAgentProfileSuggestion,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { randomUUID } from "node:crypto";
import {
  getAgentProfile,
  getSession,
  listAgentProfiles,
  setSessionAgentProfileSuggestion,
} from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

type JsonResult = (value: unknown) => {
  content: { type: "text"; text: string }[];
};

/** The receipt the person's chat renders as a suggestion card. */
export const AGENT_PROFILE_SUGGESTION_RECEIPT_TYPE = "agent_profile_suggestion";

const AVATAR_HUES = [235, 20, 60, 160, 300, 190, 340, 260] as const;

function hueFor(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return AVATAR_HUES[hash % AVATAR_HUES.length]!;
}

function lettersFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const raw = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "A").slice(0, 2);
  return (
    raw
      .replace(/[^\p{L}\p{N}]/gu, "")
      .slice(0, 2)
      .toUpperCase() || "A"
  );
}

/**
 * `agent_profile_suggest`: when a chat keeps repeating the same kind of work,
 * the agent may propose making it a reusable agent (choosing the name, role,
 * emoji and drafted instructions itself) or switching to an existing saved
 * agent that already does it. Nothing is created or changed here: the tool
 * validates the suggestion and returns a receipt that the person's chat shows
 * as a card. Only the person's own accept saves or applies anything, through
 * the ordinary agent-profile routes.
 */
export function registerAgentProfileSuggestTool(input: {
  server: McpServer;
  deps: Pick<ApiRouteDeps, "db" | "settings">;
  grant: AccessGrant;
  sessionId: string;
  authorize: () => Promise<void>;
  json: JsonResult;
}): void {
  const { server, deps, grant, sessionId, json } = input;
  server.registerTool(
    "agent_profile_suggest",
    {
      description:
        "Suggest a reusable agent to the person, shown as a card in their chat. Use it at most once per chat, and only when the person has asked for the same kind of work several times here (for example checking invoice after invoice) or plainly describes a role they will want again. " +
        "Prefer kind=reuse with agentProfileId when one of the workspace's saved agents already does this work (the response to kind=create lists them when a name is taken). " +
        "For kind=create, choose a short human name (a first name or a role, e.g. 'Invoice checker'), one emoji, a one-line role, and draft instructions that capture how this chat has been doing the work. " +
        "Nothing is saved until the person accepts the card. Do not mention the card in your reply, and do not suggest again in this chat after the person dismisses it.",
      inputSchema: {
        kind: z.enum(["create", "reuse"]),
        agentProfileId: z
          .string()
          .uuid()
          .optional()
          .describe("kind=reuse: the saved agent to switch to."),
        name: z
          .string()
          .trim()
          .min(1)
          .max(AGENT_PROFILE_NAME_MAX_CHARS)
          .optional()
          .describe("kind=create: the new agent's name."),
        role: z
          .string()
          .trim()
          .min(1)
          .max(AGENT_PROFILE_ROLE_MAX_CHARS)
          .optional()
          .describe("kind=create: one line saying what the agent does."),
        emoji: z
          .string()
          .trim()
          .min(1)
          .max(32)
          .optional()
          .describe("kind=create: exactly one emoji."),
        instructions: z
          .string()
          .trim()
          .min(1)
          .max(AGENT_INSTRUCTIONS_MAX_CHARACTERS)
          .optional()
          .describe("kind=create: drafted instructions for how the agent works."),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(400)
          .describe("One sentence the person sees: why this is worth saving or switching to."),
      },
    },
    async (request) => {
      await input.authorize();
      // The chat keeps the newest suggestion so its card survives reloads.
      const suggest = async (content: Omit<SessionAgentProfileSuggestion, "id" | "createdAt">) => {
        const suggestion: SessionAgentProfileSuggestion = {
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          ...content,
        };
        await setSessionAgentProfileSuggestion(deps.db, {
          workspaceId: grant.workspaceId,
          sessionId,
          suggestion,
        });
        return json({
          type: AGENT_PROFILE_SUGGESTION_RECEIPT_TYPE,
          status: "suggested",
          ...suggestion,
          note: "The person sees this as a card in the chat. Nothing is saved unless they accept. Do not mention the card in your reply, and do not suggest again in this chat.",
        });
      };
      if (!deps.settings.agentProfilesEnabled) {
        return json({
          status: "not_suggested",
          code: "unavailable",
          message: "Agent profiles are off.",
        });
      }
      const session = await getSession(deps.db, grant.workspaceId, sessionId);
      if (request.kind === "reuse") {
        if (!request.agentProfileId) {
          return json({
            status: "not_suggested",
            code: "agent_profile_required",
            message: "kind=reuse needs agentProfileId.",
          });
        }
        const profile = await getAgentProfile(deps.db, grant.workspaceId, request.agentProfileId);
        if (!profile || profile.status !== "active") {
          return json({
            status: "not_suggested",
            code: "unknown_agent_profile",
            message: "No active saved agent has that id.",
          });
        }
        if (session?.agentProfile?.profileId === profile.id) {
          return json({
            status: "not_suggested",
            code: "already_in_use",
            message: `This chat already uses ${profile.name}.`,
          });
        }
        return await suggest({
          kind: "reuse",
          profileId: profile.id,
          name: profile.name,
          role: profile.role,
          avatar: profile.avatar,
          instructions: null,
          reason: request.reason,
        });
      }
      const name = request.name?.trim();
      if (!name) {
        return json({
          status: "not_suggested",
          code: "name_required",
          message: "kind=create needs a name.",
        });
      }
      const active = await listAgentProfiles(deps.db, grant.workspaceId);
      const taken = active.find((profile) => profile.name.toLowerCase() === name.toLowerCase());
      if (taken) {
        return json({
          status: "not_suggested",
          code: "name_taken",
          message: `A saved agent is already named ${taken.name}. Suggest kind=reuse with its id, or a different name.`,
          savedAgents: active.slice(0, 20).map((profile) => ({
            agentProfileId: profile.id,
            name: profile.name,
            role: profile.role,
          })),
        });
      }
      const hue = hueFor(name);
      const avatar: AgentAvatar =
        request.emoji && isSingleAgentAvatarEmoji(request.emoji)
          ? { kind: "emoji", emoji: request.emoji, hue }
          : { kind: "letters", letters: lettersFor(name), hue };
      return await suggest({
        kind: "create",
        profileId: null,
        name,
        role: request.role ?? null,
        avatar,
        instructions: request.instructions ?? null,
        reason: request.reason,
      });
    },
  );
}
