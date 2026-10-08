import {
  NativeInboxList,
  useNativeInbox,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import type { InboxItem } from "@opengeni/sdk";
import * as Haptics from "expo-haptics";
import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { syncInboxBadge } from "@/notifications";
import { AppThemeProvider } from "@/theme";

export default function InboxScreen() {
  return (
    <AppThemeProvider>
      <Inbox />
    </AppThemeProvider>
  );
}

/* The web Inbox page at phone width. Tapping a row opens its session; the
   row's buttons approve, deny or answer in place. */
function Inbox() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { client, workspaces, workspaceId, setWorkspaceId } = useAccount();
  const inbox = useNativeInbox(client, { pollMs: 10_000 });
  const refreshInbox = inbox.refresh;
  const [pulling, setPulling] = useState(false);
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  );

  useFocusEffect(
    useCallback(() => {
      void refreshInbox();
    }, [refreshInbox]),
  );
  // The app badge and delivered notifications follow what is still open.
  useEffect(() => {
    if (inbox.data) void syncInboxBadge(inbox.data);
  }, [inbox.data]);

  const open = (item: InboxItem) => {
    if (item.workspaceId !== workspaceId) setWorkspaceId(item.workspaceId);
    router.push(`/session/${item.sessionId}`);
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "Inbox",
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: c.bg }}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => {
              setPulling(true);
              void inbox.refresh().finally(() => setPulling(false));
            }}
          />
        }
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 32 }}
      >
        <NativeInboxList
          client={client}
          inbox={inbox}
          workspaceNames={workspaceNames}
          onOpenSession={open}
          onNotice={() => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)}
        />
      </ScrollView>
    </>
  );
}
