import type {
  HumanInputAnswer,
  HumanInputQuestion,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { cn } from "../lib/cn";

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
  minLength: (count: number) => string;
  maxLength: (count: number) => string;
  otherRequired: string;
  minSelections: (count: number) => string;
  maxSelections: (count: number) => string;
};

export const defaultHumanInputFormMessages: HumanInputFormMessages = {
  title: "Your input is needed",
  description: "The agent is paused until you answer these questions.",
  submit: "Continue",
  skip: "Skip",
  submitting: "Submitting…",
  other: "Other",
  deadlineLabel: "Respond before",
  formatDeadline,
  required: "This question is required.",
  minLength: (count) => `Enter at least ${count} characters.`,
  maxLength: (count) => `Enter no more than ${count} characters.`,
  otherRequired: "Enter a value for Other.",
  minSelections: (count) => `Choose at least ${count} option${count === 1 ? "" : "s"}.`,
  maxSelections: (count) => `Choose no more than ${count} option${count === 1 ? "" : "s"}.`,
};

export type HumanInputFormProps = {
  request: Pick<SessionHumanInputRequest, "id" | "questions" | "allowSkip" | "expiresAt">;
  onSubmit: (response: SubmitHumanInputResponseRequest) => void | Promise<void>;
  submitting?: boolean | undefined;
  error?: string | null | undefined;
  title?: ReactNode;
  description?: ReactNode;
  submitLabel?: string | undefined;
  skipLabel?: string | undefined;
  messages?: Partial<HumanInputFormMessages> | undefined;
  autoFocus?: boolean | undefined;
  className?: string | undefined;
};

/**
 * Styled but host-neutral renderer for one structured request. Hosts can use
 * the headless `useHumanInputRequests` hook instead, or replace the title and
 * description while retaining accessible field semantics and validation.
 */
