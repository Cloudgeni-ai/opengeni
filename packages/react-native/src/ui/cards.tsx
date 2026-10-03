import type { PendingApproval, PendingHumanInputRequest } from "@opengeni/react/session";
import { toolDisplayName } from "@opengeni/react/session";
import type { HumanInputAnswer } from "@opengeni/sdk";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { AgentIcon } from "./icons";
import type { AgentTheme } from "./theme";

function argumentRows(args: unknown): [string, string][] {
  if (!args || typeof args !== "object") return [];
  return Object.entries(args as Record<string, unknown>)
    .slice(0, 4)
    .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
}

export function ActionButton(props: {
  label: string;
  onPress(): void;
  theme: AgentTheme;
  variant: "primary" | "secondary" | "danger";
  disabled?: boolean;
  flex?: boolean;
}) {
  const { theme, variant } = props;
  const primary = variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => ({
        flex: props.flex ? 1 : undefined,
        minHeight: theme.layout.target,
        paddingHorizontal: 18,
        borderRadius: theme.radius.control,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: primary ? theme.colors.accent : "transparent",
        borderWidth: primary ? 0 : StyleSheet.hairlineWidth * 2,
        borderColor: variant === "danger" ? theme.colors.danger : theme.colors.border,
        opacity: props.disabled ? 0.4 : pressed ? 0.75 : 1,
      })}
    >
      <Text
        style={{
          color: primary ? theme.colors.onAccent : variant === "danger" ? theme.colors.danger : theme.colors.text,
          fontSize: theme.type.body - 1,
          fontWeight: theme.type.weightStrong,
        }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function CardShell(props: { theme: AgentTheme; icon: "alert" | "question"; eyebrow: string; title: string; children: React.ReactNode }) {
  const { theme } = props;
  return (
    <View
      style={{
        marginVertical: theme.space.row,
        borderRadius: theme.radius.card,
        backgroundColor: theme.colors.surfaceRaised,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: theme.colors.attention,
        padding: 16,
        gap: 12,
        shadowColor: "#000",
        shadowOpacity: theme.scheme === "light" ? 0.06 : 0,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AgentIcon color={theme.colors.attention} name={props.icon} size={16} />
        <Text style={{ color: theme.colors.attention, fontSize: theme.type.small, fontWeight: "600", letterSpacing: 0.2 }}>
          {props.eyebrow}
        </Text>
      </View>
      <Text style={{ color: theme.colors.text, fontSize: theme.type.body + 1, lineHeight: theme.type.bodyLine + 1, fontWeight: theme.type.weightStrong }}>
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

export function ApprovalCard(props: { approval: PendingApproval; theme: AgentTheme; onDecision(decision: "approve" | "reject"): void }) {
  const { approval, theme } = props;
  const rows = argumentRows(approval.arguments);
  return (
    <CardShell eyebrow="Needs your approval" icon="alert" theme={theme} title={toolDisplayName(approval.name, approval.display)}>
      {rows.length ? (
        <View style={{ borderRadius: theme.radius.control, backgroundColor: theme.colors.codeBackground, padding: 10, gap: 4 }}>
          {rows.map(([key, value]) => (
            <View key={key} style={{ flexDirection: "row", gap: 8 }}>
              <Text style={{ color: theme.colors.textFaint, fontSize: theme.type.small, fontFamily: theme.type.mono }}>{key}</Text>
              <Text numberOfLines={2} style={{ flex: 1, color: theme.colors.text, fontSize: theme.type.small, fontFamily: theme.type.mono }}>
                {value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <ActionButton flex label="Deny" onPress={() => props.onDecision("reject")} theme={theme} variant="secondary" />
        <ActionButton flex label="Approve" onPress={() => props.onDecision("approve")} theme={theme} variant="primary" />
      </View>
    </CardShell>
  );
}

export function QuestionCard(props: {
  request: PendingHumanInputRequest;
  theme: AgentTheme;
  onAnswer(answers: HumanInputAnswer[] | null): void;
}) {
  const { request, theme } = props;
  const question = request.questions[0];
  const [selected, setSelected] = useState<string[]>([]);
  if (!question) return null;
  const multi = question.kind === "multi_select";
  const toggle = (id: string) =>
    setSelected((current) => (multi ? (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]) : [id]));
  return (
    <CardShell eyebrow="Question for you" icon="question" theme={theme} title={question.prompt}>
      <View style={{ gap: 8 }}>
        {question.options.map((option) => {
          const active = selected.includes(option.id);
          return (
            <Pressable
              accessibilityRole={multi ? "checkbox" : "radio"}
              accessibilityState={{ checked: active }}
              key={option.id}
              onPress={() => toggle(option.id)}
              style={{
                minHeight: theme.layout.target,
                borderRadius: theme.radius.control,
                borderWidth: active ? 2 : StyleSheet.hairlineWidth * 2,
                borderColor: active ? theme.colors.accent : theme.colors.border,
                paddingHorizontal: 14,
                paddingVertical: 10,
                justifyContent: "center",
              }}
            >
              <Text style={{ color: theme.colors.text, fontSize: theme.type.body - 1, fontWeight: "500" }}>{option.label}</Text>
              {option.description ? (
                <Text style={{ color: theme.colors.textMuted, fontSize: theme.type.small, marginTop: 2 }}>{option.description}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        {request.allowSkip ? <ActionButton flex label="Skip" onPress={() => props.onAnswer(null)} theme={theme} variant="secondary" /> : null}
        <ActionButton
          disabled={selected.length === 0}
          flex
          label="Send answer"
          onPress={() => props.onAnswer([{ questionId: question.id, values: selected }])}
          theme={theme}
          variant="primary"
        />
      </View>
    </CardShell>
  );
}