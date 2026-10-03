import type { PendingApproval, PendingHumanInputRequest } from "@opengeni/react/session";
import { toolDisplayName } from "@opengeni/react/session";
import type { HumanInputAnswer } from "@opengeni/sdk";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { FadeInDown, FadeOutDown, LinearTransition } from "react-native-reanimated";
import { ActionButton } from "./cards";
import { toolDetail } from "./format";
import { AgentIcon } from "./icons";
import type { AgentTheme } from "./theme";

type Attention =
  | { kind: "approval"; approval: PendingApproval }
  | { kind: "question"; request: PendingHumanInputRequest };

function approvalSummary(approval: PendingApproval): string | null {
  return toolDetail({ kind: "tool-call", id: approval.id, turnId: null, callId: null, name: approval.name, arguments: approval.arguments, output: null, raw: null, status: "running", occurredAt: "" });
}

/**
 * Everything the agent is waiting on, docked directly above the composer. One item at a
 * time with a counter; decisions never scroll away with the conversation.
 */
export function AgentAttentionTray(props: {
  approvals: readonly PendingApproval[];
  humanInput: readonly PendingHumanInputRequest[];
  theme: AgentTheme;
  onApproval(approvalId: string, decision: "approve" | "reject"): void;
  onAnswer(requestId: string, answers: HumanInputAnswer[] | null): void;
}) {
  const { theme } = props;
  const items: Attention[] = [
    ...props.approvals.map((approval) => ({ kind: "approval" as const, approval })),
    ...props.humanInput.map((request) => ({ kind: "question" as const, request })),
  ];
  const [selected, setSelected] = useState<string[]>([]);
  const current = items[0];
  if (!current) return null;
  const key = current.kind === "approval" ? `a:${current.approval.id}` : `q:${current.request.id}`;
  const question = current.kind === "question" ? current.request.questions[0] : undefined;
  const multi = question?.kind === "multi_select";

  return (
    <Animated.View
      entering={FadeInDown.duration(220)}
      exiting={FadeOutDown.duration(160)}
      key={key}
      layout={LinearTransition.duration(180)}
      style={{
        marginHorizontal: 12,
        marginBottom: 6,
        borderRadius: theme.radius.card,
        backgroundColor: theme.colors.surfaceRaised,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: theme.colors.attention,
        padding: 14,
        gap: 10,
        shadowColor: "#000",
        shadowOpacity: theme.scheme === "light" ? 0.1 : 0,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 6 },
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AgentIcon color={theme.colors.attention} name={current.kind === "approval" ? "alert" : "question"} size={15} />
        <Text style={{ flex: 1, color: theme.colors.attention, fontSize: theme.type.small, fontWeight: "600" }}>
          {current.kind === "approval" ? "Approve to continue" : "Answer to continue"}
        </Text>
        {items.length > 1 ? <Text style={{ color: theme.colors.textFaint, fontSize: theme.type.small }}>1 of {items.length}</Text> : null}
      </View>
      {current.kind === "approval" ? (
        <>
          <View>
            <Text style={{ color: theme.colors.text, fontSize: theme.type.body, fontWeight: theme.type.weightStrong }}>
              {toolDisplayName(current.approval.name, current.approval.display)}
            </Text>
            {approvalSummary(current.approval) ? (
              <Text numberOfLines={2} style={{ marginTop: 2, color: theme.colors.textMuted, fontSize: theme.type.small, lineHeight: theme.type.smallLine }}>
                {approvalSummary(current.approval)}
              </Text>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <ActionButton flex label="Deny" onPress={() => props.onApproval(current.approval.id, "reject")} theme={theme} variant="secondary" />
            <ActionButton flex label="Approve" onPress={() => props.onApproval(current.approval.id, "approve")} theme={theme} variant="primary" />
          </View>
        </>
      ) : question ? (
        <>
          <Text style={{ color: theme.colors.text, fontSize: theme.type.body, fontWeight: theme.type.weightStrong }}>{question.prompt}</Text>
          <ScrollView contentContainerStyle={{ gap: 8 }} horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false}>
            {question.options.map((option) => {
              const active = selected.includes(option.id);
              return (
                <Pressable
                  accessibilityRole={multi ? "checkbox" : "radio"}
                  accessibilityState={{ checked: active }}
                  key={option.id}
                  onPress={() =>
                    setSelected((values) =>
                      multi ? (values.includes(option.id) ? values.filter((value) => value !== option.id) : [...values, option.id]) : [option.id],
                    )
                  }
                  style={{
                    minHeight: theme.layout.target - 4,
                    paddingHorizontal: 14,
                    borderRadius: theme.radius.control,
                    justifyContent: "center",
                    backgroundColor: active ? theme.colors.accent : theme.colors.surface,
                  }}
                >
                  <Text style={{ color: active ? theme.colors.onAccent : theme.colors.text, fontSize: theme.type.body - 1, fontWeight: "600" }}>{option.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={{ flexDirection: "row", gap: 10 }}>
            {current.request.allowSkip ? (
              <ActionButton flex label="Skip" onPress={() => props.onAnswer(current.request.id, null)} theme={theme} variant="secondary" />
            ) : null}
            <ActionButton
              disabled={selected.length === 0}
              flex
              label="Send"
              onPress={() => {
                props.onAnswer(current.request.id, [{ questionId: question.id, values: selected }]);
                setSelected([]);
              }}
              theme={theme}
              variant="primary"
            />
          </View>
        </>
      ) : null}
    </Animated.View>
  );
}