import type {
  HumanInputAnswer,
  HumanInputQuestion,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { MessageCircleQuestionIcon } from "lucide-react";
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
  optional: string;
  /** Shown when the question list overflows the card and more content is below. */
  moreBelow: string;
  questionCount: (count: number) => string;
  selectionHint: (min: number | null | undefined, max: number | null | undefined) => string | null;
};

export const defaultHumanInputFormMessages: HumanInputFormMessages = {
  title: "Input required",
  description: "Answer so the agent can continue.",
  submit: "Continue",
  skip: "Skip",
  submitting: "Submitting…",
  other: "Other",
  deadlineLabel: "Expires",
  formatDeadline,
  required: "This question is required.",
  minLength: (count) => `Enter at least ${count} characters.`,
  maxLength: (count) => `Enter no more than ${count} characters.`,
  otherRequired: "Enter a value for Other.",
  minSelections: (count) => `Choose at least ${count} option${count === 1 ? "" : "s"}.`,
  maxSelections: (count) => `Choose no more than ${count} option${count === 1 ? "" : "s"}.`,
  optional: "Optional",
  moreBelow: "More below",
  questionCount: (count) => `${count} questions`,
  selectionHint: (min, max) => {
    if (min != null && max != null) return `Choose ${min}–${max}.`;
    if (min != null) return `Choose at least ${min}.`;
    if (max != null) return `Choose up to ${max}.`;
    return null;
  },
};

export type HumanInputFormProps = {
  request: Pick<SessionHumanInputRequest, "id" | "questions" | "allowSkip" | "expiresAt">;
  onSubmit: (response: SubmitHumanInputResponseRequest) => void | Promise<void>;
  submitting?: boolean | undefined;
  error?: string | null | undefined;
  title?: ReactNode;
  description?: ReactNode;
  /** e.g. "1 of 2" when a host is stepping through parallel requests. */
  progressLabel?: ReactNode;
  submitLabel?: string | undefined;
  skipLabel?: string | undefined;
  messages?: Partial<HumanInputFormMessages> | undefined;
  autoFocus?: boolean | undefined;
  className?: string | undefined;
};

/**
 * Styled but host-neutral renderer for one structured request. Matches the
 * waiting-tone decision language of ApprovalSurface: question-first, compact
 * options, sticky ask/submit chrome. Hosts can replace title/description or
 * use `useHumanInputRequests` headlessly.
 */
