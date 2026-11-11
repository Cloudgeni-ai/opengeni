import { SESSION_INSTRUCTIONS_MAX_CHARACTERS, type AccessGrant } from "@opengeni/contracts";
import {
  agentMemoryAccess,
  agentMemoryGuidance,
  type ApiRouteDeps,
  type SessionCreateRequestOptions,
} from "@opengeni/core";
import { getAgent } from "@opengeni/db";

/**
 * An app chat started with an agent (`POST /sessions` with `agentId`): its
 * Instructions are the agent layer; what this adds is its Memory. With Memory
 * on, the chat is told its collection and whether it may save to it, and gets
 * `slack_agent_chats` to read the agent's other shared chats. Slack agent
 * chats get the same guidance from their Slack instructions. An unknown or
 * unusable agent is left to session creation, which refuses it.
 */
export async function prepareAgentChatCreate(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  workspaceId: string,
  payload: unknown,
): Promise<SessionCreateRequestOptions | undefined> {
  if (!payload || typeof payload !== "object") return undefined;
  const request = payload as Record<string, unknown>;
  if (typeof request["agentId"] !== "string" || request["parentSessionId"]) return undefined;
  const agent = await getAgent(
    deps.db,
    { accountId: grant.accountId, workspaceId },
    request["agentId"],
  ).catch(() => null);
  if (!agent?.memoryEnabled) return undefined;
  const access = agentMemoryAccess(agent, {
    private: request["visibility"] === "private",
    ownerSubjectId: grant.subjectId,
    memoryOff: request["memoryScope"] === "off",
  });
  const guidance = agentMemoryGuidance(access);
  if (guidance) {
    const own = typeof request["instructions"] === "string" ? request["instructions"].trim() : "";
    const combined = own ? `${own}\n\n${guidance}` : guidance;
    // The person's own text is never cut: without room the guidance is left
    // out, and the knowledge tools still enforce the rules.
    if (combined.length <= SESSION_INSTRUCTIONS_MAX_CHARACTERS) request["instructions"] = combined;
  }
  return access.listChats ? { firstPartyMcpToolAdditions: ["slack_agent_chats"] } : undefined;
}
