import type { ContextCompactionItem } from "./types";

/**
 * Subtitle for a settled compaction landmark. A definitive provider rejection
 * repeats deterministically for the same conversation, so it names the
 * rejected field and withholds the generic retry promise; every other skip
 * keeps its existing copy.
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
    case "replacement_unchanged":
      return "Checkpoint made no progress";
    case "summarization_failed":
      return providerRejection
        ? `The model provider rejected the compaction request (${describeCompactionProviderRejection(providerRejection)}). Chat history is unchanged. Repeating it fails the same way until the conversation changes; if a new message fails again, start a new session.`
        : "Request it again to retry. Chat history is unchanged.";
    default:
      return "Compaction was not needed. Chat history is unchanged.";
  }
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
