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
  type ReactNode,
} from "react";
import { createOpenGeniText, useOpenGeniText, type OpenGeniText } from "@opengeni/react/messages";
import { Pressable, ScrollView, Text, TextInput, View, type TextStyle } from "react-native";
import { Button } from "./controls";
import { Icon } from "./icon";
import type { NativeMarkdownRenderer } from "./message-timeline";
import { blendOver, withAlpha } from "./primitives";
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

/* ----------------------------------------------------------------------------
   Decision surfaces: the web HumanInputSurface/HumanInputForm (waiting tone,
   question-first, options, Other, Skip / Send answers) and the approval
   Notice strip, with the shared drafting and validation rules.
   -------------------------------------------------------------------------- */

function useWaitingTone() {
  const theme = useNativeTimelineTheme();
  const waiting = theme.colors["status-waiting"];
  return {
    theme,
    waiting,
    surface: withAlpha(waiting, 0.05),
    border: withAlpha(waiting, 0.35),
    divider: withAlpha(waiting, 0.2),
    iconBox: withAlpha(waiting, 0.12),
  };
}

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
      <View style={{ flexShrink: 1, minWidth: 0 }}>{render(text, { tone, textStyle: style })}</View>
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
    () => ({ ...defaultHumanInputFormMessages(t), ...messages }),
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
  const tone = useWaitingTone();
  const { theme } = tone;
  const c = theme.colors;
  const t = useOpenGeniText();
  const messages = useContext(HumanInputMessagesContext);
  const secretMessages = useContext(SecretFieldMessagesContext);
  const heading = humanInputHeading(request.questions, messages);
  const single = request.questions.length === 1;
  const required = single && request.questions[0]!.required;
  const [drafts, setDrafts] = useState<Record<string, HumanInputAnswerDraft>>(() =>
    initialDrafts(request.questions),
  );
  // Secret values stay out of React state: keystrokes land in this ref, which
  // is emptied after a successful submit and when the form goes away.
  const secretValues = useRef<Record<string, string>>({});
  const secretClears = useRef<Record<string, () => void>>({});
  const secretRegistrars = useRef<Record<string, (clear: (() => void) | null) => void>>({});
  const [secretDrafts, setSecretDrafts] = useState<Record<string, SecretDraft>>(() =>
    Object.fromEntries(
      request.questions
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
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInFlight(false);
    }
  };
  const send = () => {
    const result = answersFromDrafts(
      t,
      request.questions.filter((question) => !isSecretQuestion(question)),
      drafts,
      messages,
    );
    const secret = secretSubmission(
      request.questions,
      secretDrafts,
      secretValues.current,
      messages.required,
    );
    const nextErrors = { ...result.errors, ...secret.errors };
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    const byQuestion = new Map<string, HumanInputAnswer>(
      [...result.answers, ...secret.answers].map((answer) => [answer.questionId, answer]),
    );
    void submit({
      outcome: "answered",
      answers: request.questions.flatMap((question) => byQuestion.get(question.id) ?? []),
      ...(secret.secretAnswers.length > 0 ? { secretAnswers: secret.secretAnswers } : {}),
    });
  };
  // Editing a question clears its validation message, as on web.
  const clearError = (id: string) =>
    setErrors((current) => {
      if (!(id in current)) return current;
      const remaining = { ...current };
      delete remaining[id];
      return remaining;
    });
  const update = (id: string, next: (draft: HumanInputAnswerDraft) => HumanInputAnswerDraft) => {
    setDrafts((current) => ({ ...current, [id]: next(current[id] ?? emptyDraft()) }));
    clearError(id);
  };
  const updateSecret = (
    question: HumanInputQuestion,
    next: (draft: SecretDraft) => SecretDraft,
  ) => {
    setSecretDrafts((current) => ({
      ...current,
      [question.id]: next(current[question.id] ?? initialSecretDraft(question.secret)),
    }));
    clearError(question.id);
  };
  const setSecretValue = (id: string, value: string) => {
    secretValues.current[id] = value;
    if (value) clearError(id);
  };

  return (
    <View
      style={{
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: tone.border,
        backgroundColor: tone.surface,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 12,
          padding: 16,
          paddingBottom: collapsed ? 16 : 14,
        }}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: theme.radius.md,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: tone.iconBox,
          }}
        >
          <Icon name="message-circle-question" size={16} color={tone.waiting} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <QuestionText
            text={heading.title}
            tone="body"
            style={{
              ...fontStyle(theme, 600),
              fontSize: theme.size.md,
              lineHeight: 24,
              color: c.fg,
            }}
            suffix={required ? <Text style={{ color: c["status-failed"] }}> *</Text> : null}
          />
          {heading.description ? (
            <QuestionText
              text={heading.description}
              tone="muted"
              style={{
                ...fontStyle(theme),
                fontSize: theme.size.sm,
                lineHeight: 18,
                color: c["fg-muted"],
              }}
            />
          ) : null}
          {progressLabel ? (
            <Text
              style={{
                ...fontStyle(theme),
                marginTop: 2,
                fontSize: theme.size.xs,
                color: c["fg-subtle"],
              }}
            >
              {progressLabel}
            </Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={collapsed ? messages.expand : messages.collapse}
          onPress={() => setCollapsed((value) => !value)}
          style={{
            width: 32,
            height: 32,
            borderRadius: theme.radius.md,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={collapsed ? "chevron-down" : "chevron-up"} size={16} color={c["fg-muted"]} />
        </Pressable>
      </View>
      {collapsed ? null : (
        <>
          <ScrollView
            style={{ maxHeight: 360, borderTopWidth: 1, borderTopColor: tone.divider }}
            contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 14, gap: 18 }}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
          >
            {request.questions.map((question, index) => (
              <QuestionControls
                key={question.id}
                question={question}
                index={single ? null : index + 1}
                draft={drafts[question.id] ?? emptyDraft()}
                error={isSecretQuestion(question) ? undefined : errors[question.id]}
                disabled={busy}
                onChange={(next) => update(question.id, next)}
              >
                {isSecretQuestion(question) ? (
                  <SecretQuestionField
                    question={question}
                    draft={secretDrafts[question.id] ?? initialSecretDraft(question.secret)}
                    onDraft={(next) => updateSecret(question, next)}
                    onValue={(value) => setSecretValue(question.id, value)}
                    registerClear={registerSecretClear(question.id)}
                    messages={secretMessages}
                    error={errors[question.id]}
                    disabled={busy}
                  />
                ) : null}
              </QuestionControls>
            ))}
          </ScrollView>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 8,
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderTopWidth: 1,
              borderTopColor: tone.divider,
              backgroundColor: withAlpha(c["surface-1"], 0.95),
            }}
          >
            {error || submitError ? (
              <Text
                style={{
                  ...fontStyle(theme),
                  flex: 1,
                  fontSize: theme.size.xs,
                  color: c["status-failed"],
                }}
              >
                {submitError ?? error}
              </Text>
            ) : null}
            {request.allowSkip ? (
              <Button
                label={messages.skip}
                variant="ghost"
                size="form"
                disabled={busy}
                onPress={() =>
                  void submit({ outcome: "skipped" } as SubmitHumanInputResponseRequest)
                }
              />
            ) : null}
            <Button
              label={busy ? messages.submitting : messages.submit}
              variant="primary"
              size="form"
              busy={busy}
              onPress={send}
            />
          </View>
        </>
      )}
    </View>
  );
}

