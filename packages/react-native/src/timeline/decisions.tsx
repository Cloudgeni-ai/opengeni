import type {
  HumanInputAnswer,
  HumanInputQuestion,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import type { PendingApproval } from "@opengeni/react/session";
import {
  approvalAnswerLabels,
  approvalArgumentsText,
  approvalToolName,
  formatApprovalToolName,
  pendingApprovalReview,
  reviewFacts,
} from "@opengeni/react/approval-review-model";
import {
  answersFromDrafts,
  defaultHumanInputFormMessages,
  mergeHumanInputFormMessages,
  emptyDraft,
  humanInputHeading,
  initialDrafts,
  isActionableHumanInputRequest,
  type HumanInputAnswerDraft,
  type HumanInputFormMessages,
} from "@opengeni/react/timeline-model";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import { createOpenGeniText, useOpenGeniText, type OpenGeniText } from "@opengeni/react/messages";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import {
  DecisionActions,
  DecisionButton,
  DecisionCard,
  DecisionLink,
  DecisionMark,
  DecisionMeta,
} from "./decision-card";
import { Icon } from "./icon";
import type { NativeMarkdownRenderer } from "./message-timeline";
import { withAlpha } from "./primitives";
import { SecretQuestionField } from "./secret-field";
import {
  defaultSecretFieldMessages,
  initialSecretDraft,
  isSecretQuestion,
  secretSubmission,
  type SecretDraft,
  type SecretFieldMessages,
} from "./secret-field-model";
import { Selector } from "./selector";
import { fontStyle, useNativeTimelineTheme } from "./theme";
import { useNativeTimelineMessages } from "./messages";
import { errorMessage } from "@opengeni/contracts/values";

/* ----------------------------------------------------------------------------
   Decision surfaces: the web HumanInputForm (one question at a time, choice
   rows, Something else, Skip / Back / Next / Send) and the approval card, on
   the shared decision card, with the shared drafting and validation rules.
   -------------------------------------------------------------------------- */

export interface HumanInputCardProps {
  requests: SessionHumanInputRequest[];
  onSubmit: (requestId: string, response: SubmitHumanInputResponseRequest) => void | Promise<void>;
  respondingRequestId?: string | null | undefined;
  error?: string | null | undefined;
  /** The shared question-form catalog; hosts translate by overriding entries. */
  messages?: Partial<HumanInputFormMessages> | undefined;
  /** Copy for secret questions (Save to, Generate, show / hide). */
  secretMessages?: Partial<SecretFieldMessages> | undefined;
  /** The conversation's Markdown renderer, so questions read as the web form does. */
  renderMarkdown?: NativeMarkdownRenderer | undefined;
}

const HumanInputMessagesContext = createContext<HumanInputFormMessages>(
  defaultHumanInputFormMessages(createOpenGeniText()),
);
const SecretFieldMessagesContext = createContext<SecretFieldMessages>(
  defaultSecretFieldMessages(createOpenGeniText()),
);
const QuestionMarkdownContext = createContext<NativeMarkdownRenderer | undefined>(undefined);

/** Emphasis, code, links, lists or line breaks: text a plain label would show raw. */
const MARKDOWN_SYNTAX = /[*_`#[\]]|https?:\/\/|\n/;

/**
 * Question copy as the web form shows it (inline Markdown, so links and
 * emphasis work). Plain text keeps the card's own type style; only copy that
 * actually carries Markdown goes through the conversation's renderer.
 */
function QuestionText({
  text,
  style,
  tone,
  prefix,
  suffix,
}: {
  text: string;
  style: TextStyle;
  tone: "body" | "muted";
  /** Plain lead-in kept outside the Markdown, such as a "2. " step number. */
  prefix?: string;
  suffix?: ReactNode;
}) {
  const render = useContext(QuestionMarkdownContext);
  // Callers build the style inline; keep it stable for the Markdown renderer.
  const styleKey = JSON.stringify(style);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on the style's content
  const textStyle = useMemo(() => style, [styleKey]);
  if (!render || !MARKDOWN_SYNTAX.test(text))
    return (
      <Text style={style}>
        {prefix}
        {text}
        {suffix}
      </Text>
    );
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
      {prefix ? <Text style={style}>{prefix}</Text> : null}
      <View style={{ flexShrink: 1, minWidth: 0 }}>{render(text, { tone, textStyle })}</View>
      {suffix ? <Text style={style}>{suffix}</Text> : null}
    </View>
  );
}

/** One decision shell for pending requests, oldest first, "N of M" when stepping. */
export function HumanInputCard({
  requests,
  onSubmit,
  respondingRequestId = null,
  error,
  messages,
  secretMessages,
  renderMarkdown,
}: HumanInputCardProps) {
  const t = useOpenGeniText();
  const merged = useMemo(
    () => mergeHumanInputFormMessages(defaultHumanInputFormMessages(t), messages),
    [t, messages],
  );
  const mergedSecret = useMemo(
    () => ({ ...defaultSecretFieldMessages(t), ...secretMessages }),
    [secretMessages, t],
  );
  const batchTotal = useRef(0);
  const ordered = useMemo(() => {
    const now = Date.now();
    return requests
      .filter((request) => isActionableHumanInputRequest(request, now))
      .sort((a, b) => {
        const aAt = a.createdAt ? Date.parse(a.createdAt) : 0;
        const bAt = b.createdAt ? Date.parse(b.createdAt) : 0;
        return aAt !== bAt ? aAt - bAt : a.id.localeCompare(b.id);
      });
  }, [requests]);
  if (ordered.length === 0) {
    batchTotal.current = 0;
    return null;
  }
  batchTotal.current = Math.max(batchTotal.current, ordered.length);
  const active = ordered[0]!;
  const position = batchTotal.current - ordered.length + 1;
  return (
    <HumanInputMessagesContext.Provider value={merged}>
      <SecretFieldMessagesContext.Provider value={mergedSecret}>
        <QuestionMarkdownContext.Provider value={renderMarkdown}>
          <HumanInputForm
            key={active.id}
            request={active}
            progressLabel={
              batchTotal.current > 1
                ? t("native.timeline.decisions.positionOfCurrent", {
                    position,
                    current: batchTotal.current,
                  })
                : null
            }
            submitting={respondingRequestId !== null}
            error={error ?? null}
            onSubmit={(response) => onSubmit(active.id, response)}
          />
        </QuestionMarkdownContext.Provider>
      </SecretFieldMessagesContext.Provider>
    </HumanInputMessagesContext.Provider>
  );
}

function HumanInputForm({
  request,
  progressLabel,
  submitting,
  error,
  onSubmit,
}: {
  request: SessionHumanInputRequest;
  progressLabel: string | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (response: SubmitHumanInputResponseRequest) => void | Promise<void>;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const t = useOpenGeniText();
  const messages = useContext(HumanInputMessagesContext);
  const secretMessages = useContext(SecretFieldMessagesContext);
  const questions = request.questions;
  const total = questions.length;
  // Several questions are asked one at a time; every step stays mounted so
  // drafts and typed secrets survive moving back and forth.
  const [step, setStep] = useState(0);
  const current = Math.min(step, total - 1);
  const last = current === total - 1;
  const heading = humanInputHeading([questions[current]!], messages);
  const [drafts, setDrafts] = useState<Record<string, HumanInputAnswerDraft>>(() =>
    initialDrafts(questions),
  );
  // Secret values stay out of React state: keystrokes land in this ref, which
  // is emptied after a successful submit and when the form goes away.
  const secretValues = useRef<Record<string, string>>({});
  const secretClears = useRef<Record<string, () => void>>({});
  const secretRegistrars = useRef<Record<string, (clear: (() => void) | null) => void>>({});
  const [secretDrafts, setSecretDrafts] = useState<Record<string, SecretDraft>>(() =>
    Object.fromEntries(
      questions
        .filter(isSecretQuestion)
        .map((question) => [question.id, initialSecretDraft(question.secret)]),
    ),
  );
  useEffect(
    () => () => {
      secretValues.current = {};
    },
    [],
  );
  const registerSecretClear = useCallback((id: string) => {
    // One stable registrar per question, so the field's effect runs once.
    const existing = secretRegistrars.current[id];
    if (existing) return existing;
    const registrar = (clear: (() => void) | null) => {
      if (clear) secretClears.current[id] = clear;
      else delete secretClears.current[id];
    };
    secretRegistrars.current[id] = registrar;
    return registrar;
  }, []);
  const clearSecrets = () => {
    secretValues.current = {};
    for (const clear of Object.values(secretClears.current)) clear();
  };
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const busy = submitting || inFlight;

  const submit = async (response: SubmitHumanInputResponseRequest) => {
    setSubmitError(null);
    setInFlight(true);
    try {
      await onSubmit(response);
      clearSecrets();
    } catch (cause) {
      setSubmitError(errorMessage(cause));
    } finally {
      setInFlight(false);
    }
  };
  const validate = (subset: HumanInputQuestion[]) => {
    const result = answersFromDrafts(
      t,
      subset.filter((question) => !isSecretQuestion(question)),
      drafts,
      messages,
    );
    const secret = secretSubmission(subset, secretDrafts, secretValues.current, messages.required);
    return { result, secret, errors: { ...result.errors, ...secret.errors } };
  };
  const next = () => {
    const { errors: stepErrors } = validate([questions[current]!]);
    setErrors((existing) => ({ ...existing, ...stepErrors }));
    if (Object.keys(stepErrors).length === 0) setStep(current + 1);
  };
  const send = () => {
    const { result, secret, errors: nextErrors } = validate(questions);
    setErrors(nextErrors);
    const firstInvalid = questions.findIndex((question) => question.id in nextErrors);
    if (firstInvalid >= 0) {
      // Show the step that needs attention.
      setStep(firstInvalid);
      return;
    }
    const byQuestion = new Map<string, HumanInputAnswer>(
      [...result.answers, ...secret.answers].map((answer) => [answer.questionId, answer]),
    );
    void submit({
      outcome: "answered",
      answers: questions.flatMap((question) => byQuestion.get(question.id) ?? []),
      ...(secret.secretAnswers.length > 0 ? { secretAnswers: secret.secretAnswers } : {}),
    });
  };
  // Editing a question clears its validation message, as on web.
  const clearError = (id: string) =>
    setErrors((existing) => {
      if (!(id in existing)) return existing;
      const remaining = { ...existing };
      delete remaining[id];
      return remaining;
    });
  const update = (id: string, change: (draft: HumanInputAnswerDraft) => HumanInputAnswerDraft) => {
    setDrafts((existing) => ({
      ...existing,
      [id]: change(existing[id] ?? emptyDraft()),
    }));
    clearError(id);
  };
  const updateSecret = (
    question: HumanInputQuestion,
    change: (draft: SecretDraft) => SecretDraft,
  ) => {
    setSecretDrafts((existing) => ({
      ...existing,
      [question.id]: change(existing[question.id] ?? initialSecretDraft(question.secret)),
    }));
    clearError(question.id);
  };
  const setSecretValue = (id: string, value: string) => {
    secretValues.current[id] = value;
    if (value) clearError(id);
  };
  const meta = [
    total > 1 ? t("humanInputForm.questionOfTotal", { current: current + 1, total }) : null,
    progressLabel,
  ];
  const failure = submitError ?? error;

  return (
    <DecisionCard>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 12,
          paddingHorizontal: 16,
          paddingTop: 16,
          paddingBottom: collapsed ? 16 : 4,
        }}
      >
        <DecisionMark icon="message-circle-question" />
        <View style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
          <QuestionText
            text={heading.title}
            tone="body"
            style={{
              ...fontStyle(theme, 600),
              fontSize: theme.size.md,
              lineHeight: 22,
              color: c.fg,
            }}
          />
          {heading.description && !collapsed ? (
            <QuestionText
              text={heading.description}
              tone="muted"
              style={{
                ...fontStyle(theme),
                marginTop: 2,
                fontSize: theme.size.base,
                lineHeight: 19,
                color: c["fg-muted"],
              }}
            />
          ) : null}
          <DecisionMeta waiting parts={meta} />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={collapsed ? messages.expand : messages.collapse}
          onPress={() => setCollapsed((value) => !value)}
          hitSlop={6}
          style={{
            width: 32,
            height: 32,
            marginRight: -6,
            borderRadius: theme.radius.md,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={collapsed ? "chevron-down" : "chevron-up"} size={16} color={c["fg-muted"]} />
        </Pressable>
      </View>
      {collapsed ? null : (
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 16,
            gap: 16,
          }}
        >
          {questions.map((question, index) => (
            <View key={question.id} style={index === current ? null : { display: "none" }}>
              <QuestionControls
                question={question}
                draft={drafts[question.id] ?? emptyDraft()}
                error={isSecretQuestion(question) ? undefined : errors[question.id]}
                disabled={busy}
                onChange={(change) => update(question.id, change)}
              >
                {isSecretQuestion(question) ? (
                  <SecretQuestionField
                    question={question}
                    draft={secretDrafts[question.id] ?? initialSecretDraft(question.secret)}
                    onDraft={(change) => updateSecret(question, change)}
                    onValue={(value) => setSecretValue(question.id, value)}
                    registerClear={registerSecretClear(question.id)}
                    messages={secretMessages}
                    error={errors[question.id]}
                    disabled={busy}
                  />
                ) : null}
              </QuestionControls>
            </View>
          ))}
          {failure ? (
            <Text
              accessibilityRole="alert"
              style={{
                ...fontStyle(theme),
                fontSize: theme.size.sm,
                lineHeight: 18,
                color: c["status-failed"],
              }}
            >
              {failure}
            </Text>
          ) : null}
          <DecisionActions
            primary={
              <DecisionButton
                kind="primary"
                label={
                  !last
                    ? t("humanInputForm.next")
                    : busy
                      ? messages.submitting
                      : total === 1
                        ? (messages.submitOne ?? messages.submit)
                        : messages.submit
                }
                busy={last && busy}
                disabled={busy}
                onPress={last ? send : next}
              />
            }
            secondary={
              current > 0 ? (
                <DecisionButton
                  label={t("humanInputForm.back")}
                  disabled={busy}
                  onPress={() => setStep(current - 1)}
                />
              ) : undefined
            }
            lead={
              request.allowSkip ? (
                <DecisionLink
                  label={messages.skip}
                  disabled={busy}
                  onPress={() =>
                    void submit({
                      outcome: "skipped",
                    } as SubmitHumanInputResponseRequest)
                  }
                />
              ) : null
            }
          />
        </View>
      )}
    </DecisionCard>
  );
}

function QuestionControls({
  question,
  draft,
  error,
  disabled,
  onChange,
  children,
}: {
  question: HumanInputQuestion;
  draft: HumanInputAnswerDraft;
  error?: string | undefined;
  disabled: boolean;
  onChange: (change: (draft: HumanInputAnswerDraft) => HumanInputAnswerDraft) => void;
  /** A control that replaces the built-in ones (the secret field). */
  children?: ReactNode;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const messages = useContext(HumanInputMessagesContext);
  const m = useNativeTimelineMessages();
  const otherInput = useRef<ComponentRef<typeof TextInput>>(null);
  const multi = question.kind === "multi_select";
  const toggle = (value: string) =>
    onChange((existing) => {
      if (!multi) return { ...existing, values: [value], otherSelected: false };
      const has = existing.values.includes(value);
      return {
        ...existing,
        values: has
          ? existing.values.filter((entry) => entry !== value)
          : [...existing.values, value],
      };
    });
  const chooseOther = () =>
    onChange((existing) =>
      multi
        ? { ...existing, otherSelected: true }
        : { ...existing, values: [], otherSelected: true },
    );
  const hint = multi
    ? messages.selectionHint(question.validation?.minSelections, question.validation?.maxSelections)
    : null;
  const secondary: TextStyle = {
    ...fontStyle(theme),
    fontSize: theme.size.base,
    lineHeight: 19,
    color: c["fg-muted"],
  };
  // The heading already shows the help unless a label took the title.
  const help = question.helpText && question.label ? question.helpText : null;
  const row = (selected: boolean): ViewStyle => ({
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    minHeight: 48,
    // A chosen row's border is one point heavier; the padding keeps its content still.
    paddingHorizontal: selected ? 13 : 14,
    paddingVertical: selected ? 11 : 12,
    borderRadius: theme.radius.md,
    borderWidth: selected ? 2 : 1,
    borderColor: selected ? withAlpha(c.fg, 0.85) : c.border,
    backgroundColor: selected ? withAlpha(c.fg, 0.035) : c["surface-1"],
  });
  return (
    <View style={{ gap: 10 }}>
      {help ? <QuestionText text={help} tone="muted" style={secondary} /> : null}
      {hint ? (
        <Text
          style={{
            ...fontStyle(theme),
            fontSize: theme.size.sm,
            color: c["fg-muted"],
          }}
        >
          {hint}
        </Text>
      ) : null}
      {children ? (
        children
      ) : question.kind === "text" ? (
        <TextInput
          accessibilityLabel={question.label ?? question.prompt}
          editable={!disabled}
          multiline
          value={draft.values[0] ?? ""}
          onChangeText={(text) => onChange((existing) => ({ ...existing, values: [text] }))}
          placeholder={m.typeYourAnswer}
          placeholderTextColor={c["fg-subtle"]}
          style={{
            ...fontStyle(theme),
            // 16pt: smaller text makes iOS zoom into the field.
            fontSize: 16,
            lineHeight: 22,
            color: c.fg,
            minHeight: 96,
            paddingHorizontal: 14,
            paddingTop: 12,
            paddingBottom: 12,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: error ? c["status-failed"] : c.border,
            backgroundColor: c["surface-1"],
            textAlignVertical: "top",
          }}
        />
      ) : (
        <View style={{ gap: 8 }}>
          {question.options.map((option) => {
            const selected = draft.values.includes(option.id);
            return (
              <Pressable
                key={option.id}
                accessibilityRole={multi ? "checkbox" : "radio"}
                accessibilityState={{ checked: selected, disabled }}
                accessibilityLabel={option.label}
                disabled={disabled}
                onPress={() => toggle(option.id)}
                style={({ pressed }) => [row(selected), pressed ? { opacity: 0.85 } : null]}
              >
                <Selector multi={multi} selected={selected} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text
                    style={{
                      ...fontStyle(theme, 500),
                      fontSize: theme.size.md,
                      lineHeight: 21,
                      color: c.fg,
                    }}
                  >
                    {option.label}
                  </Text>
                  {option.description ? (
                    <QuestionText text={option.description} tone="muted" style={secondary} />
                  ) : null}
                </View>
              </Pressable>
            );
          })}
          {question.allowOther ? (
            <Pressable
              accessibilityRole={multi ? "checkbox" : "radio"}
              accessibilityState={{ checked: draft.otherSelected, disabled }}
              accessibilityLabel={messages.other}
              disabled={disabled}
              onPress={() => {
                chooseOther();
                otherInput.current?.focus();
              }}
              style={[row(draft.otherSelected), { alignItems: "center", paddingVertical: 0 }]}
            >
              <Selector multi={multi} selected={draft.otherSelected} />
              <TextInput
                ref={otherInput}
                accessibilityLabel={t("native.timeline.decisions.otherAnswerForLabel", {
                  label: question.label ?? question.prompt,
                })}
                editable={!disabled}
                value={draft.other}
                onFocus={chooseOther}
                onChangeText={(text) => onChange((existing) => ({ ...existing, other: text }))}
                placeholder={t("humanInputForm.somethingElse")}
                placeholderTextColor={c["fg-subtle"]}
                style={{
                  ...fontStyle(theme),
                  flex: 1,
                  minHeight: 46,
                  fontSize: 16,
                  color: c.fg,
                  paddingVertical: 10,
                }}
              />
            </Pressable>
          ) : null}
        </View>
      )}
      {error ? (
        <Text
          accessibilityRole="alert"
          style={{
            ...fontStyle(theme),
            fontSize: theme.size.sm,
            color: c["status-failed"],
          }}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export interface ApprovalStripMessages {
  approve: string;
  reject: string;
  approved: string;
  rejected: string;
  /** The tool's readable name, the card's title when the runtime gives none. */
  formatToolName: (name: string) => string;
}

export const defaultApprovalStripMessages = (t: OpenGeniText): ApprovalStripMessages => ({
  approve: t("native.timeline.decisions.approve"),
  reject: t("native.timeline.decisions.reject"),
  approved: t("native.timeline.decisions.approved"),
  rejected: t("native.timeline.decisions.rejected"),
  formatToolName: (name) => formatApprovalToolName(t, name),
});

export interface ApprovalStripProps {
  approvals: PendingApproval[];
  onDecide: (approvalId: string, decision: "approve" | "reject") => void | Promise<void>;
  messages?: Partial<ApprovalStripMessages> | undefined;
}

/**
 * The live decision strip: one readable review card per pending tool approval,
 * as the web approval surface shows it. An app action (a setting changed
 * through chat) reads as a plain question answered with Allow or Cancel; the
 * raw arguments stay behind Details.
 */
/**
 * The scrolling part of an approval card. When the review is taller than its
 * window, the scroll bar shows once (and stays on Android), so a person can see
 * there is more to read before approving.
 */
function ReviewBody({ maxHeight, children }: { maxHeight: number; children: ReactNode }) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const flashed = useRef(false);
  return (
    <ScrollView
      ref={scroll}
      style={{ maxHeight, flexGrow: 0 }}
      contentContainerStyle={{ gap: 12 }}
      nestedScrollEnabled
      persistentScrollbar
      onContentSizeChange={(_width, contentHeight) => {
        if (flashed.current || contentHeight <= maxHeight) return;
        flashed.current = true;
        scroll.current?.flashScrollIndicators();
      }}
    >
      {children}
    </ScrollView>
  );
}

export function ApprovalStrip({ approvals, onDecide, messages: overrides }: ApprovalStripProps) {
  const t = useOpenGeniText();
  const messages = { ...defaultApprovalStripMessages(t), ...overrides };
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { height } = useWindowDimensions();
  const [pending, setPending] = useState<Record<string, "approve" | "reject">>({});
  const [settled, setSettled] = useState<Record<string, "approve" | "reject">>({});
  const [details, setDetails] = useState<Record<string, boolean>>({});
  if (approvals.length === 0) return null;
  const decide = async (id: string, decision: "approve" | "reject") => {
    setPending((current) => ({ ...current, [id]: decision }));
    try {
      await onDecide(id, decision);
      setSettled((current) => ({ ...current, [id]: decision }));
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };
  const small = {
    ...fontStyle(theme),
    fontSize: theme.size.sm,
    lineHeight: 18,
  };
  const body = {
    ...fontStyle(theme),
    fontSize: theme.size.base,
    lineHeight: 20,
  };
  const bodyMaxHeight = Math.max(120, Math.round(height * 0.5 - 200));
  return (
    <ScrollView
      // The cards float above the composer and take at most about 60% of the
      // screen; several pending approvals scroll as a list within that.
      style={{ maxHeight: Math.max(320, Math.round(height * 0.6)) }}
      contentContainerStyle={{ gap: 12 }}
      nestedScrollEnabled
    >
      {approvals.map((approval) => {
        const busy = Boolean(pending[approval.id]) || Boolean(settled[approval.id]);
        const toolName = approvalToolName(approval);
        const answer = approvalAnswerLabels(t, toolName);
        const review = pendingApprovalReview(approval, {
          formatToolName: messages.formatToolName,
          approveLabel: answer?.approve ?? messages.approve,
        });
        const facts = reviewFacts(review);
        const note = review.consequence;
        // A request without recorded arguments keeps its Approve, as it
        // always had here; only the readable summary is unavailable.
        const canApprove =
          review.availableActions.includes("approve") || approval.arguments === undefined;
        const showDetails = details[approval.id] === true;
        const payload = showDetails ? approvalArgumentsText(approval) : "";
        const approveLabel = answer?.approve ?? messages.approve;
        const rejectLabel = answer?.reject ?? messages.reject;
        return (
          <DecisionCard key={approval.id} accessibilityLabel={review.title}>
            <View style={{ padding: 16, gap: 12 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 12,
                }}
              >
                <DecisionMark icon="shield-check" />
                <View style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
                  <Text
                    accessibilityRole="header"
                    style={{
                      ...fontStyle(theme, 600),
                      fontSize: theme.size.md,
                      lineHeight: 22,
                      color: c.fg,
                    }}
                  >
                    {review.title}
                  </Text>
                  <DecisionMeta
                    waiting
                    parts={[t("toolActionReview.approvalNeeded"), review.accountLabel]}
                  />
                </View>
              </View>
              {/* The title and the buttons stay pinned; a long review scrolls
                  between them so the buttons are never pushed off screen. */}
              <ReviewBody maxHeight={bodyMaxHeight}>
                {note ? <Text style={{ ...body, color: c["fg-muted"] }}>{note}</Text> : null}
                {facts.effects.length > 0 ? (
                  <View accessibilityLabel={t("toolActionReview.alsoChanges")} style={{ gap: 2 }}>
                    {facts.effects.map((effect) => (
                      <Text key={effect} style={{ ...body, color: c.fg }}>
                        {"\u2022 "}
                        {effect}
                      </Text>
                    ))}
                  </View>
                ) : null}
                {facts.shown.length > 0 ? (
                  <View
                    style={{
                      gap: 10,
                      padding: 12,
                      borderRadius: theme.radius.md,
                      backgroundColor: withAlpha(c.fg, 0.035),
                    }}
                  >
                    {facts.shown.map((field) => (
                      <View key={field.path} style={{ gap: 1 }}>
                        <Text style={{ ...small, color: c["fg-muted"] }}>{field.label}</Text>
                        {/* Like the web card: a field reads in full (the body
                            scrolls), and only a value cut short by the server is
                            clamped, with all of it under Show details. */}
                        <Text
                          numberOfLines={field.truncated ? 6 : undefined}
                          style={{ ...body, color: c.fg }}
                        >
                          {field.preview}
                        </Text>
                      </View>
                    ))}
                    {facts.hiddenFields > 0 ? (
                      <Text style={{ ...small, color: c["fg-muted"] }}>
                        {facts.hiddenFields === 1
                          ? t("toolActionReview.n1MoreValue")
                          : t("toolActionReview.hiddenfieldsMoreValues", {
                              hiddenFields: facts.hiddenFields,
                            })}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
                {!canApprove ? (
                  <Text style={{ ...body, color: c.fg }}>
                    {t("toolActionReview.theDetailsOfThisOlder")}
                  </Text>
                ) : null}
                {showDetails ? (
                  <View
                    style={{
                      padding: 12,
                      borderRadius: theme.radius.md,
                      borderWidth: 1,
                      borderColor: c.border,
                      backgroundColor: withAlpha(c.fg, 0.035),
                    }}
                  >
                    <Text
                      selectable
                      style={{
                        ...fontStyle(theme, 400, "mono"),
                        fontSize: theme.size.sm,
                        lineHeight: 20,
                        color: c["fg-muted"],
                      }}
                    >
                      {payload}
                    </Text>
                  </View>
                ) : null}
              </ReviewBody>
              <DecisionActions
                style={{ marginTop: 4 }}
                primary={
                  canApprove ? (
                    <DecisionButton
                      kind="primary"
                      label={settled[approval.id] === "approve" ? messages.approved : approveLabel}
                      busy={pending[approval.id] === "approve"}
                      disabled={busy}
                      onPress={() => void decide(approval.id, "approve")}
                    />
                  ) : undefined
                }
                secondary={
                  <DecisionButton
                    label={settled[approval.id] === "reject" ? messages.rejected : rejectLabel}
                    busy={pending[approval.id] === "reject"}
                    disabled={busy}
                    onPress={() => void decide(approval.id, "reject")}
                  />
                }
                lead={
                  review.detailsAvailable ? (
                    <DecisionLink
                      label={
                        showDetails
                          ? t("approvalSurface.backToReview")
                          : t("toolActionReview.details")
                      }
                      onPress={() =>
                        setDetails((current) => ({
                          ...current,
                          [approval.id]: !showDetails,
                        }))
                      }
                    />
                  ) : null
                }
              />
            </View>
          </DecisionCard>
        );
      })}
    </ScrollView>
  );
}
