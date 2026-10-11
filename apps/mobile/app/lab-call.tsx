// Call lab: the call screen in each phase without a live call, for rendered
// review. Deep link: opengeni://lab-call?phase=active&scheme=dark&muted=0&speaker=1
import { OpenGeniNativeCallView, type NativeRealtimeCall } from "@opengeni/react-native";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppThemeProvider } from "@/theme";

type Params = {
  phase?: NativeRealtimeCall["phase"];
  scheme?: "light" | "dark";
  muted?: string;
  speaker?: string;
  error?: string;
};

export default function CallLab() {
  const params = useLocalSearchParams<Params>();
  return (
    <AppThemeProvider scheme={params.scheme ?? "light"}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Each deep link is a fresh scenario, not an edit of the last one. */}
      <CallLabBody key={JSON.stringify(params)} params={params} />
    </AppThemeProvider>
  );
}

function CallLabBody({ params }: { params: Params }) {
  const insets = useSafeAreaInsets();
  const theme = useNativeTimelineTheme();
  const [muted, setMuted] = useState(params.muted === "1");
  const [speaker, setSpeaker] = useState(params.speaker !== "0");
  const call: NativeRealtimeCall = {
    phase: params.phase ?? "active",
    muted,
    speaker,
    route: speaker ? "speaker" : "receiver",
    error: params.error ?? null,
    systemCall: true,
    canStart: false,
    start: async () => undefined,
    end: async () => undefined,
    setMuted,
    setSpeaker,
  };
  return (
    <View
      style={{
        flex: 1,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        backgroundColor: theme.colors.canvas,
      }}
    >
      <OpenGeniNativeCallView
        call={call}
        title="Release plan for the native app"
        subtitle="Codex Live"
        onMinimize={() => undefined}
      />
    </View>
  );
}
