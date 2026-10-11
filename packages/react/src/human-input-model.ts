import type { HumanInputAnswer, HumanInputQuestion } from "@opengeni/sdk";

/* Pure drafting and validation rules for structured human-input requests,
   shared by the web HumanInputForm and non-DOM renderers. */

export type HumanInputAnswerDraft = {
  values: string[];
  other: string;
  otherSelected: boolean;
};

export type HumanInputFormMessages = {
  title: string;
  description: string;
  submit: string;
  skip: string;
  submitting: string;
  other: string;
  deadlineLabel: string;
  formatDeadline: (value: string) => string;
  required: string;
  otherRequired: string;
  minSelections: (count: number) => string;
  maxSelections: (count: number) => string;
  optional: string;
  /** Shown when the question list overflows the card and more content is below. */
  moreBelow: string;
  questionCount: (count: number) => string;
  collapse: string;
  expand: string;
  selectionHint: (min: number | null | undefined, max: number | null | undefined) => string | null;
};

export const defaultHumanInputFormMessages: HumanInputFormMessages = {
  title: "Input required",
  /** Multi-question chrome has no default subtitle; hosts may still override. */
  description: "",
  submit: "Send answers",
  skip: "Skip",
  submitting: "Submitting…",
  other: "Other",
  deadlineLabel: "Expires",
  formatDeadline,
  required: "This question is required.",
  otherRequired: "Enter a value for Other.",
  minSelections: (count) => `Choose at least ${count} option${count === 1 ? "" : "s"}.`,
  maxSelections: (count) => `Choose no more than ${count} option${count === 1 ? "" : "s"}.`,
  optional: "Optional",
  moreBelow: "More below",
  questionCount: (count) => `${count} questions`,
  collapse: "Collapse",
  expand: "Expand",
  selectionHint: (min, max) => {
    if (min != null && max != null) return `Choose ${min}–${max}.`;
    if (min != null) return `Choose at least ${min}.`;
    if (max != null) return `Choose up to ${max}.`;
    return null;
  },
};

export function answersFromDrafts(
  questions: HumanInputQuestion[],
  drafts: Record<string, HumanInputAnswerDraft>,
  messageOverrides: Partial<HumanInputFormMessages> = {},
): { answers: HumanInputAnswer[]; errors: Record<string, string> } {
  const messages = { ...defaultHumanInputFormMessages, ...messageOverrides };
  const answers: HumanInputAnswer[] = [];
  const errors: Record<string, string> = {};
  for (const question of questions) {
    const draft = drafts[question.id] ?? emptyDraft();
    const values = question.kind === "text" ? draft.values.filter(Boolean) : draft.values;
    const other = draft.otherSelected ? draft.other : "";
    const hasOther = Boolean(other.trim());
    const supplied = values.length + (hasOther ? 1 : 0);

    // Other-selected-but-empty must win over generic "required" — otherwise the
    // user sees the wrong diagnosis next to a clearly selected control.
    if (question.kind !== "text" && draft.otherSelected && !hasOther) {
      errors[question.id] = messages.otherRequired;
      continue;
    }

    if (question.required && supplied === 0) {
      errors[question.id] = messages.required;
      continue;
    }
    if (question.kind !== "text") {
      const min = question.validation?.minSelections;
      const max = question.kind === "single_select" ? 1 : question.validation?.maxSelections;
      if (min != null && supplied < min) {
        errors[question.id] = messages.minSelections(min);
        continue;
      }
      if (max != null && supplied > max) {
        errors[question.id] = messages.maxSelections(max);
        continue;
      }
    }
    if (supplied > 0) {
      answers.push({
        questionId: question.id,
        values,
        ...(hasOther ? { other } : {}),
      });
    }
  }
  return { answers, errors };
}

export function initialDrafts(
  questions: HumanInputQuestion[],
): Record<string, HumanInputAnswerDraft> {
  return Object.fromEntries(questions.map((question) => [question.id, emptyDraft()]));
}

export function emptyDraft(): HumanInputAnswerDraft {
  return { values: [], other: "", otherSelected: false };
}

export function formatDeadline(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return "deadline passed";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return date.toLocaleString();
}

/** The form heading: a single question leads with its own label/prompt. */
export function humanInputHeading(
  questions: readonly HumanInputQuestion[],
  messages: Pick<HumanInputFormMessages, "title" | "description">,
): { title: string; description: string | null } {
  const single = questions.length === 1 ? questions[0]! : null;
  return {
    title: single ? (single.label ?? single.prompt) : messages.title,
    description: single
      ? single.label
        ? single.prompt
        : (single.helpText ?? null)
      : messages.description || null,
  };
}
