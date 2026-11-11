import type { TurnStepsItem } from "@opengeni/react/session";
import { useOpenGeniText } from "@opengeni/react/messages";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/**
 * Loads an opened turn's steps (web TurnStepsLoader). The fold mounts its body
 * only while open, so steps are read when a reader opens the turn. A row that
 * opens by itself (`autoLoad={false}`) waits for the reader to ask.
 */
export function TurnStepsLoader({
  steps,
  autoLoad = true,
}: {
  steps: TurnStepsItem;
  autoLoad?: boolean | undefined;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const { state, load, retain } = steps;
  const [requested, setRequested] = useState(autoLoad);
  // An open row keeps its steps (live ones too) while mounted; only the
  // read waits for the reader.
  useEffect(() => retain(), [retain]);
  useEffect(() => {
    if (requested && state === "idle") load();
  }, [requested, state, load]);
  if (state === "complete") return null;
  const text = {
    ...fontStyle(theme),
    fontSize: theme.size.sm,
    lineHeight: 18,
    color: theme.colors["fg-subtle"],
  };
  if (state === "partial" || state === "error" || (state === "idle" && !requested)) {
    const label =
      state === "idle"
        ? t("timeline.turnSteps.showSteps")
        : state === "partial"
          ? t("timeline.turnSteps.showEarlierSteps")
          : `${t("timeline.turnSteps.couldNotLoadSteps")} ${t("timeline.turnSteps.retry")}`;
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setRequested(true);
          if (state !== "idle") load();
        }}
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
