/**
 * The final response that says "nothing for the person here".
 *
 * A model cannot reliably end a turn with blank output, so silence is an
 * explicit token. Where a turn's answer would be posted or shown (a Slack
 * thread, or a chat that an automation run acted in), a final response of
 * exactly `NO_REPLY` means there is nothing to post or show. Timelines never
 * draw the token itself.
 */
export const NO_REPLY_SENTINEL = "NO_REPLY";

/** Whether model text is the no-reply token, tolerating Markdown wrapping. */
export function isNoReplyText(text: string): boolean {
  const normalized = text.trim().replace(/^[\s`*_"'“”]+|[\s`*_"'“”.!]+$/gu, "");
  return normalized.toUpperCase() === NO_REPLY_SENTINEL;
}

/**
 * Whether text still streaming could become the no-reply token, so a renderer
 * can hold it back instead of flashing "NO_RE…" before the turn goes quiet.
 */
export function mayBecomeNoReplyText(text: string): boolean {
  const normalized = text.trim().replace(/^[\s`*_"'“”]+/gu, "");
  return normalized.length > 0 && NO_REPLY_SENTINEL.startsWith(normalized.toUpperCase());
}