export function HumanInputForm({
  request,
  onSubmit,
  submitting = false,
  error,
  title,
  description,
  progressLabel,
  submitLabel,
  skipLabel,
  messages: messageOverrides,
  autoFocus = true,
  className,
}: HumanInputFormProps) {
  const messages = { ...defaultHumanInputFormMessages, ...messageOverrides };
  const singleQuestion = request.questions.length === 1 ? request.questions[0]! : null;
  const resolvedTitle =
    title === undefined
      ? singleQuestion
        ? (singleQuestion.label ?? singleQuestion.prompt)
        : messages.title
      : title;
  const resolvedDescription =
    description === undefined
      ? singleQuestion
        ? singleQuestion.label
          ? singleQuestion.prompt
          : (singleQuestion.helpText ?? null)
        : messages.description
      : description;
  const resolvedSubmitLabel = submitLabel ?? messages.submit;
  const resolvedSkipLabel = skipLabel ?? messages.skip;
  const formId = useId();
  const titleId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState<Record<string, HumanInputAnswerDraft>>(() =>
    initialDrafts(request.questions),
  );
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submittingInternally, setSubmittingInternally] = useState(false);
  const [overflowBelow, setOverflowBelow] = useState(false);
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

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const sync = () => {
      const { scrollTop, scrollHeight, clientHeight } = node;
      setOverflowBelow(
        scrollHeight > clientHeight + 2 && scrollTop + clientHeight < scrollHeight - 4,
      );
    };
    sync();
    node.addEventListener("scroll", sync, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
    observer?.observe(node);
    const content = node.firstElementChild;
    if (content) observer?.observe(content);
    return () => {
      node.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
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

  const focusQuestion = (questionId: string): void => {
    const root = scrollRef.current;
    if (!root) return;
    const block = Array.from(
      root.querySelectorAll<HTMLElement>("[data-human-input-question]"),
    ).find((node) => node.getAttribute("data-human-input-question") === questionId);
    block?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const focusable = block?.querySelector<HTMLElement>(
      "input:not([type='hidden']):not([disabled]), textarea:not([disabled])",
    );
    focusable?.focus({ preventScroll: true });
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const result = answersFromDrafts(request.questions, drafts, messages);
    if (Object.keys(result.errors).length > 0) {
      setValidationErrors(result.errors);
      const firstInvalid = request.questions.find((question) => question.id in result.errors);
      if (firstInvalid) {
        // After paint so aria-invalid / error text exist under the question.
        requestAnimationFrame(() => focusQuestion(firstInvalid.id));
      }
      return;
    }
    await submitResponse({ outcome: "answered", answers: result.answers });
  };

  return (
    <form
      data-human-input-request={request.id}
      onSubmit={(event) => void submit(event)}
      aria-labelledby={titleId}
      className={cn(
        "og-root flex max-h-[min(28rem,50dvh)] w-full flex-col overflow-hidden rounded-og-lg border border-og-status-waiting/35 bg-og-status-waiting/5 shadow-og-sm",
        className,
      )}
    >
      <header className="shrink-0 border-b border-og-status-waiting/20 px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-og-md bg-og-status-waiting/12 text-og-status-waiting">
            <MessageCircleQuestionIcon aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <h2 id={titleId} className="text-og-md font-semibold text-og-fg">
                {resolvedTitle}
                {singleQuestion?.required && !request.allowSkip ? (
                  <span aria-hidden className="ml-1 text-og-status-failed">
                    *
                  </span>
                ) : null}
              </h2>
              {progressLabel ? (
                <span className="text-og-xs font-medium text-og-status-waiting">
                  {progressLabel}
                </span>
              ) : null}
              {!singleQuestion ? (
                <span className="text-og-xs font-medium text-og-fg-subtle">
                  {messages.questionCount(request.questions.length)}
                </span>
              ) : null}
            </div>
            {resolvedDescription ? (
              <div className="mt-0.5 text-og-sm text-og-fg-muted">{resolvedDescription}</div>
            ) : null}
            {request.expiresAt ? (
              <p className="mt-1 text-og-xs text-og-fg-subtle">
                {messages.deadlineLabel}{" "}
                <time
                  dateTime={request.expiresAt}
                  title={new Date(request.expiresAt).toLocaleString()}
                >
                  {messages.formatDeadline(request.expiresAt)}
                </time>
              </p>
            ) : null}
            {request.allowSkip && singleQuestion ? (
              <p className="mt-1 text-og-xs text-og-fg-subtle">Or skip and let the agent decide.</p>
            ) : null}
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="h-full min-h-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        >
          <fieldset disabled={busy} className="space-y-4 px-4 py-3">
            {request.questions.map((question, index) => {
              if (singleQuestion) {
                // Title already carries the question; only render the control + help extras.
                return (
                  <div key={question.id} data-human-input-question={question.id}>
                    <QuestionControls
                      question={question}
                      draft={drafts[question.id] ?? emptyDraft()}
                      fieldId={`${formId}-${index}`}
                      error={validationErrors[question.id]}
                      messages={messages}
                      autoFocus={autoFocus}
                      firstOption
                      showPromptChrome={false}
                      allowSkip={request.allowSkip}
                      busy={busy}
                      onUpdate={(apply) => update(question.id, apply)}
                    />
                  </div>
                );
              }
              return (
                <div
                  key={question.id}
                  data-human-input-question={question.id}
                  className="flex flex-col gap-1.5"
                >
                  <QuestionControls
                    question={question}
                    draft={drafts[question.id] ?? emptyDraft()}
                    fieldId={`${formId}-${index}`}
                    error={validationErrors[question.id]}
                    messages={messages}
                    autoFocus={autoFocus && index === 0}
                    firstOption={index === 0}
                    showPromptChrome
                    allowSkip={request.allowSkip}
                    busy={busy}
                    onUpdate={(apply) => update(question.id, apply)}
                  />
                </div>
              );
            })}
          </fieldset>
        </div>
        {overflowBelow ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center"
            aria-hidden="true"
          >
            <div className="h-10 w-full bg-gradient-to-t from-og-surface-1 via-og-surface-1/80 to-transparent" />
            <span className="-mt-5 mb-1 rounded-og-full bg-og-surface-1 px-2.5 py-0.5 text-og-xs font-medium text-og-fg-muted shadow-og-sm ring-1 ring-og-border/60">
              {messages.moreBelow}
            </span>
          </div>
        ) : null}
      </div>

      {(error ?? submissionError) ? (
        <p
          role="alert"
          className="relative z-10 shrink-0 px-4 pb-1 text-og-sm text-og-status-failed"
        >
          {error ?? submissionError}
        </p>
      ) : null}

      <footer className="relative z-10 flex shrink-0 items-center justify-end gap-2 border-t border-og-status-waiting/20 bg-og-surface-1/95 px-4 py-3 backdrop-blur-[2px]">
        {request.allowSkip ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void submitResponse({ outcome: "skipped" })}
            className="inline-flex min-h-9 items-center rounded-og-md border border-og-border px-3 py-1.5 text-og-sm font-medium text-og-fg-muted transition-colors hover:bg-og-surface-1 hover:text-og-fg disabled:opacity-50"
          >
            {resolvedSkipLabel}
          </button>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="inline-flex min-h-9 items-center rounded-og-md bg-og-accent px-3 py-1.5 text-og-sm font-medium text-og-accent-fg transition-colors hover:bg-og-accent-strong disabled:opacity-50"
        >
          {busy ? messages.submitting : resolvedSubmitLabel}
        </button>
      </footer>
    </form>
  );
}

