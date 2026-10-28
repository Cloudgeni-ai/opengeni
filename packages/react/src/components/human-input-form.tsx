import type {
  HumanInputAnswer,
  HumanInputQuestion,
  HumanInputSecretAnswer,
  HumanInputSecretSaveTo,
  HumanInputSecretSpec,
  SkillRecord,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, MessageCircleQuestionIcon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";
import { useErrorMessage } from "../lib/error-message";
import {
  answersFromDrafts,
  choiceOffersOther,
  defaultHumanInputFormMessages,
  humanInputAgentMayDecide,
  mergeHumanInputFormMessages,
  emptyDraft,
  initialDrafts,
  secretAnswerFromReading,
  type HumanInputAnswerDraft,
  type HumanInputFormMessages,
} from "../human-input-model";
import {
  forgetHumanInputDraft,
  readHumanInputDraft,
  writeHumanInputDraft,
  type HumanInputDraftScope,
} from "../human-input-draft-store";
import { SecretQuestionField, type SecretFieldHandle } from "./secret-question-field";
import {
  DecisionActions,
  DecisionButton,
  DecisionMark,
  decisionCardClass,
  decisionCardPad,
} from "./decision-card";
import { InlineMarkdown } from "./markdown";
import { useOpenGeniText } from "../messages/runtime";

export {
  answersFromDrafts,
  defaultHumanInputFormMessages,
  type HumanInputAnswerDraft,
  type HumanInputFormMessages,
};

class SkillReviewVerificationError extends Error {}

export type HumanInputFormProps = {
  /** Scoped immutable revision reader. Saving a Skill fails closed without its full preview. */
  loadSkillReview?:
    | ((reference: NonNullable<HumanInputQuestion["skillReview"]>) => Promise<SkillRecord>)
    | undefined;
  /**
   * With `workspaceId` and `sessionId` (as on a full pending request), unsent
   * non-secret answers are kept per browser tab and restored when the card
   * mounts again, e.g. after visiting Settings and coming back.
   */
  request: Pick<SessionHumanInputRequest, "id" | "questions" | "allowSkip" | "expiresAt"> &
    Partial<Pick<SessionHumanInputRequest, "workspaceId" | "sessionId" | "status" | "origin">>;
  /**
   * Resolve only once the response was accepted: the form then forgets the
   * unsent draft and clears secret fields. Reject when sending failed so the
   * card keeps what was typed for a retry.
   */
  onSubmit: (response: SubmitHumanInputResponseRequest) => void | Promise<void>;
  submitting?: boolean | undefined;
  error?: string | null | undefined;
  title?: ReactNode;
  description?: ReactNode;
  /** e.g. "1 of 2" when a host is stepping through parallel requests. */
  progressLabel?: ReactNode;
  submitLabel?: string | undefined;
  skipLabel?: string | undefined;
  /**
   * "Let the agent decide", offered on every ordinary question (never on a
   * secret, a Skill review or a secret approval) in place of Skip. By default
   * it settles the request with `{ outcome: "skipped", agentDecides: true }`,
   * so the asking agent makes its own best choice. A host can hand the
   * question to another agent instead (a sub-session's parent); resolve once
   * that was sent. `false` hides the action.
   */
  onLetAgentDecide?: (() => void | Promise<void>) | false | undefined;
  /** An agent was asked to decide: the action is replaced by a note; answering still works. */
  agentDeciding?: boolean | undefined;
  messages?: Partial<HumanInputFormMessages> | undefined;
  autoFocus?: boolean | undefined;
  /** Start collapsed to a compact bar (drafts still retained). */
  defaultCollapsed?: boolean | undefined;
  /**
   * Answer a yes/no decision (one required choice between an accept and a
   * decline option, without Other) with two buttons instead of a radio list.
   * Off by default; embedded conversations turn it on.
   */
  decisionButtons?: boolean | undefined;
  /**
   * Where this person may save an answer to a secret question. A request for
   * a target outside this list falls back to the most private allowed one,
   * with a note. Defaults to Only me, This task and This workspace.
   */
  allowedSaveTo?: readonly HumanInputSecretSaveTo[] | undefined;
  className?: string | undefined;
};

/**
 * Styled but host-neutral renderer for one structured request. Matches the
 * waiting-tone decision language of ApprovalSurface: question-first, compact
 * options, sticky ask/submit chrome. Hosts can replace title/description or
 * use `useHumanInputRequests` headlessly.
 */
export function HumanInputForm(props: HumanInputFormProps) {
  // The pending-request read model is refreshed after session events and
  // returns newly allocated question arrays for the same durable request.
  // Key the state owner by that request's lifecycle identity so reconciliation
  // cannot erase an answer that the operator is still typing.
  return <HumanInputRequestForm key={props.request.id} {...props} />;
}

function HumanInputRequestForm({
  request,
  onSubmit,
  loadSkillReview,
  submitting = false,
  error,
  title,
  description,
  progressLabel,
  submitLabel,
  skipLabel,
  onLetAgentDecide,
  agentDeciding = false,
  messages: messageOverrides,
  autoFocus = true,
  defaultCollapsed = false,
  decisionButtons = false,
  allowedSaveTo,
  className,
}: HumanInputFormProps) {
  const t = useOpenGeniText();
  const formatError = useErrorMessage();
  const messages = mergeHumanInputFormMessages(defaultHumanInputFormMessages(t), messageOverrides);
  const singleQuestion = request.questions.length === 1 ? request.questions[0]! : null;
  // Several questions are asked one at a time; every step stays mounted (hidden)
  // so typed secrets and drafts survive moving back and forth.
  const multi = request.questions.length > 1;
  const lastStep = request.questions.length - 1;
  const [step, setStep] = useState(0);
  const stepQuestion = request.questions[Math.min(step, Math.max(0, lastStep))] ?? null;
  const headerQuestion = singleQuestion ?? (multi ? stepQuestion : null);
  const decision = binaryDecision(request.questions, { inferFromLabels: decisionButtons });
  const [decisionChoice, setDecisionChoice] = useState<string | null>(null);
  // Agent-written question text renders as inline Markdown; host-provided
  // titles and messages render as given.
  const questionTitle =
    title === undefined && headerQuestion ? (headerQuestion.label ?? headerQuestion.prompt) : null;
  const questionDescription =
    description === undefined && headerQuestion && questionTitle !== null
      ? headerQuestion.label
        ? headerQuestion.prompt
        : (headerQuestion.helpText ?? null)
      : null;
  /** The heading asks the current question; the body holds only its answer. */
  const headerCarriesQuestion = questionTitle !== null;
  const resolvedTitle =
    questionTitle !== null ? (
      <InlineMarkdown>{questionTitle}</InlineMarkdown>
    ) : title === undefined ? (
      messages.title
    ) : (
      title
    );
  const resolvedDescription = questionDescription ? (
    <InlineMarkdown>{questionDescription}</InlineMarkdown>
  ) : description === undefined ? (
    headerCarriesQuestion ? null : (
      messages.description || null
    )
  ) : (
    description
  );
  const resolvedSubmitLabel =
    submitLabel ?? (multi ? messages.submit : (messages.submitOne ?? messages.submit));
  const resolvedSkipLabel = skipLabel ?? messages.skip;
  const formId = useId();
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const draftScope = useMemo<HumanInputDraftScope | null>(
    () =>
      request.workspaceId && request.sessionId
        ? { workspaceId: request.workspaceId, sessionId: request.sessionId, requestId: request.id }
        : null,
    [request.id, request.sessionId, request.workspaceId],
  );
  const requestSettled = request.status !== undefined && request.status !== "pending";
  const [drafts, setDrafts] = useState<Record<string, HumanInputAnswerDraft>>(() => ({
    ...initialDrafts(request.questions),
    ...(draftScope && !requestSettled ? readHumanInputDraft(draftScope, request) : null),
  }));
  // Once a response is accepted, nothing typed afterwards becomes a draft again.
  const draftClosed = useRef(false);
  // Mounting (or StrictMode's second mount) is not an edit: rewriting the
  // restored draft would refresh its age and let it outlive a pending-list
  // read that already settled it.
  const mountedDrafts = useRef(drafts);
  const questionsRef = useRef(request.questions);
  questionsRef.current = request.questions;
  useEffect(() => {
    if (!draftScope) return;
    if (requestSettled) {
      draftClosed.current = true;
      forgetHumanInputDraft(draftScope);
      return;
    }
    if (draftClosed.current || drafts === mountedDrafts.current) return;
    writeHumanInputDraft(draftScope, questionsRef.current, drafts);
  }, [draftScope, drafts, requestSettled]);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [submittingInternally, setSubmittingInternally] = useState(false);
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const submissionInFlight = useRef(false);
  const submissionGeneration = useRef(0);
  // Secret answers stay in their uncontrolled inputs until submit.
  const secretHandles = useRef(new Map<string, SecretFieldHandle>());
  const secretRegistrars = useMemo(
    () => new Map<string, (handle: SecretFieldHandle | null) => void>(),
    [],
  );
  const registerSecret = useCallback(
    (questionId: string) => {
      let registrar = secretRegistrars.get(questionId);
      if (!registrar) {
        registrar = (handle) => {
          if (handle) secretHandles.current.set(questionId, handle);
          else secretHandles.current.delete(questionId);
        };
        secretRegistrars.set(questionId, registrar);
      }
      return registrar;
    },
    [secretRegistrars],
  );
  const busy = submitting || submittingInternally;
  const reviewIdentity = JSON.stringify(
    request.questions
      .filter((question) => question.skillReview)
      .map((question) => ({
        id: question.id,
        reference: {
          sourceOperationId: question.skillReview!.sourceOperationId,
          skillId: question.skillReview!.skillId,
          revisionId: question.skillReview!.revisionId,
          expectedRevisionId: question.skillReview!.expectedRevisionId,
          expectedScopeVersion: question.skillReview!.expectedScopeVersion,
          ...(question.skillReview!.removalOperationId
            ? { removalOperationId: question.skillReview!.removalOperationId }
            : {}),
        },
      })),
  );
  const [reviewReload, setReviewReload] = useState(0);
  const [reviews, setReviews] = useState<{
    loader: typeof loadSkillReview;
    identity: string;
    records: Record<string, SkillRecord>;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    let current = true;
    const questions = JSON.parse(reviewIdentity) as Array<{
      id: string;
      reference: NonNullable<HumanInputQuestion["skillReview"]>;
    }>;
    if (!questions.length) return;
    setReviews(null);
    void Promise.all(
      questions.map(async (question) => {
        if (!loadSkillReview) throw new Error(t("humanInputForm.thisClientCannotPreviewSkill"));
        const reference = question.reference;
        const record = await loadSkillReview(reference);
        if (
          record.id !== reference.skillId ||
          record.revisionId !== reference.revisionId ||
          (record.removalOperationId ?? undefined) !== reference.removalOperationId ||
          !record.files.some((file) => file.path === "SKILL.md")
        ) {
          throw new SkillReviewVerificationError(
            t("humanInputForm.theRequestedSkillRevisionCould"),
          );
        }
        return [question.id, record] as const;
      }),
    )
      .then((records) => {
        if (current)
          setReviews({
            loader: loadSkillReview,
            identity: reviewIdentity,
            records: Object.fromEntries(records),
            error: null,
          });
      })
      .catch((cause) => {
        if (current)
          setReviews({
            loader: loadSkillReview,
            identity: reviewIdentity,
            records: {},
            error: formatError(
              cause,
              cause instanceof SkillReviewVerificationError
                ? cause.message
                : !loadSkillReview
                  ? t("humanInputForm.thisClientCannotPreviewSkill")
                  : undefined,
            ),
          });
      });
    return () => {
      current = false;
    };
  }, [loadSkillReview, reviewIdentity, reviewReload, formatError, t]);
  const visibleReviews =
    reviews?.loader === loadSkillReview && reviews?.identity === reviewIdentity ? reviews : null;
  const preview = (question: HumanInputQuestion) => {
    if (!question.skillReview) return null;
    const record = visibleReviews?.records[question.id];
    return (
      <div className="mb-3 min-w-0 space-y-2" data-skill-review="">
        {record ? (
          <>
            <p className="text-og-sm">
              {record.title ?? t("humanInputForm.skill")}{" "}
              {t("humanInputForm.scopeLengthFiles", {
                scope: record.scope,
                length: record.files.length,
              })}
            </p>
            <p className="text-og-xs text-og-fg-muted">
              {question.skillReview.removalOperationId
                ? t("humanInputForm.permanentlyDeletesThisSkillAnd")
                : t("humanInputForm.savingActivatesTheseExactFiles")}
            </p>
            {record.files.map((file) => (
              <details key={file.path} open={file.path === "SKILL.md"}>
                <summary className="cursor-pointer break-all text-og-sm">{file.path}</summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-og-md bg-og-surface-1 p-2 text-og-xs">
                  {file.content}
                </pre>
              </details>
            ))}
          </>
        ) : visibleReviews?.error ? (
          <>
            <p role="alert" className="text-og-sm">
              {visibleReviews.error}
            </p>
            <button type="button" onClick={() => setReviewReload((value) => value + 1)}>
              {t("humanInputForm.retryPreview")}
            </button>
          </>
        ) : (
          <p role="status" className="text-og-sm">
            {t("humanInputForm.loadingTheExactSkillFiles")}
          </p>
        )}
      </div>
    );
  };

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

  const clearValidationError = (questionId: string): void =>
    setValidationErrors((current) => {
      if (!(questionId in current)) return current;
      const next = { ...current };
      delete next[questionId];
      return next;
    });

  /** Resolves true when the host accepted the response. */
  const submitResponse = async (response: SubmitHumanInputResponseRequest): Promise<boolean> => {
    if (busy || submissionInFlight.current) return false;
    const generation = submissionGeneration.current;
    submissionInFlight.current = true;
    setSubmissionError(null);
    setSubmittingInternally(true);
    try {
      await onSubmit(response);
      if (draftScope) {
        draftClosed.current = true;
        forgetHumanInputDraft(draftScope);
      }
      return true;
    } catch (cause) {
      if (generation === submissionGeneration.current) {
        setSubmissionError(formatError(cause));
      }
      return false;
    } finally {
      if (generation === submissionGeneration.current) {
        submissionInFlight.current = false;
        setSubmittingInternally(false);
      }
    }
  };

  const focusQuestion = (questionId: string): void => {
    const root = bodyRef.current;
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

  /** The validation error for one question's current answer, if any. */
  const questionError = (question: HumanInputQuestion): string | null => {
    if (question.kind === "secret") {
      const handle = secretHandles.current.get(question.id);
      if (!handle) return null;
      const secret = secretAnswerFromReading(t, question, handle.read(), messages);
      return secret && "error" in secret ? secret.error : null;
    }
    return answersFromDrafts(t, [question], drafts, messages).errors[question.id] ?? null;
  };

  const goToStep = (next: number): void => {
    const target = request.questions[next];
    if (!target) return;
    setStep(next);
    // After paint, once the step is visible.
    requestAnimationFrame(() => focusQuestion(target.id));
  };

  const nextStep = (): void => {
    if (!stepQuestion) return;
    const stepProblem = questionError(stepQuestion);
    if (stepProblem) {
      setValidationErrors((current) => ({ ...current, [stepQuestion.id]: stepProblem }));
      requestAnimationFrame(() => focusQuestion(stepQuestion.id));
      return;
    }
    goToStep(step + 1);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    // Enter (or the primary button) on an earlier step moves on instead of sending.
    if (multi && step < lastStep) {
      nextStep();
      return;
    }
    const result = answersFromDrafts(t, request.questions, drafts, messages);
    const secretAnswers: HumanInputSecretAnswer[] = [];
    const secretPublicAnswers = new Map<string, HumanInputAnswer>();
    for (const question of request.questions) {
      if (question.kind !== "secret") continue;
      const handle = secretHandles.current.get(question.id);
      if (!handle) continue;
      const secret = secretAnswerFromReading(t, question, handle.read(), messages);
      if (!secret) continue;
      if ("error" in secret) {
        result.errors[question.id] = secret.error;
        continue;
      }
      secretAnswers.push(secret.secretAnswer);
      secretPublicAnswers.set(question.id, secret.answer);
    }
    if (Object.keys(result.errors).length > 0) {
      setValidationErrors(result.errors);
      const firstInvalid = request.questions.find((question) => question.id in result.errors);
      if (firstInvalid) {
        setStep(request.questions.indexOf(firstInvalid));
        // After paint so aria-invalid / error text exist under the question.
        requestAnimationFrame(() => focusQuestion(firstInvalid.id));
      }
      return;
    }
    const unreviewedSave = request.questions.find(
      (question) =>
        question.skillReview &&
        !visibleReviews?.records[question.id] &&
        result.answers.some(
          (answer) => answer.questionId === question.id && answer.values.includes("save"),
        ),
    );
    if (unreviewedSave) {
      setStep(request.questions.indexOf(unreviewedSave));
      setValidationErrors({
        [unreviewedSave.id]: unreviewedSave.skillReview?.removalOperationId
          ? t("humanInputForm.loadTheExactSkillProposal")
          : t("humanInputForm.loadTheExactSkillFiles"),
      });
      return;
    }
    // Keep the request's question order across drafted and secret answers.
    const drafted = new Map(result.answers.map((answer) => [answer.questionId, answer]));
    const answers = request.questions.flatMap((question) => {
      const answer = drafted.get(question.id) ?? secretPublicAnswers.get(question.id);
      return answer ? [answer] : [];
    });
    const accepted = await submitResponse({
      outcome: "answered",
      answers,
      ...(secretAnswers.length > 0 ? { secretAnswers } : {}),
    });
    if (accepted) for (const handle of secretHandles.current.values()) handle.clear();
  };

  const stepLabel = multi
    ? t("humanInputForm.questionOfTotal", { current: step + 1, total: request.questions.length })
    : null;
  const metaBits = [
    progressLabel,
    stepLabel,
    request.expiresAt ? (
      <>
        {messages.deadlineLabel}{" "}
        <time
          dateTime={request.expiresAt}
          title={new Date(request.expiresAt).toLocaleString(t.locale)}
        >
          {messages.formatDeadline(request.expiresAt)}
        </time>
      </>
    ) : null,
  ].filter(Boolean);
  const meta =
    metaBits.length > 0
      ? metaBits.map((bit, index) => (
          // Positional facts of one line; a deadline is markup, not text.
          // oxlint-disable-next-line react/no-array-index-key -- fixed positions
          <Fragment key={index}>
            {index > 0 ? " · " : null}
            {bit}
          </Fragment>
        ))
      : null;
  const errorText = error ?? submissionError;
  const agentMayDecide = onLetAgentDecide !== false && humanInputAgentMayDecide(request);
  const [delegating, setDelegating] = useState(false);
  const letAgentDecide = async (): Promise<void> => {
    if (busy || delegating) return;
    if (typeof onLetAgentDecide !== "function") {
      await submitResponse({ outcome: "skipped", agentDecides: true });
      return;
    }
    setSubmissionError(null);
    setDelegating(true);
    try {
      await onLetAgentDecide();
    } catch (cause) {
      setSubmissionError(formatError(cause));
    } finally {
      setDelegating(false);
    }
  };
  const skipButton = agentMayDecide ? (
    agentDeciding ? (
      <p
        role="status"
        className="m-0 inline-flex min-h-9 items-center gap-1.5 text-og-sm text-og-fg-muted"
        data-human-input-agent-deciding=""
      >
        <span aria-hidden="true" className="size-1.5 rounded-full bg-og-status-waiting" />
        {messages.agentDeciding}
      </p>
    ) : (
      <DecisionButton
        kind="quiet"
        disabled={busy || delegating}
        busy={delegating}
        data-human-input-let-agent-decide=""
        onClick={() => void letAgentDecide()}
      >
        {messages.letAgentDecide}
      </DecisionButton>
    )
  ) : request.allowSkip ? (
    <DecisionButton
      kind="quiet"
      disabled={busy}
      onClick={() => void submitResponse({ outcome: "skipped" })}
    >
      {resolvedSkipLabel}
    </DecisionButton>
  ) : null;

  if (collapsed) {
    return (
      <div
        data-human-input-request={request.id}
        data-human-input-collapsed=""
        aria-labelledby={titleId}
        className={cn(decisionCardClass, "flex items-center gap-3 px-3 py-2.5", className)}
      >
        <DecisionMark>
          <MessageCircleQuestionIcon />
        </DecisionMark>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="m-0 truncate text-og-sm font-semibold text-og-fg">
            {questionTitle !== null ? (
              <InlineMarkdown singleLine>{questionTitle}</InlineMarkdown>
            ) : (
              resolvedTitle
            )}
          </h2>
          {meta ? <p className="m-0 mt-0.5 truncate text-og-xs text-og-fg-subtle">{meta}</p> : null}
        </div>
        <DecisionButton
          kind="secondary"
          onClick={() => setCollapsed(false)}
          className="w-auto shrink-0 px-3 @md/decision:min-h-8"
        >
          {messages.expand}
          <ChevronDownIcon aria-hidden="true" className="size-3.5" />
        </DecisionButton>
      </div>
    );
  }

  return (
    <form
      data-human-input-request={request.id}
      data-human-input-step={multi ? step + 1 : undefined}
      onSubmit={(event) => void submit(event)}
      aria-labelledby={titleId}
      className={cn(decisionCardClass, "flex flex-col", className)}
    >
      <header className={cn("flex items-start gap-3 pt-4", decisionCardPad)}>
        <DecisionMark>
          <MessageCircleQuestionIcon />
        </DecisionMark>
        <div className="min-w-0 flex-1 pt-px">
          <h2
            id={titleId}
            className="m-0 text-og-md font-semibold leading-snug text-balance text-og-fg [overflow-wrap:anywhere]"
          >
            {resolvedTitle}
          </h2>
          {resolvedDescription ? (
            <div className="mt-1 text-og-sm leading-relaxed text-og-fg-muted [overflow-wrap:anywhere]">
              {resolvedDescription}
            </div>
          ) : null}
          {meta ? <p className="m-0 mt-1.5 text-og-xs text-og-fg-subtle">{meta}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label={messages.collapse}
          title={messages.collapse}
          className="-mr-1.5 -mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-og-md text-og-fg-subtle transition-colors hover:bg-og-hover hover:text-og-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent/45 pointer-coarse:size-11"
        >
          <ChevronUpIcon aria-hidden="true" className="size-4" />
        </button>
      </header>

      {decision ? (
        <>
          {decision.question.helpText ||
          decision.accept.description ||
          decision.decline.description ? (
            <div
              className={cn(
                "space-y-1 pt-3 text-og-sm leading-relaxed text-og-fg-muted [overflow-wrap:anywhere]",
                decisionCardPad,
              )}
            >
              {decision.question.label && decision.question.helpText ? (
                <p className="m-0">
                  <InlineMarkdown>{decision.question.helpText}</InlineMarkdown>
                </p>
              ) : null}
              {[decision.accept, decision.decline].map((option) =>
                option.description ? (
                  <p key={option.id} className="m-0">
                    <span className="font-medium text-og-fg">{option.label}</span>
                    {" · "}
                    <InlineMarkdown>{option.description}</InlineMarkdown>
                  </p>
                ) : null,
              )}
            </div>
          ) : null}
          {errorText ? (
            <p
              role="alert"
              className={cn("m-0 pt-3 text-og-sm text-og-status-failed", decisionCardPad)}
            >
              {errorText}
            </p>
          ) : null}
          <footer className={cn("pb-4 pt-4", decisionCardPad)} data-human-input-decision="">
            <DecisionActions lead={skipButton}>
              {[decision.decline, decision.accept].map((option) => {
                const primary = option === decision.accept;
                const chosen = busy && decisionChoice === option.id;
                return (
                  <DecisionButton
                    key={option.id}
                    kind={primary ? "primary" : "secondary"}
                    disabled={busy}
                    busy={chosen}
                    ref={
                      !primary && autoFocus
                        ? (node: HTMLButtonElement | null) => {
                            if (node && !node.dataset.ogFocused) {
                              node.dataset.ogFocused = "";
                              node.focus({ preventScroll: true });
                            }
                          }
                        : undefined
                    }
                    data-human-input-choice={option.id}
                    onClick={() => {
                      setDecisionChoice(option.id);
                      void submitResponse({
                        outcome: "answered",
                        answers: [{ questionId: decision.question.id, values: [option.id] }],
                      });
                    }}
                  >
                    {chosen ? messages.submitting : option.label}
                  </DecisionButton>
                );
              })}
            </DecisionActions>
          </footer>
        </>
      ) : (
        <>
          <div ref={bodyRef} className={cn("min-w-0 pt-3", decisionCardPad)}>
            <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
              {request.questions.map((question, index) => (
                <div
                  key={question.id}
                  data-human-input-question={question.id}
                  hidden={multi && index !== step}
                  className="flex flex-col gap-2"
                >
                  {preview(question)}
                  <QuestionControls
                    question={question}
                    questionNumber={!headerCarriesQuestion && multi ? index + 1 : null}
                    labelledBy={headerCarriesQuestion ? titleId : undefined}
                    draft={drafts[question.id] ?? emptyDraft()}
                    fieldId={`${formId}-${index}`}
                    error={validationErrors[question.id]}
                    messages={messages}
                    autoFocus={autoFocus && index === 0}
                    firstOption={index === 0}
                    showPromptChrome={!headerCarriesQuestion}
                    allowSkip={request.allowSkip}
                    busy={busy}
                    allowedSaveTo={allowedSaveTo}
                    registerSecret={registerSecret(question.id)}
                    onSecretEdited={() => clearValidationError(question.id)}
                    onUpdate={(apply) => update(question.id, apply)}
                  />
                </div>
              ))}
            </fieldset>
          </div>

          {errorText ? (
            <p
              role="alert"
              className={cn("m-0 pt-3 text-og-sm text-og-status-failed", decisionCardPad)}
            >
              {errorText}
            </p>
          ) : null}

          <footer className={cn("pb-4 pt-4", decisionCardPad)}>
            <DecisionActions lead={skipButton}>
              {multi && step > 0 ? (
                <DecisionButton kind="secondary" disabled={busy} onClick={() => goToStep(step - 1)}>
                  {t("humanInputForm.back")}
                </DecisionButton>
              ) : null}
              <DecisionButton type="submit" kind="primary" disabled={busy} busy={busy}>
                {busy
                  ? messages.submitting
                  : multi && step < lastStep
                    ? t("humanInputForm.next")
                    : resolvedSubmitLabel}
              </DecisionButton>
            </DecisionActions>
          </footer>
        </>
      )}
    </form>
  );
}

// Unambiguous approve/decline verbs only: "Continue with A" vs "Keep B" is a
// real choice between two options, not a yes/no decision.
const ACCEPT_WORDS = new Set(["approve", "approved", "yes", "confirm", "allow", "accept"]);
const DECLINE_WORDS = new Set(["cancel", "decline", "reject", "deny", "no", "don't", "dont"]);

function firstWord(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[’]/g, "'")
      .split(/[\s,.:;!?()]+/)[0] ?? ""
  );
}

