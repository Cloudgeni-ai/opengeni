import type {
  HumanInputAnswer,
  HumanInputQuestion,
  SessionHumanInputRequest,
  SubmitHumanInputResponseRequest,
} from "@opengeni/sdk";
import type { PendingApproval } from "@opengeni/react/session";
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
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Button } from "./controls";
import { Icon } from "./icon";
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
}

const HumanInputMessagesContext = createContext<HumanInputFormMessages>(
  defaultHumanInputFormMessages,
);
const SecretFieldMessagesContext = createContext<SecretFieldMessages>(defaultSecretFieldMessages);

/** One decision shell for pending requests, oldest first, "N of M" when stepping. */
export function HumanInputCard({
  requests,
  onSubmit,
  respondingRequestId = null,
  error,
  messages,
  secretMessages,
}: HumanInputCardProps) {
  const merged = useMemo(() => ({ ...defaultHumanInputFormMessages, ...messages }), [messages]);
  const mergedSecret = useMemo(
    () => ({ ...defaultSecretFieldMessages, ...secretMessages }),
    [secretMessages],
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
        <HumanInputForm
          key={active.id}
          request={active}
          progressLabel={batchTotal.current > 1 ? `${position} of ${batchTotal.current}` : null}
          submitting={respondingRequestId !== null}
          error={error ?? null}
          onSubmit={(response) => onSubmit(active.id, response)}
        />
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
          <Text
            style={{
              ...fontStyle(theme, 600),
              fontSize: theme.size.md,
              lineHeight: 24,
              color: c.fg,
            }}
          >
            {heading.title}
            {required ? <Text style={{ color: c["status-failed"] }}> *</Text> : null}
          </Text>
          {heading.description ? (
            <Text
              style={{
                ...fontStyle(theme),
                fontSize: theme.size.sm,
                lineHeight: 18,
                color: c["fg-muted"],
              }}
            >
              {heading.description}
            </Text>
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
  return (
    <View style={{ gap: 10 }}>
      {index !== null ? (
        <View>
          <Text
            style={{
              ...fontStyle(theme, 600),
              fontSize: theme.size.sm,
              lineHeight: 18,
              color: c.fg,
            }}
          >
            {`${index}. ${question.label ?? question.prompt}`}
            {question.required ? <Text style={{ color: c["status-failed"] }}> *</Text> : null}
          </Text>
          {question.label ? (
            <Text
              style={{
                ...fontStyle(theme),
                fontSize: theme.size.sm,
                lineHeight: 18,
                color: c["fg-muted"],
              }}
            >
              {question.prompt}
            </Text>
          ) : null}
        </View>
      ) : null}
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
                    <Text
                      style={{
                        ...fontStyle(theme),
                        fontSize: theme.size.xs,
                        lineHeight: 16,
                        color: c["fg-muted"],
                      }}
                    >
                      {option.description}
                    </Text>
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
                  accessibilityLabel={`Other answer for ${question.label ?? question.prompt}`}
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
  /** The tool's display name; the web live strip shows the raw name. */
  formatToolName: (name: string) => string;
}

export const defaultApprovalStripMessages: ApprovalStripMessages = {
  approve: "Approve",
  reject: "Reject",
  approved: "Approved",
  rejected: "Rejected",
  formatToolName: (name) => name,
};

export interface ApprovalStripProps {
  approvals: PendingApproval[];
  onDecide: (approvalId: string, decision: "approve" | "reject") => void | Promise<void>;
  messages?: Partial<ApprovalStripMessages> | undefined;
}

/** The web live decision strip: one waiting Notice per pending tool approval. */
export function ApprovalStrip({ approvals, onDecide, messages: overrides }: ApprovalStripProps) {
  const messages = { ...defaultApprovalStripMessages, ...overrides };
  const tone = useWaitingTone();
  const { theme } = tone;
  const c = theme.colors;
  const [pending, setPending] = useState<Record<string, "approve" | "reject">>({});
  const [settled, setSettled] = useState<Record<string, "approve" | "reject">>({});
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
  return (
    <ScrollView style={{ maxHeight: 256 }} contentContainerStyle={{ gap: 12 }} nestedScrollEnabled>
      {approvals.map((approval) => {
        const busy = Boolean(pending[approval.id]) || Boolean(settled[approval.id]);
        const payload = JSON.stringify(approval.arguments ?? approval.raw ?? {}, null, 2);
        return (
          <View
            key={approval.id}
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
              <Icon name="circle-alert" size={16} color={tone.waiting} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{ ...fontStyle(theme, 500), fontSize: 14, lineHeight: 20, color: c.fg }}
                numberOfLines={2}
              >
                {messages.formatToolName(approval.name)}
              </Text>
              <ScrollView
                style={{
                  marginTop: 8,
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
              <View
                style={{ marginTop: 12, flexDirection: "row", justifyContent: "flex-end", gap: 8 }}
              >
                <Button
                  icon="check"
                  variant="primary"
                  label={settled[approval.id] === "approve" ? messages.approved : messages.approve}
                  busy={pending[approval.id] === "approve"}
                  disabled={busy}
                  onPress={() => void decide(approval.id, "approve")}
                />
                <Button
                  icon="x"
                  variant="destructive"
                  label={settled[approval.id] === "reject" ? messages.rejected : messages.reject}
                  busy={pending[approval.id] === "reject"}
                  disabled={busy}
                  onPress={() => void decide(approval.id, "reject")}
                />
              </View>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}