export function HumanInputForm({
  request,
  onSubmit,
  submitting = false,
  error,
  title,
  description,
  submitLabel,
  skipLabel,
  messages: messageOverrides,
  autoFocus = true,
  className,
}: HumanInputFormProps) {
  const messages = { ...defaultHumanInputFormMessages, ...messageOverrides };
  const resolvedTitle = title === undefined ? messages.title : title;
  const resolvedDescription = description === undefined ? messages.description : description;
  const resolvedSubmitLabel = submitLabel ?? messages.submit;
  const resolvedSkipLabel = skipLabel ?? messages.skip;
  const formId = useId();
  const [drafts, setDrafts] = useState<Record<string, HumanInputAnswerDraft>>(() =>
    initialDrafts(request.questions),
  );
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submittingInternally, setSubmittingInternally] = useState(false);
  const submissionInFlight = useRef(false);
  const submissionGeneration = useRef(0);
  const busy = submitting || submittingInternally;

  useEffect(() => {
    submissionGeneration.current += 1;
    submissionInFlight.current = false;
    setDrafts(initialDrafts(request.questions));
    setValidationErrors({});
    setSubmissionError(null);
    setSubmittingInternally(false);
  }, [request.id, request.questions]);

  const update = (
    questionId: string,
    apply: (draft: HumanInputAnswerDraft) => HumanInputAnswerDraft,
  ): void => {
    setDrafts((current) => ({
      ...current,
      [questionId]: apply(current[questionId] ?? emptyDraft()),
    }));
    setValidationErrors((current) => {
      if (!(questionId in current)) return current;
      const next = { ...current };
      delete next[questionId];
      return next;
    });
  };

  const submitResponse = async (response: SubmitHumanInputResponseRequest): Promise<void> => {
    if (busy || submissionInFlight.current) return;
    const generation = submissionGeneration.current;
    submissionInFlight.current = true;
    setSubmissionError(null);
    setSubmittingInternally(true);
    try {
      await onSubmit(response);
    } catch (cause) {
      if (generation === submissionGeneration.current) {
        setSubmissionError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (generation === submissionGeneration.current) {
        submissionInFlight.current = false;
        setSubmittingInternally(false);
      }
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const result = answersFromDrafts(request.questions, drafts, messages);
    if (Object.keys(result.errors).length > 0) {
      setValidationErrors(result.errors);
      return;
    }
    await submitResponse({ outcome: "answered", answers: result.answers });
  };

  return (
    <form
      data-human-input-request={request.id}
      onSubmit={(event) => void submit(event)}
      className={cn(
        "og-root flex w-full flex-col gap-5 rounded-og-lg border border-og-border bg-og-surface-1 p-5 shadow-og-sm",
        className,
      )}
    >
      <header>
        <h2 className="text-og-md font-semibold text-og-fg">{resolvedTitle}</h2>
        {resolvedDescription ? (
          <div className="mt-1 text-og-sm text-og-fg-muted">{resolvedDescription}</div>
        ) : null}
        {request.expiresAt ? (
          <p className="mt-1 text-og-xs text-og-fg-subtle">
            {messages.deadlineLabel}{" "}
            <time dateTime={request.expiresAt}>{messages.formatDeadline(request.expiresAt)}</time>
          </p>
        ) : null}
      </header>

      <fieldset disabled={busy} className="contents">
        {request.questions.map((question, index) => {
          const draft = drafts[question.id] ?? emptyDraft();
          const fieldId = `${formId}-${index}`;
          const errorId = `${fieldId}-error`;
          const helpId = `${fieldId}-help`;
          const describedBy =
            [question.helpText ? helpId : null, validationErrors[question.id] ? errorId : null]
              .filter(Boolean)
              .join(" ") || undefined;
          return (
            <div key={question.id} className="flex flex-col gap-2">
              <label
                htmlFor={question.kind === "text" ? fieldId : undefined}
                className="text-og-base font-medium text-og-fg"
              >
                {question.label ?? question.prompt}
                {question.required ? (
                  <span aria-hidden className="ml-1 text-og-status-failed">
                    *
                  </span>
                ) : null}
              </label>
              {question.label ? (
                <p className="text-og-sm text-og-fg-muted">{question.prompt}</p>
              ) : null}
              {question.helpText ? (
                <p id={helpId} className="text-og-xs text-og-fg-subtle">
                  {question.helpText}
                </p>
              ) : null}
              {question.kind === "text" ? (
                <textarea
                  id={fieldId}
                  value={draft.values[0] ?? ""}
                  onChange={(event) =>
                    update(question.id, (current) => ({
                      ...current,
                      values: event.target.value ? [event.target.value] : [],
                    }))
                  }
                  aria-invalid={Boolean(validationErrors[question.id])}
                  aria-describedby={describedBy}
                  autoFocus={autoFocus && index === 0}
                  rows={3}
                  className="min-h-20 w-full resize-y rounded-og-md border border-og-border bg-og-surface-2 px-3 py-2 text-og-base text-og-fg outline-none placeholder:text-og-fg-subtle focus:border-og-accent"
                />
              ) : (
                <div
                  role={question.kind === "single_select" ? "radiogroup" : "group"}
                  aria-describedby={describedBy}
                  className="flex flex-col gap-2"
                >
                  {question.options.map((option, optionIndex) => {
                    const checked = draft.values.includes(option.id);
                    return (
                      <label
                        key={option.id}
                        className="flex cursor-pointer items-start gap-2 rounded-og-md border border-og-border px-3 py-2 hover:bg-og-surface-2"
                      >
                        <input
                          type={question.kind === "single_select" ? "radio" : "checkbox"}
                          name={question.kind === "single_select" ? fieldId : undefined}
                          autoFocus={autoFocus && index === 0 && optionIndex === 0}
                          checked={checked}
                          onChange={(event) =>
                            update(question.id, (current) => ({
                              ...current,
                              values:
                                question.kind === "single_select"
                                  ? event.target.checked
                                    ? [option.id]
                                    : []
                                  : event.target.checked
                                    ? [...current.values, option.id]
                                    : current.values.filter((value) => value !== option.id),
                              ...(question.kind === "single_select" && event.target.checked
                                ? { otherSelected: false }
                                : {}),
                            }))
                          }
                          className="mt-0.5 accent-og-accent"
                        />
                        <span className="min-w-0">
                          <span className="block text-og-sm font-medium text-og-fg">
                            {option.label}
                          </span>
                          {option.description ? (
                            <span className="block text-og-xs text-og-fg-muted">
                              {option.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                  {question.allowOther ? (
                    <label className="flex items-start gap-2 rounded-og-md border border-og-border px-3 py-2">
                      <input
                        type={question.kind === "single_select" ? "radio" : "checkbox"}
                        name={question.kind === "single_select" ? fieldId : undefined}
                        checked={draft.otherSelected}
                        autoFocus={autoFocus && index === 0 && question.options.length === 0}
                        onChange={(event) =>
                          update(question.id, (current) => ({
                            ...current,
                            otherSelected: event.target.checked,
                            ...(question.kind === "single_select" && event.target.checked
                              ? { values: [] }
                              : {}),
                          }))
                        }
                        className="mt-2 accent-og-accent"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-og-sm font-medium text-og-fg">
                          {messages.other}
                        </span>
                        <input
                          type="text"
                          value={draft.other}
                          disabled={!draft.otherSelected || busy}
                          onChange={(event) =>
                            update(question.id, (current) => ({
                              ...current,
                              other: event.target.value,
                            }))
                          }
                          className="mt-1 w-full rounded-og-sm border border-og-border bg-og-surface-2 px-2 py-1.5 text-og-sm text-og-fg outline-none focus:border-og-accent disabled:opacity-50"
                        />
                      </span>
                    </label>
                  ) : null}
                </div>
              )}
              {validationErrors[question.id] ? (
                <p id={errorId} role="alert" className="text-og-xs text-og-status-failed">
                  {validationErrors[question.id]}
                </p>
              ) : null}
            </div>
          );
        })}
      </fieldset>

      {(error ?? submissionError) ? (
        <p role="alert" className="text-og-sm text-og-status-failed">
          {error ?? submissionError}
        </p>
      ) : null}
      <footer className="flex items-center justify-end gap-2">
        {request.allowSkip ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void submitResponse({ outcome: "skipped" })}
            className="rounded-og-md border border-og-border px-3 py-2 text-og-sm font-medium text-og-fg-muted hover:bg-og-surface-2 disabled:opacity-50"
          >
            {resolvedSkipLabel}
          </button>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="rounded-og-md bg-og-accent px-3 py-2 text-og-sm font-medium text-og-accent-fg hover:bg-og-accent-strong disabled:opacity-50"
        >
          {busy ? messages.submitting : resolvedSubmitLabel}
        </button>
      </footer>
    </form>
  );
}

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
    const other = draft.otherSelected ? draft.other.trim() : "";
    const supplied = values.length + (other ? 1 : 0);
    if (question.required && supplied === 0) {
      errors[question.id] = messages.required;
      continue;
    }
    if (question.kind === "text") {
      const value = values[0] ?? "";
      if (
        value &&
        question.validation?.minLength != null &&
        value.length < question.validation.minLength
      ) {
        errors[question.id] = messages.minLength(question.validation.minLength);
        continue;
      }
      if (question.validation?.maxLength != null && value.length > question.validation.maxLength) {
        errors[question.id] = messages.maxLength(question.validation.maxLength);
        continue;
      }
    } else {
      if (draft.otherSelected && !other) {
        errors[question.id] = messages.otherRequired;
        continue;
      }
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
        ...(other ? { other } : {}),
      });
    }
  }
  return { answers, errors };
}

function initialDrafts(questions: HumanInputQuestion[]): Record<string, HumanInputAnswerDraft> {
  return Object.fromEntries(questions.map((question) => [question.id, emptyDraft()]));
}

function emptyDraft(): HumanInputAnswerDraft {
  return { values: [], other: "", otherSelected: false };
}

function formatDeadline(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
