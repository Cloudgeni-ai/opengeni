/**
 * "Continue in a new chat": a fresh chat on another model, seeded from an
 * earlier one. The earlier chat is never changed. A chat frozen on Codex remote
 * compaction (`remote_v2`) keeps its own memory in an encrypted form only Codex
 * can read, so the new chat receives a bounded plain-text copy of the earlier
 * conversation as model-visible context instead, and its first turn writes a
 * summary any model can read. Long chats are shortened from the middle: the
 * first request and the most recent exchange matter most.
 */

export type SessionContinuationMessage = {
  role: "user" | "assistant";
  text: string;
};

/** Below the 32,768-character `modelContext` contract with room for the header. */
export const SESSION_CONTINUATION_CONTEXT_MAX_CHARS = 30_000;
/** One message never takes more than this share of the context. */
export const SESSION_CONTINUATION_MESSAGE_MAX_CHARS = 6_000;
/** Metadata key that links a continuation back to the chat it continues. */
export const SESSION_CONTINUED_FROM_METADATA_KEY = "continuedFromSessionId";

function shorten(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const marker = "\n[…shortened…]\n";
  const head = Math.ceil((max - marker.length) * 0.6);
  const tail = max - marker.length - head;
  return `${trimmed.slice(0, head).trimEnd()}${marker}${trimmed.slice(trimmed.length - tail).trimStart()}`;
}

function block(message: SessionContinuationMessage): string {
  const label = message.role === "user" ? "[User]" : "[Assistant]";
  return `${label}\n${shorten(message.text, SESSION_CONTINUATION_MESSAGE_MAX_CHARS)}`;
}

/** A readable, one-line chat title for prose and links. */
export function sessionContinuationTitle(title: string | null | undefined): string {
  const line = (title ?? "").replace(/\s+/g, " ").trim();
  return line.length > 0 ? line.slice(0, 120) : "Earlier chat";
}

/**
 * Model-visible context for the new chat. `messages` are the earlier chat's
 * user messages and final assistant answers, oldest first. The result never
 * exceeds `maxChars`.
 */
export function buildSessionContinuationContext(input: {
  sourceSessionId: string;
  sourceTitle: string | null | undefined;
  sourceModel: string;
  messages: readonly SessionContinuationMessage[];
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? SESSION_CONTINUATION_CONTEXT_MAX_CHARS;
  const header = [
    `This chat continues an earlier chat, "${sessionContinuationTitle(input.sourceTitle)}" (session ${input.sourceSessionId}), which ran on ${input.sourceModel}. The earlier chat is unchanged; this chat uses a different model.`,
    "The earlier conversation follows, oldest first. Long messages are shortened and the middle of a long conversation may be left out. Read the earlier chat with session_events when you need more detail.",
  ].join("\n");
  const messages = input.messages.filter((message) => message.text.trim().length > 0);
  if (messages.length === 0) {
    return `${header}\n\n(The earlier chat has no messages yet.)`.slice(0, maxChars);
  }
  const separator = "\n\n";
  const omittedNote = (count: number) =>
    `[${count} earlier message${count === 1 ? "" : "s"} left out]`;
  // Reserve the header, the first request, and a worst-case omission note.
  const first = block(messages[0]!);
  const reserve = header.length + separator.length * 3 + omittedNote(messages.length).length;
  let budget = maxChars - reserve - first.length;
  const recent: string[] = [];
  let index = messages.length - 1;
  for (; index >= 1; index -= 1) {
    const next = block(messages[index]!);
    if (next.length + separator.length > budget) break;
    recent.unshift(next);
    budget -= next.length + separator.length;
  }
  const omitted = index; // messages[1..index] were left out
  const parts = [header];
  if (first.length + reserve <= maxChars) parts.push(first);
  else parts.push(shorten(first, Math.max(0, maxChars - reserve)));
  if (omitted > 0) parts.push(omittedNote(omitted));
  parts.push(...recent);
  return parts.join(separator).slice(0, maxChars);
}

/**
 * The visible first message of the new chat when the caller supplies none. It
 * links back to the earlier chat and asks the model to start with a summary.
 */
export function defaultSessionContinuationMessage(input: {
  sourceSessionId: string;
  sourceTitle: string | null | undefined;
}): string {
  const title = sessionContinuationTitle(input.sourceTitle).replace(/[[\]]/g, "");
  return `Continue from [${title}](session:${input.sourceSessionId}). Start with a short summary of where things stand.`;
}