/**
 * A yes/no decision (an approval asked as a question): one required
 * single-choice question with exactly an accept and a decline option. It is
 * answered with two buttons; an "Other" free-text answer has no meaning for it,
 * and the composer still accepts a different instruction.
 */
export function binaryDecision(
  questions: readonly HumanInputQuestion[],
  { inferFromLabels = true }: { inferFromLabels?: boolean | undefined } = {},
): {
  question: HumanInputQuestion;
  accept: HumanInputQuestion["options"][number];
  decline: HumanInputQuestion["options"][number];
} | null {
  if (questions.length !== 1) return null;
  const question = questions[0]!;
  // The agent asked for a yes/no decision in its own words: the action first,
  // the way out second.
  if (
    question.confirm === true &&
    question.kind === "single_select" &&
    !question.skillReview &&
    question.options.length === 2
  ) {
    return { question, accept: question.options[0]!, decline: question.options[1]! };
  }
  if (!inferFromLabels) return null;
  if (
    question.kind !== "single_select" ||
    question.skillReview ||
    // The runtime marks every choice question `allowOther`, so it is not a
    // signal here; a different answer goes through the composer instead.
    !question.required ||
    question.options.length !== 2
  )
    return null;
  const [first, second] = question.options as [
    HumanInputQuestion["options"][number],
    HumanInputQuestion["options"][number],
  ];
  const kind = (option: HumanInputQuestion["options"][number]) => {
    const word = firstWord(option.label);
    return ACCEPT_WORDS.has(word) ? "accept" : DECLINE_WORDS.has(word) ? "decline" : null;
  };
  const a = kind(first);
  const b = kind(second);
  if (a === "accept" && b === "decline") return { question, accept: first, decline: second };
  if (a === "decline" && b === "accept") return { question, accept: second, decline: first };
  return null;
}

