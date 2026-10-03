import type {
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
} from "@opengeni/react/timeline-model";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Button } from "./controls";
import { Icon } from "./icon";
import { withAlpha } from "./primitives";
import { fontStyle, useNativeTimelineTheme } from "./theme";

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
}

/** One decision shell for pending requests, oldest first, "N of M" when stepping. */
export function HumanInputCard({
  requests,
  onSubmit,
  respondingRequestId = null,
  error,
}: HumanInputCardProps) {
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
    <HumanInputForm
      key={active.id}
      request={active}
      progressLabel={batchTotal.current > 1 ? `${position} of ${batchTotal.current}` : null}
      submitting={respondingRequestId !== null}
      error={error ?? null}
      onSubmit={(response) => onSubmit(active.id, response)}
    />
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
  const messages = defaultHumanInputFormMessages;
  const heading = humanInputHeading(request.questions, messages);
  const single = request.questions.length === 1;
  const required = single && request.questions[0]!.required;
  const [drafts, setDrafts] = useState<Record<string, HumanInputAnswerDraft>>(() =>
    initialDrafts(request.questions),
  );
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
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInFlight(false);
    }
  };
  const send = () => {
    const result = answersFromDrafts(request.questions, drafts, messages);
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    void submit({
      outcome: "answered",
      answers: result.answers,
    } as SubmitHumanInputResponseRequest);
  };
  const update = (id: string, next: (draft: HumanInputAnswerDraft) => HumanInputAnswerDraft) =>
    setDrafts((current) => ({ ...current, [id]: next(current[id] ?? emptyDraft()) }));

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
                error={errors[question.id]}
                disabled={busy}
                onChange={(next) => update(question.id, next)}
              />
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
                disabled={busy}
                onPress={() =>
                  void submit({ outcome: "skipped" } as SubmitHumanInputResponseRequest)
                }
              />
            ) : null}
            <Button
              label={busy ? messages.submitting : messages.submit}
              variant="primary"
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
}: {
  question: HumanInputQuestion;
  index: number | null;
  draft: HumanInputAnswerDraft;
  error?: string | undefined;
  disabled: boolean;
  onChange: (next: (draft: HumanInputAnswerDraft) => HumanInputAnswerDraft) => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const messages = defaultHumanInputFormMessages;
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
      {question.kind === "text" ? (
        <TextInput
          accessibilityLabel={question.label ?? question.prompt}
          editable={!disabled}
          multiline
          value={draft.values[0] ?? ""}
          onChangeText={(text) => onChange((current) => ({ ...current, values: [text] }))}
          placeholder="Type your answer..."
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
                  placeholder="Type a value..."
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

function Selector({ multi, selected }: { multi: boolean; selected: boolean }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View
      style={{
        marginTop: 2,
        width: 14,
        height: 14,
        borderRadius: multi ? 3 : 7,
        borderWidth: 1,
        borderColor: selected ? c.accent : c["fg-muted"],
        backgroundColor: selected && multi ? c.accent : c["surface-1"],
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {selected ? (
        multi ? (
          <Icon name="check" size={10} color={c["accent-fg"]} strokeWidth={3} />
        ) : (
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.accent }} />
        )
      ) : null}
    </View>
  );
}

export interface ApprovalStripProps {
  approvals: PendingApproval[];
  onDecide: (approvalId: string, decision: "approve" | "reject") => void | Promise<void>;
}

/** The web live decision strip: one waiting Notice per pending tool approval. */
export function ApprovalStrip({ approvals, onDecide }: ApprovalStripProps) {
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
    <ScrollView
      style={{ maxHeight: 256 }}
      contentContainerStyle={{ gap: 12, paddingBottom: 8 }}
      nestedScrollEnabled
    >
      {approvals.map((approval) => {
        const busy = Boolean(pending[approval.id]) || Boolean(settled[approval.id]);
        const payload = JSON.stringify(approval.arguments ?? approval.raw ?? {}, null, 2);
        return (
          <View
            key={approval.id}
            style={{
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: tone.border,
              backgroundColor: tone.surface,
              padding: 14,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Icon name="triangle-alert" size={14} color={tone.waiting} />
              <Text
                style={{ ...fontStyle(theme, 600), flex: 1, fontSize: 14, color: tone.waiting }}
                numberOfLines={1}
              >
                {approval.name}
              </Text>
            </View>
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
                label={settled[approval.id] === "approve" ? "Approved" : "Approve"}
                busy={pending[approval.id] === "approve"}
                disabled={busy}
                onPress={() => void decide(approval.id, "approve")}
              />
              <Button
                icon="x"
                variant="destructive"
                label={settled[approval.id] === "reject" ? "Rejected" : "Reject"}
                busy={pending[approval.id] === "reject"}
                disabled={busy}
                onPress={() => void decide(approval.id, "reject")}
              />
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}
