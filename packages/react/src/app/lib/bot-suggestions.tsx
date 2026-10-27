import type { Session, SessionBotSuggestion, SessionEvent } from "@opengeni/sdk";

/* ----------------------------------------------------------------------------
   Bot suggestions (`bot_suggest`): the newest one the agent made in a chat,
   either streamed into the loaded events as the tool's receipt or kept on the
   chat (`Session.botSuggestion`), which survives reloads when the tool step is
   not loaded. A suggestion is display state; acting on it goes through the
   person's own chat and template writes.
   -------------------------------------------------------------------------- */

const RECEIPT_TYPE = "bot_suggestion";

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function suggestionFrom(value: unknown, depth = 0): SessionBotSuggestion | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    try {
      return suggestionFrom(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const output = value as Record<string, unknown>;
  if (output.isError === true) return null;
  if (output.type === RECEIPT_TYPE && output.status === "suggested") {
    const kind = output.kind;
    if ((kind !== "create" && kind !== "reuse") || typeof output.id !== "string") return null;
    if (typeof output.name !== "string" || output.name.length === 0) return null;
    const avatar =
      output.avatar && typeof output.avatar === "object"
        ? (output.avatar as SessionBotSuggestion["avatar"])
        : null;
    return {
      id: output.id,
      kind,
      sessionId: stringOrNull(output.sessionId),
      templateId: stringOrNull(output.templateId),
      name: output.name,
      description: stringOrNull(output.description),
      avatar,
      setupInstructions: stringOrNull(output.setupInstructions),
      reason: stringOrNull(output.reason),
      createdAt: typeof output.createdAt === "string" ? output.createdAt : "",
    };
  }
  if (output.structuredContent) return suggestionFrom(output.structuredContent, depth + 1);
  if (Array.isArray(output.content)) {
    for (const block of output.content) {
      if (block?.type !== "text") continue;
      const parsed = suggestionFrom(block.text, depth + 1);
      if (parsed) return parsed;
    }
  }
  return null;
}

/** The newest suggestion streamed into the loaded events, if any. */
export function latestStreamedBotSuggestion(
  events: readonly SessionEvent[],
): SessionBotSuggestion | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "agent.toolCall.output") continue;
    if (!event.payload || typeof event.payload !== "object") continue;
    const suggestion = suggestionFrom((event.payload as Record<string, unknown>).output);
    if (suggestion) return suggestion;
  }
  return null;
}

/** The suggestion to show: the newer of the streamed receipt and the kept copy. */
export function currentBotSuggestion(
  session: Pick<Session, "botSuggestion">,
  events: readonly SessionEvent[],
): SessionBotSuggestion | null {
  const streamed = latestStreamedBotSuggestion(events);
  const kept = session.botSuggestion ?? null;
  if (!streamed) return kept;
  if (!kept) return streamed;
  return kept.createdAt > streamed.createdAt ? kept : streamed;
}

const DISMISSED_PREFIX = "opengeni.botSuggestion.dismissed:";

export function botSuggestionDismissed(sessionId: string, suggestionId: string): boolean {
  try {
    return localStorage.getItem(`${DISMISSED_PREFIX}${sessionId}`) === suggestionId;
  } catch {
    return false;
  }
}

export function dismissBotSuggestion(sessionId: string, suggestionId: string): void {
  try {
    localStorage.setItem(`${DISMISSED_PREFIX}${sessionId}`, suggestionId);
  } catch {
    // Without storage the card returns after a reload; nothing else depends on it.
  }
}
