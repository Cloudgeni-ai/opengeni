import type { AgentAvatar, Session, SessionEvent } from "@opengeni/sdk";

/** What an `agent_profile_suggest` call proposed, as its receipt says. */
export type AgentProfileSuggestion = {
  /** The tool output event that carried the receipt (stable key for dismissal). */
  eventId: string;
  kind: "create" | "reuse";
  profileId: string | null;
  name: string;
  role: string | null;
  avatar: AgentAvatar;
  instructions: string | null;
  reason: string | null;
};

function isAvatar(value: unknown): value is AgentAvatar {
  if (!value || typeof value !== "object") return false;
  const avatar = value as Record<string, unknown>;
  if (typeof avatar.hue !== "number") return false;
  return (
    (avatar.kind === "emoji" && typeof avatar.emoji === "string") ||
    (avatar.kind === "icon" && typeof avatar.icon === "string") ||
    (avatar.kind === "letters" && typeof avatar.letters === "string")
  );
}

function receiptFrom(value: unknown, depth = 0): Omit<AgentProfileSuggestion, "eventId"> | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    try {
      return receiptFrom(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const output = value as Record<string, unknown>;
  if (output.isError === true) return null;
  if (output.type === "agent_profile_suggestion" && output.status === "suggested") {
    const kind = output.kind;
    if ((kind !== "create" && kind !== "reuse") || typeof output.name !== "string") return null;
    if (!isAvatar(output.avatar)) return null;
    if (kind === "reuse" && typeof output.profileId !== "string") return null;
    return {
      kind,
      profileId: typeof output.profileId === "string" ? output.profileId : null,
      name: output.name,
      role: typeof output.role === "string" ? output.role : null,
      avatar: output.avatar,
      instructions: typeof output.instructions === "string" ? output.instructions : null,
      reason: typeof output.reason === "string" ? output.reason : null,
    };
  }
  if (output.structuredContent) return receiptFrom(output.structuredContent, depth + 1);
  if (Array.isArray(output.content)) {
    for (const block of output.content) {
      if (block?.type !== "text") continue;
      const parsed = receiptFrom(block.text, depth + 1);
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * The newest agent-profile suggestion in this chat, if any. A receipt is only
 * a discovery hint: accepting it goes through the person's own profile writes.
 */
export function latestAgentProfileSuggestion(
  events: readonly SessionEvent[],
): AgentProfileSuggestion | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "agent.toolCall.output") continue;
    if (!event.payload || typeof event.payload !== "object") continue;
    const receipt = receiptFrom((event.payload as Record<string, unknown>).output);
    if (receipt) {
      const output = (event.payload as Record<string, unknown>).output;
      const id = suggestionIdFrom(output);
      return { eventId: id ?? event.id, ...receipt };
    }
  }
  return null;
}

function suggestionIdFrom(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    try {
      return suggestionIdFrom(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const output = value as Record<string, unknown>;
  if (output.type === "agent_profile_suggestion" && typeof output.id === "string") return output.id;
  if (output.structuredContent) return suggestionIdFrom(output.structuredContent, depth + 1);
  if (Array.isArray(output.content)) {
    for (const block of output.content) {
      if (block?.type !== "text") continue;
      const id = suggestionIdFrom(block.text, depth + 1);
      if (id) return id;
    }
  }
  return null;
}

/**
 * The suggestion to show: the newest one streamed into the loaded events, or
 * the one the chat keeps (which survives reloads, when tool steps are not
 * loaded). Its `eventId` is the suggestion id, the key a dismissal remembers.
 */
export function currentAgentProfileSuggestion(
  session: Pick<Session, "agentProfileSuggestion">,
  events: readonly SessionEvent[],
): AgentProfileSuggestion | null {
  const streamed = latestAgentProfileSuggestion(events);
  if (streamed) return streamed;
  const kept = session.agentProfileSuggestion;
  if (!kept) return null;
  return {
    eventId: kept.id,
    kind: kept.kind,
    profileId: kept.profileId,
    name: kept.name,
    role: kept.role,
    avatar: kept.avatar,
    instructions: kept.instructions,
    reason: kept.reason,
  };
}

const DISMISSED_PREFIX = "opengeni.agentProfileSuggestion.dismissed:";

export function agentProfileSuggestionDismissed(sessionId: string, eventId: string): boolean {
  try {
    return localStorage.getItem(`${DISMISSED_PREFIX}${sessionId}`) === eventId;
  } catch {
    return false;
  }
}

export function dismissAgentProfileSuggestion(sessionId: string, eventId: string): void {
  try {
    localStorage.setItem(`${DISMISSED_PREFIX}${sessionId}`, eventId);
  } catch {
    // Without storage the card returns after a reload; nothing else depends on it.
  }
}
