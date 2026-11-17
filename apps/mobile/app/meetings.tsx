import { MeetingsList } from "@opengeni/react-native/meetings";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";

import { useAccount } from "@/account";
import { WorkspaceGate } from "@/meetings";
import { AppThemeProvider } from "@/theme";
import { TabScreen, tabHeaderOptions } from "@/app-tab-bar";

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
        // The docked bar sits below the list and keeps the home indicator's area.
        bottomInset={0}
        onOpen={(id) => router.push(`/meeting/${id}`)}
      />
    </>
  );
}
