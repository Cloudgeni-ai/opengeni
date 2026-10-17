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

/** A resolved approval notice reads as history. */
export function noticeDisplayText(
  t: OpenGeniText,
  item: Pick<NoticeItem, "text" | "approval" | "resolvedAt">,
): string {
  return noticeIsResolvedApproval(item)
    ? t("timeline.noticePresentation.youRespondedToThisApproval")
    : item.text;
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
