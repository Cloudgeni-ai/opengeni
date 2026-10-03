import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AgentIcon } from "./icons";
import type { AgentTheme } from "./theme";

export interface AgentComposerProps {
  theme: AgentTheme;
  value: string;
  onChangeText(text: string): void;
  onSend(): void;
  onStop?(): void;
  onAttach?(): void;
  onVoice?(): void;
  running: boolean;
  placeholder: string;
  /** Chips shown in the bar composer (model, permissions…). */
  accessories?: ReactNode;
  bottomInset: number;
}

function RoundButton(props: { label: string; onPress?(): void; size: number; background: string; children: ReactNode; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      style={({ pressed }) => ({
        width: props.size,
        height: props.size,
        borderRadius: props.size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: props.background,
        opacity: props.disabled ? 0.35 : pressed ? 0.7 : 1,
      })}
    >
      {props.children}
    </Pressable>
  );
}

export function AgentComposer(props: AgentComposerProps) {
  const { theme } = props;
  if (theme.layout.composer === "bar") return <BarComposer {...props} />;
  if (theme.layout.composer === "voice") return <VoiceComposer {...props} />;
  return <PillComposer {...props} />;
}

function SendOrStop(props: AgentComposerProps & { size: number }) {
  const { theme, running, value } = props;
  if (running && !value.trim()) {
    return (
      <RoundButton background={theme.colors.accent} label="Stop" onPress={props.onStop} size={props.size}>
        <AgentIcon color={theme.colors.onAccent} name="stop" size={props.size * 0.4} />
      </RoundButton>
    );
  }
  return (
    <RoundButton background={theme.colors.accent} disabled={!value.trim()} label="Send" onPress={props.onSend} size={props.size}>
      <AgentIcon color={theme.colors.onAccent} name="arrow-up" size={props.size * 0.5} strokeWidth={2.4} />
    </RoundButton>
  );
}

function Input(props: AgentComposerProps & { fontSize: number }) {
  return (
    <TextInput
      accessibilityLabel={props.placeholder}
      multiline
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor={props.theme.colors.textFaint}
      style={{
        flex: 1,
        color: props.theme.colors.text,
        fontSize: props.fontSize,
        minHeight: 40,
        maxHeight: 160,
        paddingTop: Platform.OS === "ios" ? 10 : 8,
        paddingBottom: Platform.OS === "ios" ? 10 : 8,
      }}
      value={props.value}
    />
  );
}

/** Calm: floating pill; Liquid Glass on iOS 26. */
function PillComposer(props: AgentComposerProps) {
  const { theme } = props;
  const glass = Platform.OS === "ios" && isLiquidGlassAvailable();
  const inner = (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, paddingHorizontal: 6, paddingVertical: 6 }}>
      <RoundButton background="transparent" label="Add attachment" onPress={props.onAttach} size={36}>
        <AgentIcon color={theme.colors.text} name="plus" size={20} />
      </RoundButton>
      <Input {...props} fontSize={theme.type.body} />
      {props.value.trim() || props.running ? (
        <SendOrStop {...props} size={36} />
      ) : (
        <RoundButton background="transparent" label="Dictate" onPress={props.onVoice} size={36}>
          <AgentIcon color={theme.colors.text} name="mic" size={19} />
        </RoundButton>
      )}
    </View>
  );
  const shell = {
    borderRadius: theme.radius.composer,
    overflow: "hidden" as const,
    borderWidth: glass ? 0 : StyleSheet.hairlineWidth * 2,
    borderColor: theme.colors.border,
    backgroundColor: glass ? undefined : theme.colors.surfaceRaised,
    shadowColor: "#000",
    shadowOpacity: theme.scheme === "light" ? 0.08 : 0,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  };
  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: Math.max(props.bottomInset, 10) }}>
      {glass ? (
        <GlassView glassEffectStyle="regular" isInteractive style={shell}>
          {inner}
        </GlassView>
      ) : (
        <View style={shell}>{inner}</View>
      )}
    </View>
  );
}

/** Workbench: docked bar with a toolbar row for context chips. */
function BarComposer(props: AgentComposerProps) {
  const { theme } = props;
  return (
    <View
      style={{
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surfaceRaised,
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: Math.max(props.bottomInset, 8),
        gap: 6,
      }}
    >
      <View
        style={{
          borderRadius: theme.radius.composer,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.background,
          paddingHorizontal: 12,
        }}
      >
        <Input {...props} fontSize={theme.type.body} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <RoundButton background={theme.colors.surface} label="Add attachment" onPress={props.onAttach} size={34}>
          <AgentIcon color={theme.colors.text} name="plus" size={18} />
        </RoundButton>
        <RoundButton background={theme.colors.surface} label="Dictate" onPress={props.onVoice} size={34}>
          <AgentIcon color={theme.colors.text} name="mic" size={17} />
        </RoundButton>
        <View style={{ flex: 1, flexDirection: "row", gap: 6 }}>{props.accessories}</View>
        <SendOrStop {...props} size={34} />
      </View>
    </View>
  );
}

/** Field: large field with a dominant voice button. */
function VoiceComposer(props: AgentComposerProps) {
  const { theme } = props;
  const hasText = props.value.trim().length > 0;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10, paddingHorizontal: 14, paddingTop: 8, paddingBottom: Math.max(props.bottomInset, 12) }}>
      <View
        style={{
          flex: 1,
          flexDirection: "row",
          alignItems: "flex-end",
          minHeight: 56,
          borderRadius: theme.radius.composer,
          backgroundColor: theme.colors.surface,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderColor: theme.colors.border,
          paddingLeft: 6,
          paddingRight: 14,
        }}
      >
        <RoundButton background="transparent" label="Add photo or file" onPress={props.onAttach} size={44}>
          <AgentIcon color={theme.colors.text} name="plus" size={24} />
        </RoundButton>
        <Input {...props} fontSize={theme.type.body} />
      </View>
      {hasText || props.running ? (
        <SendOrStop {...props} size={56} />
      ) : (
        <RoundButton background={theme.colors.accent} label="Talk" onPress={props.onVoice} size={56}>
          <AgentIcon color={theme.colors.onAccent} name="mic" size={26} />
        </RoundButton>
      )}
    </View>
  );
}

export function ComposerChip({ theme, label }: { theme: AgentTheme; label: string }) {
  return (
    <View style={{ height: 28, paddingHorizontal: 10, borderRadius: 14, backgroundColor: theme.colors.surface, justifyContent: "center" }}>
      <Text style={{ color: theme.colors.textMuted, fontSize: 12, fontWeight: "500" }}>{label}</Text>
    </View>
  );
}