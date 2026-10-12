import type { ContextCompactionItem } from "./types";

/** Headline for a compaction that could not produce a checkpoint. */
export const COMPACTION_FAILURE_TITLE = "Couldn’t compact conversation history";

/** Why a definitive provider rejection repeats; shown behind Details. */
export const COMPACTION_REJECTION_NOTE =
  "The provider rejects this request the same way until the conversation changes.";

/**
 * Subtitle for a settled compaction landmark. Kept short: a definitive provider
 * rejection withholds the generic retry promise, names the one recovery step,
 * and moves its identifiers behind Details ({@link compactionFailureDetails}).
 */
export function compactionSkipSubtitle(
  reason: string | null,
  providerRejection: ContextCompactionItem["providerRejection"] = null,
): string {
  switch (reason) {
    case "no_history":
      return "No active history to compact";
    case "replacement_not_smaller":
      return "Checkpoint would not reduce memory size";
    case "replacement_exceeds_model_budget":
      return "Checkpoint exceeds this model's context budget. Chat history is unchanged.";
    case "replacement_unchanged":
      return "Checkpoint made no progress";
    case "summarization_failed":
      return providerRejection
        ? "Chat history is unchanged. If your next message fails too, start a new session."
        : "Request it again to retry. Chat history is unchanged.";
    default:
      return "Compaction was not needed. Chat history is unchanged.";
  }
}

export type CompactionFailureDetails = {
  /** One plain sentence on why it failed, when known. */
  note: string | null;
  /** Provider identifiers or the recorded error text, in display order. */
  facts: Array<{ label: string; value: string }>;
};

/**
 * Technical diagnostics for a failed compaction landmark, or null when it has
 * none: a definitive provider rejection lists its content-free identifiers;
 * any other failure shows the turn's recorded error text. Presentation only.
 */
export function compactionFailureDetails(
  item: Pick<ContextCompactionItem, "phase" | "skipReason" | "providerRejection" | "failureDetail">,
): CompactionFailureDetails | null {
  if (item.phase !== "skipped" || item.skipReason !== "summarization_failed") return null;
  const rejection = item.providerRejection;
  if (!rejection) {
    const recorded = item.failureDetail?.trim();
    return recorded ? { note: null, facts: [{ label: "Error", value: recorded }] } : null;
  }
  const facts = [
    {
      label: "Response",
      value: [`HTTP ${rejection.httpStatus}`, rejection.type, rejection.code]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
    },
  ];
  if (rejection.param) facts.push({ label: "Parameter", value: rejection.param });
  if (rejection.requestId) facts.push({ label: "Request ID", value: rejection.requestId });
  return { note: COMPACTION_REJECTION_NOTE, facts };
}

const COMPACTION_TURN_FAILURE_PREFIX = "compaction summarization failed:";

/**
 * Short chip copy for a turn's failure reason. A compaction failure records the
 * raw provider text after a fixed prefix; the chip names the outcome instead
 * and keeps the recorded text as `detail` (a hover title). Every other reason
 * passes through unchanged.
 */
export function presentTurnFailureText(
  failureText: string | null | undefined,
): { summary: string; detail?: string } | null {
  const text = failureText?.trim();
  if (!text) return null;
  if (text.toLowerCase().startsWith(COMPACTION_TURN_FAILURE_PREFIX)) {
    return { summary: COMPACTION_FAILURE_TITLE, detail: text };
  }
  return { summary: text };
}

/** `HTTP 400 invalid_request_error, param input[3].encrypted_content`; identifiers only. */
export function describeCompactionProviderRejection(
  rejection: NonNullable<ContextCompactionItem["providerRejection"]>,
): string {
  const parts = [
    `HTTP ${rejection.httpStatus}${rejection.type ? ` ${rejection.type}` : ""}${
      rejection.code ? ` ${rejection.code}` : ""
    }`,
  ];
  if (rejection.param) parts.push(`param ${rejection.param}`);
  return parts.join(", ");
}
