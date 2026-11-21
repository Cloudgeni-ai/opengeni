/**
 * The chats started with one agent that the reader can open, newest first,
 * for the pickers that post into an existing chat. The server filters by
 * agent (`GET …/agents/:agentId/chats`), so this reads only the agent's
 * chats, 100 at a time, up to `maxPages` pages. A failed read rejects:
 * callers show an error, never "no chats".
 */
import type { AgentChat, AgentChatsFilter, ListAgentChatsResponse } from "@opengeni/sdk";

const PAGE_SIZE = 100;

export interface AgentChatsClient {
  listAgentChats(
    workspaceId: string,
    agentId: string,
    options: { filter?: AgentChatsFilter; cursor?: string; limit?: number },
  ): Promise<ListAgentChatsResponse>;
}

export async function listAgentChats(
  client: AgentChatsClient,
  workspaceId: string,
  agentId: string,
  options: { maxPages?: number; signal?: AbortSignal | undefined } = {},
): Promise<AgentChat[]> {
  const maxPages = options.maxPages ?? 5;
  const found: AgentChat[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    options.signal?.throwIfAborted();
    const result = await client.listAgentChats(workspaceId, agentId, {
      filter: "everyone",
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    found.push(...result.chats);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return found;
}
