import { resolveWorkspaceRecordingSettings } from "@opengeni/contracts";
import { MeetingsList } from "@opengeni/react-native/meetings";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { WorkspaceGate } from "@/meetings";
import { AppThemeProvider } from "@/theme";

export default function MeetingsScreen() {
  return (
    <AppThemeProvider>
      <WorkspaceGate title="Meetings">
        {(workspaceId) => <Meetings workspaceId={workspaceId} />}
      </WorkspaceGate>
    </AppThemeProvider>
  );
}

/* The web Meetings page at phone width: the recorder on top, then every
   meeting the person can see, newest first. */
function Meetings({ workspaceId }: { workspaceId: string }) {
  const c = useNativeTimelineTheme().colors;
  const insets = useSafeAreaInsets();
  const { client, workspace } = useAccount();
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const liveDefault =
    resolveWorkspaceRecordingSettings(workspace?.id === workspaceId ? workspace.settings : null)
      .liveTranscript === true;
  return (
    <>
      <Stack.Screen
        options={{
          title: "Meetings",
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
        }}
      />
      <MeetingsList
        client={client}
        workspaceId={workspaceId}
        liveTranscriptDefault={liveDefault}
        focused={focused}
        // iOS keeps the list clear of the home indicator by itself.
        bottomInset={Platform.OS === "ios" ? 0 : insets.bottom}
        onOpen={(id) => router.push(`/meeting/${id}`)}
      />
    </>
  );
}
