// Agent avatar constants shared by the API contracts and the React UI. Kept
// free of zod so browser code can import it without the full contracts index.

/** Curated icon names (the web maps each to a Lucide glyph). */
export const AGENT_AVATAR_ICONS = [
  "bot",
  "bug",
  "mail",
  "git-pull-request",
  "telescope",
  "chart-line",
  "file-text",
  "shield-check",
  "wrench",
  "search",
  "calendar-clock",
  "megaphone",
  "receipt",
  "rocket",
  "database",
  "code",
  "briefcase",
  "book-open",
  "flask-conical",
  "globe",
  "headset",
  "pen-tool",
  "users",
  "sparkles",
] as const;
const AGENT_AVATAR_EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** True when `value` is exactly one user-perceived character that is an emoji. */
export function isSingleAgentAvatarEmoji(value: string): boolean {
  if (!AGENT_AVATAR_EMOJI_PATTERN.test(value)) return false;
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  if (!segmenter) return [...value].length <= 8;
  let count = 0;
  for (const _segment of segmenter.segment(value)) {
    count += 1;
    if (count > 1) return false;
  }
  return count === 1;
}