function QuestionControls({
  question,
  draft,
  fieldId,
  error,
  messages,
  autoFocus,
  firstOption,
  showPromptChrome,
  allowSkip,
  busy,
  onUpdate,
}: {
  question: HumanInputQuestion;
  draft: HumanInputAnswerDraft;
  fieldId: string;
  error: string | undefined;
  messages: HumanInputFormMessages;
  autoFocus: boolean;
  firstOption: boolean;
  showPromptChrome: boolean;
  allowSkip: boolean;
  busy: boolean;
  onUpdate: (apply: (draft: HumanInputAnswerDraft) => HumanInputAnswerDraft) => void;
}) {
  const errorId = `${fieldId}-error`;
  const helpId = `${fieldId}-help`;
  const hint =
    question.kind === "multi_select"
      ? messages.selectionHint(
          question.validation?.minSelections,
          question.validation?.maxSelections,
        )
      : null;
  const describedBy =
    [
      question.helpText && showPromptChrome ? helpId : null,
      hint ? `${fieldId}-hint` : null,
      error ? errorId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const useSingleLine =
    question.kind === "text" &&
    question.validation?.maxLength != null &&
    question.validation.maxLength <= 160;

  return (
    <>
      {showPromptChrome ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <label
              htmlFor={question.kind === "text" ? fieldId : undefined}
              className="text-og-sm font-medium text-og-fg"
            >
              {question.label ?? question.prompt}
              {question.required && !allowSkip ? (
                <span aria-hidden className="ml-1 text-og-status-failed">
                  *
                </span>
              ) : !question.required ? (
                <span className="ml-1.5 text-og-xs font-normal text-og-fg-subtle">
                  {messages.optional}
                </span>
              ) : null}
            </label>
          </div>
          {question.label ? <p className="text-og-sm text-og-fg-muted">{question.prompt}</p> : null}
          {question.helpText ? (
            <p id={helpId} className="text-og-xs text-og-fg-subtle">
              {question.helpText}
            </p>
          ) : null}
          {hint ? (
            <p id={`${fieldId}-hint`} className="text-og-xs text-og-fg-subtle">
              {hint}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {!question.required && allowSkip === false ? (
            <p className="text-og-xs text-og-fg-subtle">{messages.optional}</p>
          ) : null}
          {question.helpText && question.label ? (
            <p id={helpId} className="mb-1.5 text-og-xs text-og-fg-subtle">
              {question.helpText}
            </p>
          ) : null}
          {hint ? (
            <p id={`${fieldId}-hint`} className="mb-1.5 text-og-xs text-og-fg-subtle">
              {hint}
            </p>
          ) : null}
        </>
      )}

      {question.kind === "text" ? (
        useSingleLine ? (
          <input
            id={fieldId}
            type="text"
            value={draft.values[0] ?? ""}
            onChange={(event) =>
              onUpdate((current) => ({
                ...current,
                values: event.target.value ? [event.target.value] : [],
              }))
            }
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            autoFocus={autoFocus}
            className="w-full rounded-og-md border border-og-border bg-og-surface-1 px-3 py-2 text-og-sm text-og-fg outline-none placeholder:text-og-fg-subtle focus:border-og-accent"
          />
        ) : (
          <textarea
            id={fieldId}
            value={draft.values[0] ?? ""}
            onChange={(event) =>
              onUpdate((current) => ({
                ...current,
                values: event.target.value ? [event.target.value] : [],
              }))
            }
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            autoFocus={autoFocus}
            rows={2}
            className="min-h-14 w-full resize-y rounded-og-md border border-og-border bg-og-surface-1 px-3 py-2 text-og-sm text-og-fg outline-none placeholder:text-og-fg-subtle focus:border-og-accent"
          />
        )
      ) : (
        <div
          role={question.kind === "single_select" ? "radiogroup" : "group"}
          aria-describedby={describedBy}
          className="flex flex-col gap-0.5"
        >
          {question.options.map((option, optionIndex) => {
            const checked = draft.values.includes(option.id);
            return (
              <label
                key={option.id}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-og-md px-2.5 py-2 transition-colors",
                  checked
                    ? "bg-og-status-waiting/12 text-og-fg"
                    : "text-og-fg hover:bg-og-surface-1/80",
                )}
              >
                <input
                  type={question.kind === "single_select" ? "radio" : "checkbox"}
                  name={question.kind === "single_select" ? fieldId : undefined}
                  autoFocus={autoFocus && firstOption && optionIndex === 0}
                  checked={checked}
                  onChange={(event) =>
                    onUpdate((current) => ({
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
                  <span className="block text-og-sm font-medium">{option.label}</span>
                  {option.description ? (
                    <span className="mt-0.5 block text-og-xs text-og-fg-muted">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
          {question.allowOther ? (
            <label
              className={cn(
                "flex items-start gap-2.5 rounded-og-md px-2.5 py-2 transition-colors",
                draft.otherSelected
                  ? "bg-og-status-waiting/12 text-og-fg"
                  : "text-og-fg hover:bg-og-surface-1/80",
              )}
            >
              <input
                type={question.kind === "single_select" ? "radio" : "checkbox"}
                name={question.kind === "single_select" ? fieldId : undefined}
                checked={draft.otherSelected}
                autoFocus={autoFocus && firstOption && question.options.length === 0}
                onChange={(event) =>
                  onUpdate((current) => ({
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
                <span className="block text-og-sm font-medium">{messages.other}</span>
                <input
                  type="text"
                  value={draft.other}
                  disabled={!draft.otherSelected || busy}
                  placeholder="Type a value…"
                  onChange={(event) =>
                    onUpdate((current) => ({
                      ...current,
                      other: event.target.value,
                    }))
                  }
                  className="mt-1.5 w-full rounded-og-sm border border-og-border bg-og-surface-1 px-2 py-1.5 text-og-sm text-og-fg outline-none focus:border-og-accent disabled:opacity-50"
                />
              </span>
            </label>
          ) : null}
        </div>
      )}
      {error ? (
        <p id={errorId} role="alert" className="text-og-xs text-og-status-failed">
          {error}
        </p>
      ) : null}
    </>
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

    // Other-selected-but-empty must win over generic "required" — otherwise the
    // user sees the wrong diagnosis next to a clearly selected control.
    if (question.kind !== "text" && draft.otherSelected && !other) {
      errors[question.id] = messages.otherRequired;
      continue;
    }

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
