import { MeetingsList } from "@opengeni/react-native/meetings";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { WorkspaceGate } from "@/meetings";
import { AppThemeProvider } from "@/theme";
import { TabScreen, tabHeaderOptions } from "@/app-tab-bar";
import { TAB_BAR_HEIGHT, tabBarClearance } from "@/app-tabs";

export default function MeetingsScreen() {
  return (
    <AppThemeProvider>
      <TabScreen tab="meetings">
        <WorkspaceGate title="Meetings">
          {(workspaceId) => <Meetings workspaceId={workspaceId} />}
        </WorkspaceGate>
      </TabScreen>
    </AppThemeProvider>
  );
}

/* The web Meetings page at phone width: the recorder on top, then every
   meeting the person can see, newest first. */
const themed = (node: React.ReactNode) => <AppThemeProvider>{node}</AppThemeProvider>;

function Meetings({ workspaceId }: { workspaceId: string }) {
  const c = useNativeTimelineTheme().colors;
  const insets = useSafeAreaInsets();
  const { client } = useAccount();
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  return (
    <>
      <Stack.Screen
        options={{
          title: "Meetings",
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
          ...tabHeaderOptions(themed),
        }}
      />
      <MeetingsList
        client={client}
        workspaceId={workspaceId}
        focused={focused}
        // The list scrolls under the floating bar and ends clear of it (iOS
        // already keeps it clear of the home indicator).
        bottomInset={Platform.OS === "ios" ? TAB_BAR_HEIGHT + 16 : tabBarClearance(insets.bottom)}
        onOpen={(id) => router.push(`/meeting/${id}`)}
      />
    </>
  );
}
