/**
 * The avatar in front of a chat's title in the sidebar and the chat switcher:
 * the chat's own avatar when someone gave it one, else the icon of the agent
 * it belongs to, the same icon its header chip and the agent's page show.
 * Ordinary chats without an avatar get `fallback` (nothing in the sidebar).
 */
import type { ReactNode } from "react";
import type { SessionAvatar as SessionAvatarValue } from "@opengeni/sdk";

import { useSessionAgent } from "../../lib/session-agent";
import { SessionAvatar, type SessionAvatarSize } from "./session-avatar";

export function ChatAvatar({
  chat,
  name,
  size = "xs",
  className,
  fallback = null,
}: {
  chat: {
    id: string;
    workspaceId: string;
    avatar?: SessionAvatarValue | null | undefined;
    agentId?: string | null | undefined;
  };
  /** The chat's title, for an image avatar's initials and alt text. */
  name: string;
  size?: SessionAvatarSize | undefined;
  className?: string | undefined;
  fallback?: ReactNode;
}) {
  // Read the agent only for an agent chat without its own avatar.
  const agentRef = !chat.avatar && chat.agentId ? { id: chat.agentId, name: null } : null;
  const agent = useSessionAgent(chat.workspaceId, agentRef);
  if (chat.avatar) {
    return (
      <SessionAvatar
        avatar={chat.avatar}
        name={name}
        workspaceId={chat.workspaceId}
        seed={chat.id}
        size={size}
        className={className}
      />
    );
  }
  if (agent) {
    return (
      <span data-chat-agent-avatar={agent.id} title={agent.name} className="inline-flex shrink-0">
        <SessionAvatar
          avatar={agent.avatar}
          name={agent.name}
          workspaceId={chat.workspaceId}
          seed={agent.id}
          size={size}
          className={className}
        />
      </span>
    );
  }
  return <>{fallback}</>;
}
