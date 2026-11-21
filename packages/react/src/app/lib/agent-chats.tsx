/**
 * The chats started with one agent, newest first. The session list has no
 * agent filter, so this pages through the person's chats (100 at a time)
 * until it has `enough` of the agent's or has read `maxPages` pages. A
 * failed read rejects: callers show an error, never "no chats".
 */
const PAGE_SIZE = 100;

type AgentChat = { id: string; agentId?: string | null | undefined };

interface SessionPage<S> {
  pinned: readonly S[];
  sessions: readonly S[];
  nextCursor: string | null;
}

export interface AgentChatsClient<S extends AgentChat> {
  listSessionPage(
    workspaceId: string,
    options: { limit?: number; cursor?: string; signal?: AbortSignal | undefined },
  ): Promise<SessionPage<S>>;
}

export async function listAgentChats<S extends AgentChat>(
  client: AgentChatsClient<S>,
  workspaceId: string,
  agentId: string,
  options: { enough?: number; maxPages?: number; signal?: AbortSignal | undefined } = {},
): Promise<S[]> {
  const enough = options.enough ?? 100;
  const maxPages = options.maxPages ?? 10;
  const found: S[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await client.listSessionPage(workspaceId, {
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      signal: options.signal,
    });
    for (const session of [...result.pinned, ...result.sessions]) {
      if (session.agentId !== agentId || seen.has(session.id)) continue;
      seen.add(session.id);
      found.push(session);
    }
    if (found.length >= enough || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return found;
}
