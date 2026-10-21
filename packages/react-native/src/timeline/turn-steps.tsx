import type { TurnStepsItem } from "@opengeni/react/session";
import { useOpenGeniText } from "@opengeni/react/messages";
import { useEffect } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/**
 * Loads an opened turn's steps (web TurnStepsLoader). The fold mounts its body
 * only while open, so steps are read when a reader opens the turn.
 */
export function TurnStepsLoader({ steps }: { steps: TurnStepsItem }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const { state, load, retain } = steps;
  useEffect(() => retain(), [retain]);
  useEffect(() => {
    if (state === "idle") load();
  }, [state, load]);
  if (state === "complete") return null;
  const text = {
    ...fontStyle(theme),
    fontSize: theme.size.sm,
    lineHeight: 18,
    color: theme.colors["fg-subtle"],
  };
  if (state === "partial" || state === "error") {
    const label =
      state === "partial"
        ? t("timeline.turnSteps.showEarlierSteps")
        : `${t("timeline.turnSteps.couldNotLoadSteps")} ${t("timeline.turnSteps.retry")}`;
    return (
      <Pressable
        accessibilityRole="button"
        onPress={load}
        style={({ pressed }) => ({
          minHeight: 44,
          justifyContent: "center",
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Text style={text}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <View
      accessibilityRole="progressbar"
      style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 }}
    >
      <ActivityIndicator size="small" color={theme.colors["fg-subtle"]} />
      <Text style={text}>{t("timeline.turnSteps.loadingSteps")}</Text>
    </View>
  );
}