function QuestionControls({
  question,
  index,
  draft,
  error,
  disabled,
  onChange,
  children,
}: {
  question: HumanInputQuestion;
  index: number | null;
  draft: HumanInputAnswerDraft;
  error?: string | undefined;
  disabled: boolean;
  onChange: (next: (draft: HumanInputAnswerDraft) => HumanInputAnswerDraft) => void;
  /** A control that replaces the built-in ones (the secret field). */
  children?: ReactNode;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const m = useNativeTimelineMessages();
  const c = theme.colors;
  const messages = useContext(HumanInputMessagesContext);
  const multi = question.kind === "multi_select";
  const label = { ...fontStyle(theme, 500), fontSize: theme.size.sm, lineHeight: 18, color: c.fg };
  const input = {
    ...fontStyle(theme),
    fontSize: theme.size.sm,
    color: c.fg,
    minHeight: 32,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: error ? c["status-failed"] : c.border,
    backgroundColor: c["surface-1"],
  };
  const toggle = (value: string) =>
    onChange((current) => {
      if (!multi) return { ...current, values: [value], otherSelected: false };
      const has = current.values.includes(value);
      return {
        ...current,
        values: has
          ? current.values.filter((entry) => entry !== value)
          : [...current.values, value],
      };
    });
  const hint = multi
    ? messages.selectionHint(question.validation?.minSelections, question.validation?.maxSelections)
    : null;
  const secondary: TextStyle = {
    ...fontStyle(theme),
    fontSize: theme.size.sm,
    lineHeight: 18,
    color: c["fg-muted"],
  };
  // A lone question's heading already shows its help unless a label took the title.
  const help = question.helpText && (index !== null || question.label) ? question.helpText : null;
  return (
    <View style={{ gap: 10 }}>
      {index !== null ? (
        <View>
          <QuestionText
            prefix={`${index}. `}
            text={question.label ?? question.prompt}
            tone="body"
            style={{
              ...fontStyle(theme, 600),
              fontSize: theme.size.sm,
              lineHeight: 18,
              color: c.fg,
            }}
            suffix={
              question.required ? <Text style={{ color: c["status-failed"] }}> *</Text> : null
            }
          />
          {question.label ? (
            <QuestionText text={question.prompt} tone="muted" style={secondary} />
          ) : null}
        </View>
      ) : null}
      {help ? <QuestionText text={help} tone="muted" style={secondary} /> : null}
      {hint ? (
        <Text style={{ ...fontStyle(theme), fontSize: theme.size.xs, color: c["fg-subtle"] }}>
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
          onChangeText={(text) => onChange((current) => ({ ...current, values: [text] }))}
          placeholder={m.typeYourAnswer}
          placeholderTextColor={c["fg-subtle"]}
          style={{ ...input, minHeight: 64, textAlignVertical: "top" }}
        />
      ) : (
        <View style={{ gap: 2 }}>
          {question.options.map((option) => {
            const selected = draft.values.includes(option.id);
            return (
              <Pressable
                key={option.id}
                accessibilityRole={multi ? "checkbox" : "radio"}
                accessibilityState={{ checked: selected, disabled }}
                disabled={disabled}
                onPress={() => toggle(option.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "flex-start",
                  gap: 10,
                  minHeight: 36,
                  paddingVertical: 8,
                }}
              >
                <Selector multi={multi} selected={selected} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={label}>{option.label}</Text>
                  {option.description ? (
                    <QuestionText
                      text={option.description}
                      tone="muted"
                      style={{
                        ...fontStyle(theme),
                        fontSize: theme.size.xs,
                        lineHeight: 16,
                        color: c["fg-muted"],
                      }}
                    />
                  ) : null}
                </View>
              </Pressable>
            );
          })}
          {question.allowOther ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 10,
                paddingVertical: 8,
              }}
            >
              <Pressable
                accessibilityRole={multi ? "checkbox" : "radio"}
                accessibilityState={{ checked: draft.otherSelected, disabled }}
                accessibilityLabel={messages.other}
                disabled={disabled}
                onPress={() =>
                  onChange((current) =>
                    multi
                      ? { ...current, otherSelected: !current.otherSelected }
                      : { ...current, values: [], otherSelected: true },
                  )
                }
                style={{ paddingTop: 2 }}
              >
                <Selector multi={multi} selected={draft.otherSelected} />
              </Pressable>
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={label}>{messages.other}</Text>
                <TextInput
                  accessibilityLabel={t("native.timeline.decisions.otherAnswerForLabel", {
                    label: question.label ?? question.prompt,
                  })}
                  editable={!disabled}
                  value={draft.other}
                  onFocus={() =>
                    onChange((current) =>
                      multi
                        ? { ...current, otherSelected: true }
                        : { ...current, values: [], otherSelected: true },
                    )
                  }
                  onChangeText={(text) => onChange((current) => ({ ...current, other: text }))}
                  placeholder={m.typeAValue}
                  placeholderTextColor={c["fg-subtle"]}
                  style={input}
                />
              </View>
            </View>
          ) : null}
        </View>
      )}
      {error ? (
        <Text
          accessibilityRole="alert"
          style={{ ...fontStyle(theme), fontSize: theme.size.xs, color: c["status-failed"] }}
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
export function ApprovalStrip({ approvals, onDecide, messages: overrides }: ApprovalStripProps) {
  const t = useOpenGeniText();
  const messages = { ...defaultApprovalStripMessages(t), ...overrides };
  const tone = useWaitingTone();
  const { theme } = tone;
  const c = theme.colors;
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
  const small = { ...fontStyle(theme), fontSize: theme.size.xs, lineHeight: 16 };
  const body = { ...fontStyle(theme), fontSize: theme.size.sm, lineHeight: 20 };
  return (
    <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 12 }} nestedScrollEnabled>
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
        const canApprove = review.availableActions.includes("approve");
        const showDetails = details[approval.id] === true;
        const payload = showDetails ? approvalArgumentsText(approval) : "";
        const approveLabel = answer?.approve ?? messages.approve;
        const rejectLabel = answer?.reject ?? messages.reject;
        return (
          <View
            key={approval.id}
            accessibilityLabel={review.title}
            style={{
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: withAlpha(tone.waiting, 0.3),
              // Opaque: the strip floats over scrolling conversation.
              backgroundColor: blendOver(c.bg, tone.waiting, 0.06),
              padding: 12,
              flexDirection: "row",
              gap: 10,
            }}
          >
            <View style={{ paddingTop: 2 }}>
              <Icon name="shield-check" size={16} color={tone.waiting} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
              <View style={{ gap: 2 }}>
                <Text style={{ ...small, color: tone.waiting }}>
                  {t("toolActionReview.approvalNeeded")}
                </Text>
                <Text
                  accessibilityRole="header"
                  style={{ ...fontStyle(theme, 500), fontSize: 15, lineHeight: 21, color: c.fg }}
                >
                  {review.title}
                </Text>
                {review.accountLabel ? (
                  <Text style={{ ...small, color: c["fg-muted"] }}>{review.accountLabel}</Text>
                ) : null}
              </View>
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
                <View style={{ gap: 6 }}>
                  {facts.shown.map((field) => (
                    <View key={field.path}>
                      <Text style={{ ...small, color: c["fg-muted"] }}>{field.label}</Text>
                      <Text numberOfLines={4} style={{ ...body, color: c.fg }}>
                        {field.preview}
                      </Text>
                    </View>
                  ))}
                  {facts.hiddenFields > 0 ? (
                    <Text style={{ ...small, color: c["fg-subtle"] }}>
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
                <ScrollView
                  style={{
                    maxHeight: 160,
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: c.border,
                    backgroundColor: withAlpha(c["surface-2"], 0.6),
                  }}
                  contentContainerStyle={{ padding: 10 }}
                  nestedScrollEnabled
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
                </ScrollView>
              ) : null}
              <View
                style={{
                  marginTop: 4,
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {review.detailsAvailable ? (
                  <Button
                    variant="ghost"
                    label={
                      showDetails
                        ? t("approvalSurface.backToReview")
                        : t("toolActionReview.details")
                    }
                    onPress={() =>
                      setDetails((current) => ({ ...current, [approval.id]: !showDetails }))
                    }
                  />
                ) : null}
                <View style={{ flex: 1 }} />
                <Button
                  icon="x"
                  variant="secondary"
                  size="form"
                  label={settled[approval.id] === "reject" ? messages.rejected : rejectLabel}
                  busy={pending[approval.id] === "reject"}
                  disabled={busy}
                  onPress={() => void decide(approval.id, "reject")}
                />
                {canApprove ? (
                  <Button
                    icon="check"
                    variant="primary"
                    size="form"
                    label={settled[approval.id] === "approve" ? messages.approved : approveLabel}
                    busy={pending[approval.id] === "approve"}
                    disabled={busy}
                    onPress={() => void decide(approval.id, "approve")}
                  />
                ) : null}
              </View>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}
