import type { NoticeItem } from "./types";

/** A resolved approval notice reads as history ("Approval was needed."). */
export function noticeDisplayText(item: Pick<NoticeItem, "text" | "resolvedAt">): string {
  return item.resolvedAt && item.text.startsWith("Approval needed")
    ? "Approval was needed."
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
