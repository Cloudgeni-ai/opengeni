export const OMITTED_QUEUE_SOURCE_MARKER = "Exact undisclosed middle source marker.";

export const QUEUE_BOUNDARY_CLUSTERS = {
  zwj: "👩🏽‍💻",
  skinTone: "👍🏽",
  combining: "e\u0301",
  flag: "🇺🇳",
  keycap: "1\uFE0F\u20E3",
} as const;

export type QueueBoundaryCluster = keyof typeof QUEUE_BOUNDARY_CLUSTERS;
export type QueueBoundaryEdge = "head" | "tail";
export type QueueBoundaryMaximum = 180 | 360;

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

/** A prompt whose named grapheme crosses the old code-point-only preview cut. */
export function queueBoundaryPrompt(
  maxCharacters: QueueBoundaryMaximum,
  edge: QueueBoundaryEdge,
  clusterName: QueueBoundaryCluster,
): string {
  const { prefixCharacters, suffixCharacters } = queueBoundaryBudgets(maxCharacters);
  const cluster = QUEUE_BOUNDARY_CLUSTERS[clusterName];
  if (edge === "head") {
    return `${"a".repeat(prefixCharacters - 1)}${cluster}${"x".repeat(
      maxCharacters * 3,
    )}${"z".repeat(suffixCharacters)}`;
  }
  return `${"a".repeat(prefixCharacters)}${"x".repeat(maxCharacters * 3)}${cluster}${"z".repeat(
    suffixCharacters - 1,
  )}`;
}

/** Exact safe summary expected when the boundary grapheme is omitted whole. */
export function queueBoundarySummary(
  maxCharacters: QueueBoundaryMaximum,
  edge: QueueBoundaryEdge,
): string {
  const { prefixCharacters, suffixCharacters } = queueBoundaryBudgets(maxCharacters);
  return edge === "head"
    ? `${"a".repeat(prefixCharacters - 1)} … ${"z".repeat(suffixCharacters)}`
    : `${"a".repeat(prefixCharacters)} … ${"z".repeat(suffixCharacters - 1)}`;
}

function queueBoundaryBudgets(maxCharacters: QueueBoundaryMaximum): {
  prefixCharacters: number;
  suffixCharacters: number;
} {
  const suffixCharacters = maxCharacters === 180 ? 60 : 120;
  return {
    prefixCharacters: maxCharacters - 3 - suffixCharacters,
    suffixCharacters,
  };
}
