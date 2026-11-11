// Agent-answered structured questions are agent work: shared by the web and native timelines.
import type { HumanInputSecretAnswerResult } from "@opengeni/sdk";
import type { HumanInputItem, TimelineItem } from "./types";

/**
 * A settled question that an agent (such as a sub-session's parent) answered or
 * skipped. It is agent work, not conversation: readable turns fold it into that
 * turn's work details as one quiet row, and nothing is drawn on the person's
 * side. Questions a person answered, and expired, cancelled or system-settled
 * ones (a scheduled run's question nobody answered in time), stay in the
 * conversation.
 */
export function isAgentWorkHumanInput(item: TimelineItem): item is HumanInputItem {
  return (
    item.kind === "human-input" &&
    (item.response.outcome === "answered" || item.response.outcome === "skipped") &&
    item.answeredByAgent === true
  );
}

/**
 * The one-line summary of an agent-answered question: "Target branch → main",
 * one pair per question joined by " · ". Secret answers name where the value
 * was saved, never the value.
 */
export function agentWorkHumanInputSummary(
  item: HumanInputItem,
  labels: {
    answered: string;
    skipped: string;
    /** Where a secret answer was saved; never its value. */
    secretSaved: (secret: HumanInputSecretAnswerResult) => string;
  },
): string {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  if (item.response.outcome !== "answered" || item.answers.length === 0) {
    const questions = item.questions
      .map((question) => oneLine(question.label || question.prompt))
      .filter(Boolean)
      .join(" · ");
    const outcome = item.response.outcome === "answered" ? labels.answered : labels.skipped;
    return questions ? `${questions} → ${outcome}` : outcome;
  }
  return item.answers
    .map((answer) => {
      const value = answer.secret
        ? labels.secretSaved(answer.secret)
        : oneLine(answer.values.join(", ")) || labels.answered;
      return `${oneLine(answer.label)} → ${value}`;
    })
    .join(" · ");
}
