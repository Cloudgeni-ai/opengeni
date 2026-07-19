export const OMITTED_QUEUE_SOURCE_MARKER = "Exact undisclosed middle source marker.";

export const HOSTILE_QUEUE_PROMPT = [
  "# Production migration follow-up 👩🏽‍💻",
  "",
  "Preserve this Markdown and source text exactly; the row itself must remain compact.",
  "",
  "```sh",
  `curl --fail-with-body https://example.test/${"unbroken-token-".repeat(600)}`,
  "```",
  "",
  `Bidirectional source: ${String.fromCodePoint(0x202e)}isolated${String.fromCodePoint(0x202c)}`,
  OMITTED_QUEUE_SOURCE_MARKER,
  ...Array.from(
    { length: 80 },
    (_, index) =>
      `${String(index + 1).padStart(3, "0")} | reconnect-safe log line | Δοκιμή | اختبار | テスト`,
  ),
  "Exact trailing line.",
].join("\n");

export function queuePromptFingerprint(index: number): string {
  return `Queued destination fingerprint: ${String(index + 1).padStart(3, "0")} 😀`;
}

export function queueHarnessPrompt(index: number): string {
  return `${HOSTILE_QUEUE_PROMPT}\n${queuePromptFingerprint(index)}`;
}
