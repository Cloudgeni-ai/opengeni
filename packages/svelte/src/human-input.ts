import type { HumanInputQuestion, SubmitHumanInputResponseRequest } from "@opengeni/sdk";
import {
  answersFromHumanInputDrafts,
  emptyHumanInputAnswerDraft,
  type HumanInputAnswerDraft,
  type HumanInputValidationMessages,
} from "@opengeni/sdk/session";

export type HumanInputDraft = HumanInputAnswerDraft;

export type HumanInputFormMessages = HumanInputValidationMessages &
  Readonly<{
    title: string;
    submit: string;
    submitting: string;
    skip: string;
    other: string;
    optional: string;
    selectionHint(min: number | null | undefined, max: number | null | undefined): string | null;
  }>;

export const DEFAULT_HUMAN_INPUT_FORM_MESSAGES: HumanInputFormMessages = Object.freeze({
  title: "Input required",
  submit: "Send answers",
  submitting: "Submitting…",
  skip: "Skip",
  other: "Other",
  optional: "Optional",
  required: "This question is required.",
  otherRequired: "Enter a value for Other.",
  minSelections: (count: number) => `Choose at least ${count} option${count === 1 ? "" : "s"}.`,
  maxSelections: (count: number) => `Choose no more than ${count} option${count === 1 ? "" : "s"}.`,
  selectionHint: (min: number | null | undefined, max: number | null | undefined) => {
    if (min != null && max != null) return `Choose ${min}–${max}.`;
    if (min != null) return `Choose at least ${min}.`;
    if (max != null) return `Choose up to ${max}.`;
    return null;
  },
});

export function initialHumanInputDrafts(
  questions: readonly HumanInputQuestion[],
): Record<string, HumanInputDraft> {
  return Object.fromEntries(
    questions.map((question) => [question.id, emptyHumanInputAnswerDraft()]),
  );
}

export function humanInputResponse(
  questions: readonly HumanInputQuestion[],
  drafts: Readonly<Record<string, HumanInputDraft | undefined>>,
  messageOverrides: Partial<HumanInputFormMessages> = {},
): SubmitHumanInputResponseRequest {
  const result = answersFromHumanInputDrafts(questions, drafts, messageOverrides);
  const firstInvalid = questions.find((question) => result.errors[question.id] !== undefined);
  if (firstInvalid) throw new Error(result.errors[firstInvalid.id]);
  return { outcome: "answered", answers: result.answers };
}
