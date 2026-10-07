import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon, type NativeIconName } from "../timeline/icon";
import { ThinkingOrb } from "../timeline/thinking-orb";
import { fontStyle, useNativeTimelineTheme } from "../timeline/theme";
import type { NativeRealtimeCall } from "./native-call";

export type OpenGeniNativeCallLabels = {
  connecting: string;
  live: string;
  reconnecting: string;
  ending: string;
  muted: string;
  mute: string;
  unmute: string;
  speaker: string;
  end: string;
  minimize: string;
};

export const DEFAULT_OPENGENI_NATIVE_CALL_LABELS: OpenGeniNativeCallLabels = {
  connecting: "Connecting…",
  live: "Listening",
  reconnecting: "Reconnecting…",
  ending: "Ending…",
  muted: "Muted",
  mute: "Mute",
  unmute: "Unmute",
  speaker: "Speaker",
  end: "End",
  minimize: "Back to chat",
};

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function useCallDuration(active: boolean): number | null {
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return setSince(null);
    setSince((current) => current ?? Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return since === null ? null : Math.max(0, Math.floor((now - since) / 1000));
}

function CallButton({
  icon,
  label,
  onPress,
  selected = false,
  destructive = false,
  disabled = false,
}: {
  icon: NativeIconName;
  label: string;
  onPress: () => void;
  selected?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}) {
  const theme = useNativeTimelineTheme();
  const { colors } = theme;
  // Hanging up is the system's solid red in either appearance, like the Phone app.
  const hangUp = theme.scheme === "dark" ? "#FF453A" : "#FF3B30";
  const background = destructive ? hangUp : selected ? colors.fg : colors["surface-2"];
  const foreground = destructive ? "#FFFFFF" : selected ? colors.bg : colors.fg;
  return (
    <View style={styles.buttonColumn}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected, disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: background, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
        ]}
      >
        <Icon name={icon} size={26} color={foreground} />
      </Pressable>
      <Text style={[styles.buttonLabel, fontStyle(theme, 500), { color: colors["fg-muted"] }]}>
        {label}
      </Text>
    </View>
  );
}

/**
 * The full-screen call with an agent: the web's thinking orb, the call state,
 * and mute, speaker and end controls. The host owns navigation (`onMinimize`
 * returns to the conversation while the call continues) and safe areas.
 */
export function OpenGeniNativeCallView({
  call,
  title,
  subtitle,
  onMinimize,
  labels: labelOverrides,
}: {
  call: NativeRealtimeCall;
  title: string;
  subtitle?: string | null | undefined;
  onMinimize?: (() => void) | undefined;
  labels?: Partial<OpenGeniNativeCallLabels> | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const { colors } = theme;
  const labels = { ...DEFAULT_OPENGENI_NATIVE_CALL_LABELS, ...labelOverrides };
  const duration = useCallDuration(call.phase === "active");
  const status =
    call.phase === "connecting" || call.phase === "idle"
      ? labels.connecting
      : call.phase === "reconnecting"
        ? labels.reconnecting
        : call.phase === "ending"
          ? labels.ending
          : call.muted
            ? labels.muted
            : labels.live;
  const orbState =
    call.phase === "active" ? (call.muted ? "breathing" : "listening") : "connecting";
  const live = call.phase !== "idle" && call.phase !== "ending";
  return (
    <View style={[styles.screen, { backgroundColor: colors.canvas }]} testID="opengeni-call">
      <View style={styles.header}>
        {onMinimize ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={labels.minimize}
            hitSlop={12}
            onPress={onMinimize}
            style={({ pressed }) => [styles.minimize, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Icon name="chevron-down" size={24} color={colors["fg-muted"]} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.center}>
        <ThinkingOrb state={orbState} size={64} displaySize={176} speed={0.7} />
        <Text
          style={[styles.title, fontStyle(theme, 600), { color: colors.fg }]}
          numberOfLines={2}
          accessibilityRole="header"
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={[styles.subtitle, fontStyle(theme, 400), { color: colors["fg-muted"] }]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        ) : null}
        <Text
          style={[styles.status, fontStyle(theme, 500), { color: colors["fg-muted"] }]}
          accessibilityLiveRegion="polite"
        >
          {duration !== null && !call.muted ? `${status} · ${formatDuration(duration)}` : status}
        </Text>
        {call.error ? (
          <Text style={[styles.error, fontStyle(theme, 400), { color: colors.danger }]}>
            {call.error}
          </Text>
        ) : null}
      </View>
      <View style={styles.controls}>
        <CallButton
          icon={call.muted ? "mic-off" : "mic"}
          label={call.muted ? labels.unmute : labels.mute}
          selected={call.muted}
          disabled={!live}
          onPress={() => call.setMuted(!call.muted)}
        />
        <CallButton
          icon="volume-2"
          label={labels.speaker}
          selected={call.speaker}
          disabled={!live}
          onPress={() => call.setSpeaker(!call.speaker)}
        />
        <CallButton
          icon="phone-off"
          label={labels.end}
          destructive
          disabled={call.phase === "idle" || call.phase === "ending"}
          onPress={() => void call.end()}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 24, paddingBottom: 32 },
  header: { height: 52, flexDirection: "row", alignItems: "center" },
  minimize: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  title: { fontSize: 26, lineHeight: 32, textAlign: "center", marginTop: 28 },
  subtitle: { fontSize: 15, lineHeight: 20, textAlign: "center" },
  status: { fontSize: 17, lineHeight: 22, marginTop: 4, fontVariant: ["tabular-nums"] },
  error: { fontSize: 15, lineHeight: 20, textAlign: "center", marginTop: 8 },
  controls: { flexDirection: "row", justifyContent: "space-evenly", alignItems: "flex-start" },
  buttonColumn: { alignItems: "center", gap: 8, width: 88 },
  button: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonLabel: { fontSize: 13, lineHeight: 16 },
});
