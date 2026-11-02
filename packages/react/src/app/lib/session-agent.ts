/**
 * The agent a chat was started with, for the chat header: its id from
 * `session.agentId` (or, for older Slack chats, the Slack agent in the chat's
 * metadata), then its current name and icon read once and shared by every
 * header that shows it.
 *
 * No zod here: the chat header is an eager module.
 */
import { useEffect, useState } from "react";
import type { SessionAvatar } from "@opengeni/sdk";

import type { Session } from "../types";
import { useOptionalAppContext } from "../app-context";
import { agentAvatar } from "./agent-avatar";
import { sessionSlackAgentInfo } from "./session-slack-agent";

export type SessionAgentRef = { id: string; name: string | null };

export type SessionAgentInfo = {
  id: string;
  name: string;
  avatar: SessionAvatar;
  /** False while only the chat's own record of it is known (or it is gone). */
  live: boolean;
};

/** The agent this chat belongs to, or null for an ordinary chat. */
export function sessionAgentRef(
  session: Pick<Session, "metadata"> & { agentId?: string | null | undefined },
): SessionAgentRef | null {
  const slack = sessionSlackAgentInfo(session.metadata);
  if (session.agentId) {
    return { id: session.agentId, name: slack?.id === session.agentId ? slack.name : null };
  }
  return slack ? { id: slack.id, name: slack.name } : null;
}

/** True for a chat someone started in Slack. */
export function sessionStartedInSlack(session: Pick<Session, "metadata">): boolean {
  return sessionSlackAgentInfo(session.metadata) !== null;
}

/**
 * Where and by whom the chat started, for the line under its title:
 * "Started in Slack by Kari". Null for chats started in the app.
 */
export function sessionAgentSourceLine(
  session: Pick<Session, "metadata" | "createdBy">,
): string | null {
  if (!sessionStartedInSlack(session)) return null;
  const by =
    session.createdBy?.kind === "subject" && session.createdBy.label?.trim()
      ? session.createdBy.label.trim()
      : null;
  return by ? `Started in Slack by ${by}` : "Started in Slack";
}

type CachedAgent = { name: string; avatar: SessionAvatar | null } | null;

const cache = new Map<string, Promise<CachedAgent>>();

/** Read the agent again next time a header shows it, after a change here. */
export function forgetSessionAgent(workspaceId: string, agentId: string): void {
  cache.delete(`${workspaceId}:${agentId}`);
}

/** The agent's current name and icon; the chat's own record until (or unless) it loads. */
export function useSessionAgent(
  workspaceId: string,
  ref: SessionAgentRef | null,
): SessionAgentInfo | null {
  const context = useOptionalAppContext();
  const id = ref?.id ?? null;
  const [loaded, setLoaded] = useState<{ key: string; value: CachedAgent } | null>(null);
  const key = id ? `${workspaceId}:${id}` : null;
  useEffect(() => {
    if (!key || !id || !context) return;
    // Read the client only for a chat with an agent.
    const client = context.client;
    if (typeof client?.getAgent !== "function") return;
    let live = true;
    let pending = cache.get(key);
    if (!pending) {
      pending = client.getAgent(workspaceId, id).then(
        (agent) => ({ name: agent.name, avatar: agent.avatar }),
        () => {
          // Gone, hidden or unreachable: show what the chat knows, and ask again next time.
          cache.delete(key);
          return null;
        },
      );
      cache.set(key, pending);
    }
    void pending.then((value) => {
      if (live) setLoaded({ key, value });
    });
    return () => {
      live = false;
    };
  }, [context, id, key, workspaceId]);
  if (!ref) return null;
  const current = loaded?.key === key ? loaded.value : null;
  if (current) {
    return {
      id: ref.id,
      name: current.name,
      avatar: agentAvatar({ id: ref.id, name: current.name, avatar: current.avatar }),
      live: true,
    };
  }
  if (!ref.name) return null;
  return {
    id: ref.id,
    name: ref.name,
    avatar: agentAvatar({ id: ref.id, name: ref.name, avatar: null }),
    live: false,
  };
}
