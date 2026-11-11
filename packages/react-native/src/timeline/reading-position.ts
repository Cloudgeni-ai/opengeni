/** Keep a reply's beginning readable while it grows, instead of chasing its last line. */
export function answerReadingOffset(input: {
  contentHeight: number;
  viewportHeight: number;
  prompt?: { top: number; bottom: number } | undefined;
  followTail: boolean;
}): number {
  const maximum = Math.max(0, input.contentHeight - input.viewportHeight);
  if (input.followTail || !input.prompt) return maximum;
  // A long prompt or attachment must leave room for the answer too.
  const top = Math.max(input.prompt.top, input.prompt.bottom - input.viewportHeight * 0.35);
  return Math.min(maximum, Math.max(0, top - 12));
}
