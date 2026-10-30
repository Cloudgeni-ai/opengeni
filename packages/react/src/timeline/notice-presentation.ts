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
 * What an approval asked, as history: its question without the question mark
 * or anything after it ("Remove the Gmail connection for anna@example.com?
 * …" → "Remove the Gmail connection for anna@example.com"). A quoted name
 * (“…”) keeps its own punctuation.
 */
export function approvalHistoryTitle(title: string): string {
  let quoted = 0;
  for (let index = 0; index < title.length; index += 1) {
    const char = title[index];
    if (char === "“") quoted += 1;
    else if (char === "”") quoted = Math.max(0, quoted - 1);
    // The question ends at a "?" that ends the title or starts another
    // sentence, so a "?" inside an account name doesn't cut it short.
    else if (char === "?" && quoted === 0 && /^(\s+\p{Lu}|\s*$)/u.test(title.slice(index + 1)))
      return title.slice(0, index).trim();
  }
  return title.trim();
}

type ApprovalAction = NonNullable<NoticeItem["approvalActions"]>[number];

/**
 * "Added: 2 Oct 2026, 10:12 UTC": the first of this action's facts whose
 * value differs from every other alike action's, or undefined when none do.
 */
function tellingFact(action: ApprovalAction, alike: ApprovalAction[]): string | undefined {
  const valueOf = (other: ApprovalAction, label: string) =>
    other.facts?.find((fact) => fact.label === label)?.value;
  const fact = action.facts?.find((candidate) =>
    alike.every((other) => other === action || valueOf(other, candidate.label) !== candidate.value),
  );
  return fact ? `${fact.label}: ${fact.value}` : undefined;
}

/**
 * A resolved approval notice reads as history, saying what the person
 * decided for each action whose answer is known, one line each: "You
 * approved “Remove the Gmail connection for anna@example.com”." Actions it
 * asked about but never got an answer for here (a later wait asked again)
 * are left out. Two that would read the same get the first fact that tells
 * them apart: "(Added: 2 Oct 2026, 10:12 UTC)".
 */
export function noticeDisplayText(
  t: OpenGeniText,
  item: Pick<NoticeItem, "text" | "approval" | "resolvedAt" | "approvalActions">,
): string {
  if (!noticeIsResolvedApproval(item)) return item.text;
  const actions = item.approvalActions ?? [];
  const decided = actions.filter((action) => action.decision !== undefined);
  // Without any answer (an older replay), say only that it was answered.
  if (decided.length === 0) return t("timeline.noticePresentation.youRespondedToThisApproval");
  // Each answered action, by what it asked.
  if (decided.every((action) => action.title)) {
    const titled = decided.map((action) => ({
      action,
      title: approvalHistoryTitle(action.title!),
    }));
    return titled
      .map(({ action, title }) => {
        const alike = titled.filter((other) => other.title === title).map((other) => other.action);
        const detail = alike.length > 1 ? tellingFact(action, alike) : undefined;
        if (detail)
          return action.decision === "approve"
            ? t("timeline.noticePresentation.youApprovedTitleWithDetail", { title, detail })
            : action.decision === "reject"
              ? t("timeline.noticePresentation.youRejectedTitleWithDetail", { title, detail })
              : t("timeline.noticePresentation.declinedAutomaticallyTitleWithDetail", {
                  title,
                  detail,
                });
        return action.decision === "approve"
          ? t("timeline.noticePresentation.youApprovedTitle", { title })
          : action.decision === "reject"
            ? t("timeline.noticePresentation.youRejectedTitle", { title })
            : t("timeline.noticePresentation.declinedAutomaticallyTitle", { title });
      })
      .join("\n");
  }
  // Declined by Opengeni rather than the person: never say "You".
  const automatic = decided.filter((action) => action.decision === "automatic_reject").length;
  if (automatic === decided.length) return t("timeline.noticePresentation.declinedAutomatically");
  if (automatic > 0) return t("timeline.noticePresentation.youRespondedToThisApproval");
  const approved = decided.filter((action) => action.decision === "approve").length;
  const rejected = decided.length - approved;
  if (decided.length === 1)
    return approved === 1
      ? t("timeline.noticePresentation.youApprovedThis")
      : t("timeline.noticePresentation.youRejectedThis");
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
