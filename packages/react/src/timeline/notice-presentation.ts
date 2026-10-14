import { formatClockTime } from "../lib/format";
import { formatElapsed } from "./turn-summary-model";
import type { NoticeItem } from "./types";
import { durationBetween } from "./work-presentation";

/** An approval notice the person has since answered. */
export function noticeIsResolvedApproval(item: Pick<NoticeItem, "text" | "resolvedAt">): boolean {
  return Boolean(item.resolvedAt && item.text.startsWith("Approval needed"));
}

/** A resolved approval notice reads as history. */
export function noticeDisplayText(item: Pick<NoticeItem, "text" | "resolvedAt">): string {
  return noticeIsResolvedApproval(item) ? "You responded to this approval." : item.text;
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
  item: Pick<NoticeItem, "occurredAt" | "waitingAgents" | "waitEndedAt">,
  now: Date = new Date(),
): string {
  const agents = item.waitingAgents ?? 0;
  const target = agents > 0 ? ` for ${agents} ${agents === 1 ? "agent" : "agents"}` : "";
  const waitedMs = item.waitEndedAt
    ? durationBetween(item.occurredAt, item.waitEndedAt)
    : undefined;
  if (waitedMs !== undefined) return `Waited${target} · ${formatElapsed(waitedMs)}`;
  const started = new Date(item.occurredAt);
  const since =
    started.toDateString() === now.toDateString()
      ? formatClockTime(item.occurredAt)
      : started.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return `${item.waitEndedAt ? "Waited" : "Waiting"}${target} · since ${since}`;
}
