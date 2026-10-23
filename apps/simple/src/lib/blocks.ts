/**
 * Agents act on the app through fenced JSON blocks in their replies
 * (`geni-agent` creates an agent, `geni-profile` updates the speaker's own
 * profile). The app applies each block once and shows a small card instead.
 */
export type ActionBlock = {
  kind: "agent" | "profile";
  payload: Record<string, unknown> | null;
  raw: string;
  complete: boolean;
};

/** `start` is the segment's offset in the reply: a stable identity while it streams. */
export type MessageSegment =
  | { type: "text"; text: string; start: number }
  | { type: "block"; block: ActionBlock; start: number };

/**
 * Blocks written in the last few minutes apply on their own. Older ones are
 * history (the app may have been reinstalled since), so they never fire again.
 */
export const AUTO_APPLY_WINDOW_MS = 10 * 60 * 1000;

const FENCE = /```geni-(agent|profile)[^\n]*\n([\s\S]*?)(```|$)/g;

export function splitActionBlocks(text: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(FENCE)) {
    const start = match.index ?? 0;
    if (start > cursor)
      segments.push({ type: "text", text: text.slice(cursor, start), start: cursor });
    const raw = match[2] ?? "";
    const complete = match[3] === "```";
    let payload: Record<string, unknown> | null = null;
    if (complete) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
      } catch {
        payload = null;
      }
    }
    segments.push({
      type: "block",
      start,
      block: { kind: match[1] as ActionBlock["kind"], payload, raw, complete },
    });
    cursor = start + match[0].length;
  }
  if (cursor < text.length)
    segments.push({ type: "text", text: text.slice(cursor), start: cursor });
  return segments;
}

export function hasActionBlock(text: string) {
  return /```geni-(agent|profile)/.test(text);
}

/** Stable identity for a block: the chat it came from plus its exact content. */
export async function blockKey(sessionId: string, block: ActionBlock) {
  const bytes = new TextEncoder().encode(`${sessionId}\n${block.kind}\n${block.raw.trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${block.kind}:${hex.slice(0, 40)}`;
}
