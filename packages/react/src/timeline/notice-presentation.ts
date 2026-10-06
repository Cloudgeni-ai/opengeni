import type { NoticeItem } from "./types";

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
