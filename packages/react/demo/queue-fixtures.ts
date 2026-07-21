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
export type QueueFallbackKind = "whitespace" | "combining" | "zwj";
export type QueueHarnessErrorShape = "unbroken" | "multiline";
export const QUEUE_VISIBILITY_PROBE_KINDS = [
  "short-zwj",
  "variation-selector",
  "word-joiner",
  "bidi-controls",
  "tag-characters",
  "controls",
  "mixed-visible",
] as const;
export type QueueVisibilityProbeKind = (typeof QUEUE_VISIBILITY_PROBE_KINDS)[number];

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

export function queueHarnessError(shape: QueueHarnessErrorShape): string {
  if (shape === "multiline") {
    return [
      "Queue provider returned a multiline diagnostic.",
      ...Array.from(
        { length: 48 },
        (_, index) =>
          `Diagnostic ${String(index + 1).padStart(2, "0")}: https://queue.invalid/${"segment".repeat(80)}?request=fixture-${String(index + 1).padStart(2, "0")}`,
      ),
      "Recovery code: RETRY_SAFE",
    ].join("\n");
  }
  return `QUEUE_ERROR_${"X".repeat(65_536)}_RECOVERY_CODE`;
}

export function queuePromptVisibleIdentity(index: number): string {
  return Array.from(queuePromptFingerprint(index)).slice(-18).join("");
}

export function queueFallbackPrompt(kind: QueueFallbackKind): string {
  switch (kind) {
    case "whitespace":
      return " ".repeat(2_000);
    case "combining":
      return `e${"\u0301".repeat(10_000)}`;
    case "zwj":
      return `👩${"\u200d👩".repeat(1_000)}`;
  }
}

export function queueVisibilityProbePrompt(kind: QueueVisibilityProbeKind): string {
  switch (kind) {
    case "short-zwj":
      return "\u200d".repeat(8);
    case "variation-selector":
      return "\ufe0f".repeat(8);
    case "word-joiner":
      return "\u2060".repeat(8);
    case "bidi-controls":
      return "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    case "tag-characters":
      return String.fromCodePoint(0xe0061, 0xe0062, 0xe0063, 0xe007f);
    case "controls":
      return "\u0000\u0001\u0007\u0008\u000e\u001f\u007f\u0085";
    case "mixed-visible":
      return "\u200d\u2060Visible identity 😀\ufe0f\u2069";
  }
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