function QuestionControls({
  question,
  questionNumber,
  labelledBy,
  draft,
  fieldId,
  error,
  messages,
  autoFocus,
  firstOption,
  showPromptChrome,
  allowSkip,
  busy,
  allowedSaveTo,
  registerSecret,
  onSecretEdited,
  onUpdate,
}: {
  question: HumanInputQuestion;
  questionNumber: number | null;
  labelledBy: string | undefined;
  draft: HumanInputAnswerDraft;
  fieldId: string;
  error: string | undefined;
  messages: HumanInputFormMessages;
  autoFocus: boolean;
  firstOption: boolean;
  showPromptChrome: boolean;
  allowSkip: boolean;
  busy: boolean;
  allowedSaveTo: readonly HumanInputSecretSaveTo[] | undefined;
  registerSecret: (handle: SecretFieldHandle | null) => void;
  onSecretEdited: () => void;
  onUpdate: (apply: (draft: HumanInputAnswerDraft) => HumanInputAnswerDraft) => void;
}) {
  const t = useOpenGeniText();
  const errorId = `${fieldId}-error`;
  const helpId = `${fieldId}-help`;
  const labelId = `${fieldId}-label`;
  const promptId = `${fieldId}-prompt`;
  const otherChoiceId = `${fieldId}-other-choice`;
  const otherLabelId = `${fieldId}-other-label`;
  const otherTextId = `${fieldId}-other-text`;
  const visibleLabel = question.label ?? question.prompt;
  const controlLabelId = showPromptChrome ? labelId : labelledBy;
  const hint =
    question.kind === "multi_select"
      ? messages.selectionHint(
          question.validation?.minSelections,
          question.validation?.maxSelections,
        )
      : null;
  const describedBy =
    [
      question.label && showPromptChrome ? promptId : null,
      question.helpText && showPromptChrome ? helpId : null,
      hint ? `${fieldId}-hint` : null,
      error ? errorId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const selectOtherDraft = (current: HumanInputAnswerDraft): HumanInputAnswerDraft => ({
    ...current,
    otherSelected: true,
    ...(question.kind === "single_select" ? { values: [] } : {}),
  });
  return (
    <>
      {showPromptChrome ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <label
              id={labelId}
              htmlFor={question.kind === "text" ? fieldId : undefined}
              className="min-w-0 text-og-sm font-medium text-og-fg [overflow-wrap:anywhere]"
            >
              {questionNumber === null ? null : (
                <span className="mr-1.5 tabular-nums text-og-fg-muted">{questionNumber}.</span>
              )}
              {questionNumber === null ? null : " "}
              <InlineMarkdown>{visibleLabel}</InlineMarkdown>
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
          {question.label ? (
            <p id={promptId} className="text-og-sm text-og-fg-muted [overflow-wrap:anywhere]">
              <InlineMarkdown>{question.prompt}</InlineMarkdown>
            </p>
          ) : null}
          {question.helpText ? (
            <p id={helpId} className="text-og-xs text-og-fg-subtle [overflow-wrap:anywhere]">
              <InlineMarkdown>{question.helpText}</InlineMarkdown>
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
            <p id={helpId} className="mb-1.5 text-og-xs text-og-fg-subtle [overflow-wrap:anywhere]">
              <InlineMarkdown>{question.helpText}</InlineMarkdown>
            </p>
          ) : null}
          {hint ? (
            <p id={`${fieldId}-hint`} className="mb-1.5 text-og-xs text-og-fg-subtle">
              {hint}
            </p>
          ) : null}
        </>
      )}

      {question.kind === "secret" ? (
        question.secret ? (
          <SecretQuestionField
            question={question as HumanInputQuestion & { secret: HumanInputSecretSpec }}
            fieldId={fieldId}
            messages={messages}
            autoFocus={autoFocus}
            allowedSaveTo={allowedSaveTo}
            error={error}
            describedBy={
              [
                question.label && showPromptChrome ? promptId : null,
                question.helpText && showPromptChrome ? helpId : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            register={registerSecret}
            onEdited={onSecretEdited}
          />
        ) : (
          <p className="text-og-sm text-og-fg-muted">{t("humanInputForm.thisQuestionCanTBe")}</p>
        )
      ) : question.kind === "text" ? (
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
          aria-labelledby={controlLabelId}
          aria-describedby={describedBy}
          autoFocus={autoFocus}
          rows={3}
          placeholder={t("humanInputForm.typeYourAnswer")}
          className="min-h-20 w-full resize-y rounded-og-md border border-og-border bg-og-surface-1 px-3.5 py-2.5 text-og-sm leading-relaxed text-og-fg outline-hidden transition-[border-color,box-shadow] placeholder:text-og-fg-subtle focus:border-og-fg/50 focus:ring-2 focus:ring-og-accent/25 aria-[invalid=true]:border-og-status-failed/60 pointer-coarse:text-[16px]"
        />
      ) : (
        <div
          role={question.kind === "single_select" ? "radiogroup" : "group"}
          aria-labelledby={controlLabelId}
          aria-describedby={describedBy}
          className="flex flex-col gap-2"
        >
          {question.options.map((option, optionIndex) => {
            const checked = draft.values.includes(option.id);
            return (
              <label key={option.id} className={choiceRowClass(checked, true)}>
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
                  className="sr-only"
                />
                <ChoiceIndicator multiple={question.kind !== "single_select"} checked={checked} />
                <span className="min-w-0 flex-1">
                  <span className="block text-og-sm font-medium leading-5 [overflow-wrap:anywhere]">
                    {option.label}
                    {option.recommended ? (
                      <span
                        data-human-input-recommended=""
                        className="ml-2 inline-flex -translate-y-px items-center rounded-full bg-og-accent/12 px-2 align-middle text-og-xs font-medium leading-[1.125rem] text-og-accent"
                      >
                        {t("humanInputForm.recommended")}
                      </span>
                    ) : null}
                  </span>
                  {option.description ? (
                    <span className="mt-0.5 block text-og-xs leading-[1.125rem] text-og-fg-muted [overflow-wrap:anywhere]">
                      <InlineMarkdown>{option.description}</InlineMarkdown>
                    </span>
                  ) : null}
                  {option.preview ? (
                    <span
                      data-human-input-preview=""
                      className="mt-2 block max-h-40 overflow-auto whitespace-pre-wrap rounded-og-md bg-og-fg/[0.04] px-2.5 py-2 font-og-mono text-og-xs leading-[1.125rem] text-og-fg [overflow-wrap:anywhere]"
                    >
                      {option.preview}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
          {choiceOffersOther(question) ? (
            <div className={choiceRowClass(draft.otherSelected, false)}>
              <input
                id={otherChoiceId}
                type={question.kind === "single_select" ? "radio" : "checkbox"}
                name={question.kind === "single_select" ? fieldId : undefined}
                aria-labelledby={otherLabelId}
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
                className="sr-only"
              />
              <label htmlFor={otherChoiceId} className="cursor-pointer">
                <ChoiceIndicator
                  multiple={question.kind !== "single_select"}
                  checked={draft.otherSelected}
                />
                <span id={otherLabelId} className="sr-only">
                  {messages.other}
                </span>
              </label>
              <span className="min-w-0 flex-1">
                <label htmlFor={otherTextId} className="sr-only">
                  {t("humanInputForm.otherAnswerForVisiblelabel", {
                    other: messages.other,
                    visibleLabel,
                  })}
                </label>
                <input
                  id={otherTextId}
                  type="text"
                  value={draft.other}
                  disabled={busy}
                  placeholder={t("humanInputForm.somethingElse")}
                  onClick={() => onUpdate(selectOtherDraft)}
                  onFocus={() => onUpdate(selectOtherDraft)}
                  onChange={(event) => {
                    const other = event.target.value;
                    onUpdate((current) => ({
                      ...selectOtherDraft(current),
                      other,
                    }));
                  }}
                  className="block w-full min-w-0 bg-transparent p-0 text-og-sm font-medium leading-5 text-og-fg outline-hidden placeholder:font-normal placeholder:text-og-fg-subtle disabled:opacity-50 pointer-coarse:text-[16px]"
                />
              </span>
            </div>
          ) : null}
        </div>
      )}
      {/* A secret field shows its error under the input, above Save to. */}
      {error && !(question.kind === "secret" && question.secret) ? (
        <p id={errorId} role="alert" className="text-og-xs text-og-status-failed">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** One answer row: the whole row is the target, the selected row is outlined. */
function choiceRowClass(checked: boolean, clickable: boolean): string {
  return cn(
    "flex min-w-0 items-start gap-3 rounded-og-md border px-3.5 py-3 text-og-fg transition-[border-color,background-color,box-shadow] duration-150",
    "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-og-accent/40",
    clickable && "cursor-pointer",
    checked
      ? "border-og-fg/70 bg-og-fg/[0.035] shadow-[inset_0_0_0_1px_var(--color-og-fg)]"
      : "border-og-border hover:border-og-border-strong hover:bg-og-hover",
  );
}

function ChoiceIndicator({ multiple, checked }: { multiple: boolean; checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-px grid size-[18px] shrink-0 place-items-center border transition-colors duration-150",
        multiple ? "rounded-[5px]" : "rounded-full",
        checked ? "border-og-fg bg-og-fg text-og-bg" : "border-og-border-strong bg-og-surface-1",
      )}
    >
      {checked ? (
        multiple ? (
          <CheckIcon className="size-3" strokeWidth={3} />
        ) : (
          <span className="size-1.5 rounded-full bg-og-bg" />
        )
      ) : null}
    </span>
  );
}
