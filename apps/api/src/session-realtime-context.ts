import {
  CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT,
  CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS,
  type CodexRealtimeInitialItem,
} from "@opengeni/codex";

export type SessionRealtimeHistoryRow = {
  position: number;
  item: Record<string, unknown>;
};

const BYTES_PER_ESTIMATED_TOKEN = 4;
const HISTORY_TRUNCATION_MARKER = "…[earlier content truncated]\n";

/**
 * Project ordinary model-facing conversation truth into Frameless V3 startup
 * items. Only complete role-bearing messages are legal V3 initial items;
 * reasoning, tool protocol records, images, and raw provider metadata are never
 * copied into the browser-owned call bootstrap.
 *
 * The newest complete tail wins deterministically. This mirrors Codex's exact
 * byte/4 token estimate and hard 128-item/8,192-token limits.
 */
export function projectSessionRealtimeInitialItems(
  rows: readonly SessionRealtimeHistoryRow[],
): CodexRealtimeInitialItem[] {
  const messages = [...rows]
    .sort((left, right) => left.position - right.position)
    .map(({ item }) => projectHistoryMessage(item))
    .filter((item): item is CodexRealtimeInitialItem => item !== null);
  const selected: CodexRealtimeInitialItem[] = [];
  let remainingTokens = CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (
      selected.length >= CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT ||
      remainingTokens <= 0
    )
      break;
    const message = messages[index]!;
    const tokens = estimatedTokens(message.text);
    if (tokens <= remainingTokens) {
      selected.push(message);
      remainingTokens -= tokens;
      continue;
    }
    // If the newest message alone exceeds the entire provider budget, preserve
    // its newest UTF-8 tail with an explicit marker. Otherwise stop at the last
    // complete item rather than manufacturing a partial older utterance.
    if (selected.length === 0) {
      const text = truncateTextTail(
        message.text,
        remainingTokens * BYTES_PER_ESTIMATED_TOKEN,
      );
      if (text) selected.push({ ...message, text });
    }
    break;
  }

  return selected.reverse();
}

function projectHistoryMessage(
  item: Record<string, unknown>,
): CodexRealtimeInitialItem | null {
  if (item.type !== "message") return null;
  const role = item.role;
  if (role !== "user" && role !== "developer" && role !== "assistant")
    return null;
  if (item.status !== undefined && item.status !== "completed") return null;
  const text = messageText(item.content);
  return text ? { role, text } : null;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as Record<string, unknown>;
      if (
        (value.type === "input_text" ||
          value.type === "output_text" ||
          value.type === "text") &&
        typeof value.text === "string"
      ) {
        return [value.text];
      }
      return [];
    })
    .join("");
}

function estimatedTokens(text: string): number {
  return Math.ceil(utf8ByteLength(text) / BYTES_PER_ESTIMATED_TOKEN);
}

function truncateTextTail(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(text) <= maxBytes) return text;
  const markerBytes = utf8ByteLength(HISTORY_TRUNCATION_MARKER);
  if (markerBytes >= maxBytes) return takeUtf8Tail(text, maxBytes);
  return `${HISTORY_TRUNCATION_MARKER}${takeUtf8Tail(text, maxBytes - markerBytes)}`;
}

function takeUtf8Tail(text: string, maxBytes: number): string {
  const characters = [...text];
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    const nextBytes = utf8ByteLength(characters[start - 1]!);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    start -= 1;
  }
  return characters.slice(start).join("");
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
