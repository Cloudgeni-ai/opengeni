import type { ContextCompactionItem } from "./types";
import { type OpenGeniText } from "../messages/runtime";

/** Headline for a compaction that could not produce a checkpoint. */
export const COMPACTION_FAILURE_TITLE = (t: OpenGeniText) =>
  t("timeline.compactionCopy.couldnTCompactConversationHistory");

/**
 * Headline for a compaction cut short by its own attempt's cancellation (for
 * example a worker restarting during a deploy). Not a failure: the recovered
 * attempt checks again and compacts if the history still needs it.
 */
export const COMPACTION_INTERRUPTED_TITLE = (t: OpenGeniText) =>
  t("timeline.compactionCopy.compactionInterrupted");

/** Headline for a settled `skipped` compaction landmark. */
export function compactionSkipTitle(t: OpenGeniText, reason: string | null): string {
  return reason === "interrupted" ? COMPACTION_INTERRUPTED_TITLE(t) : COMPACTION_FAILURE_TITLE(t);
}

/** Why a definitive provider rejection repeats; shown behind Details. */
export const COMPACTION_REJECTION_NOTE = (t: OpenGeniText) =>
  t("timeline.compactionCopy.theProviderRejectsThisRequest");

/**
 * Subtitle for a settled compaction landmark. Kept short: a definitive provider
 * rejection withholds the generic retry promise, names the one recovery step,
 * and moves its identifiers behind Details ({@link compactionFailureDetails}).
 */
export function compactionSkipSubtitle(
  t: OpenGeniText,
  reason: string | null,
  providerRejection: ContextCompactionItem["providerRejection"] = null,
): string {
  switch (reason) {
    case "no_history":
      return t("timeline.compactionCopy.noActiveHistoryToCompact");
    case "replacement_not_smaller":
      return t("timeline.compactionCopy.checkpointWouldNotReduceMemory");
    case "replacement_exceeds_model_budget":
      return t("timeline.compactionCopy.checkpointExceedsThisModelS");
    case "replacement_unchanged":
      return t("timeline.compactionCopy.checkpointMadeNoProgress");
    case "interrupted":
      return t("timeline.compactionCopy.itWillRetryIfStill");
    case "summarization_failed":
      return providerRejection
        ? t("timeline.compactionCopy.chatHistoryIsUnchangedIf")
        : t("timeline.compactionCopy.requestItAgainToRetry");
    default:
      return t("timeline.compactionCopy.compactionWasNotNeededChat");
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
  t: OpenGeniText,
  item: Pick<ContextCompactionItem, "phase" | "skipReason" | "providerRejection" | "failureDetail">,
): CompactionFailureDetails | null {
  if (item.phase !== "skipped" || item.skipReason !== "summarization_failed") return null;
  const rejection = item.providerRejection;
  if (!rejection) {
    const recorded = item.failureDetail?.trim();
    return recorded
      ? { note: null, facts: [{ label: t("timeline.compactionCopy.error"), value: recorded }] }
      : null;
  }
  const facts = [
    {
      label: t("timeline.compactionCopy.response"),
      value: [`HTTP ${rejection.httpStatus}`, rejection.type, rejection.code]
        .filter((part): part is string => Boolean(part))
        .join(" · "),
    },
  ];
  if (rejection.param)
    facts.push({ label: t("timeline.compactionCopy.parameter"), value: rejection.param });
  if (rejection.requestId)
    facts.push({ label: t("timeline.compactionCopy.requestId"), value: rejection.requestId });
  return { note: COMPACTION_REJECTION_NOTE(t), facts };
}

const COMPACTION_TURN_FAILURE_PREFIX = "compaction summarization failed:";

/**
 * Short chip copy for a turn's failure reason. A compaction failure records the
 * raw provider text after a fixed prefix; the chip names the outcome instead
 * and keeps the recorded text as `detail` (a hover title). Every other reason
 * passes through unchanged.
 */
export function presentTurnFailureText(
  t: OpenGeniText,
  failureText: string | null | undefined,
): { summary: string; detail?: string } | null {
  const text = failureText?.trim();
  if (!text) return null;
  if (text.toLowerCase().startsWith(COMPACTION_TURN_FAILURE_PREFIX)) {
    return { summary: COMPACTION_FAILURE_TITLE(t), detail: text };
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
