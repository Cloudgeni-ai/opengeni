import { formatClockTime } from "../lib/format";
import { formatElapsed } from "./turn-summary-model";
import type { NoticeItem } from "./types";
import { durationBetween } from "./work-presentation";
import { type OpenGeniText } from "../messages/runtime";

/** An approval notice the person has since answered. */
export function noticeIsResolvedApproval(
  item: Pick<NoticeItem, "approval" | "resolvedAt">,
): boolean {
  return Boolean(item.resolvedAt && item.approval);
}

/**
 * A resolved approval notice reads as history, saying what the person
 * decided when the decision is known: "You approved “Send email”."
 */
export function noticeDisplayText(
  t: OpenGeniText,
  item: Pick<NoticeItem, "text" | "approval" | "resolvedAt" | "approvalActions">,
): string {
  if (!noticeIsResolvedApproval(item)) return item.text;
  const actions = item.approvalActions ?? [];
  const decided = actions.filter((action) => action.decision !== undefined);
  // Without every answer (an older or partial replay), say only that it was answered.
  if (decided.length === 0 || decided.length !== actions.length)
    return t("timeline.noticePresentation.youRespondedToThisApproval");
  // Declined by Opengeni rather than the person: never say "You".
  const automatic = decided.filter((action) => action.decision === "automatic_reject").length;
  if (automatic === decided.length) return t("timeline.noticePresentation.declinedAutomatically");
  if (automatic > 0) return t("timeline.noticePresentation.youRespondedToThisApproval");
  const approved = decided.filter((action) => action.decision === "approve").length;
  const rejected = decided.length - approved;
  if (decided.length === 1) {
    const title = decided[0]!.title;
    if (approved === 1)
      return title
        ? t("timeline.noticePresentation.youApprovedTitle", { title })
        : t("timeline.noticePresentation.youApprovedThis");
    return title
      ? t("timeline.noticePresentation.youRejectedTitle", { title })
      : t("timeline.noticePresentation.youRejectedThis");
  }
  if (rejected === 0)
    return t("timeline.noticePresentation.youApprovedActions", { count: approved });
  if (approved === 0)
    return t("timeline.noticePresentation.youRejectedActions", { count: rejected });
  return t("timeline.noticePresentation.youApprovedAndRejected", { approved, rejected });
}

/** Notice pill tone: failures stay red, an open wait keeps the waiting hue. */
export function noticeTone(
  item: Pick<NoticeItem, "tone" | "resolvedAt">,
): "failed" | "waiting" | "neutral" {
  return item.tone === "failed"
    ? "failed"
    : item.tone === "waiting" && !item.resolvedAt
      ? "waiting"
      : "neutral";
}

/**
 * Plain-text summary of a recorded agent wait, as web's quiet disclosure reads
 * it: "Waited for 2 agents · 3m 5s" once later input ended the wait, otherwise
 * "Waiting · since 10:32" (with the date on a later day).
 */
export function recordedWaitSummaryText(
  t: OpenGeniText,
  item: Pick<NoticeItem, "occurredAt" | "waitingAgents" | "waitEndedAt">,
  now: Date = new Date(),
): string {
  const agents = item.waitingAgents ?? 0;
  const waitedMs = item.waitEndedAt
    ? durationBetween(item.occurredAt, item.waitEndedAt)
    : undefined;
  if (waitedMs !== undefined) {
    const elapsed = formatElapsed(t, waitedMs);
    return agents > 0
      ? t("timeline.noticePresentation.waitedForAgentsElapsed", { count: agents, elapsed })
      : t("timeline.noticePresentation.waitedElapsed", { elapsed });
  }
  const started = new Date(item.occurredAt);
  const since =
    started.toDateString() === now.toDateString()
      ? formatClockTime(t, item.occurredAt)
      : started.toLocaleString(t.locale, { dateStyle: "medium", timeStyle: "short" });
  if (item.waitEndedAt)
    return agents > 0
      ? t("timeline.noticePresentation.waitedForAgentsSince", { count: agents, since })
      : t("timeline.noticePresentation.waitedSince", { since });
  return agents > 0
    ? t("timeline.noticePresentation.waitingForAgentsSince", { count: agents, since })
    : t("timeline.noticePresentation.waitingSince", { since });
}
