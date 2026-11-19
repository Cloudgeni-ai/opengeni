import { NativeInboxList, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import type { InboxEntry } from "@opengeni/sdk";
import * as Haptics from "expo-haptics";
import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshControl, ScrollView } from "react-native";
import { useAccount } from "@/account";
import { TabScreen, tabHeaderOptions } from "@/app-tab-bar";
import { useAppInbox } from "@/inbox-store";
import { syncInboxBadge } from "@/notifications";
import { AppThemeProvider } from "@/theme";

export default function InboxScreen() {
  return (
    <AppThemeProvider>
      <TabScreen tab="inbox">
        <Inbox />
      </TabScreen>
    </AppThemeProvider>
  );
}

const themed = (node: ReactNode) => <AppThemeProvider>{node}</AppThemeProvider>;

/* The web Inbox page at phone width. Tapping a row opens its session; the
   row's buttons approve, deny or answer in place. */
function Inbox() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { client, workspaces, workspaceId, setWorkspaceId } = useAccount();
  // The same inbox as the bar's badge, so both change together.
  const inbox = useAppInbox();
  const refreshInbox = inbox.refresh;
  const [pulling, setPulling] = useState(false);
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  );

  useFocusEffect(
    useCallback(() => {
      void refreshInbox();
      // Re-read more often while the list is on screen.
      const timer = setInterval(() => void refreshInbox(), 10_000);
      return () => clearInterval(timer);
    }, [refreshInbox]),
  );
  // The app badge and delivered notifications follow what is still open.
  useEffect(() => {
    if (inbox.data) void syncInboxBadge(inbox.data);
  }, [inbox.data]);

  const open = (item: InboxEntry) => {
    // A notice about something other than a chat opens its link instead.
    if (item.sessionId === null) return;
    if (item.workspaceId !== workspaceId) setWorkspaceId(item.workspaceId);
    // Opens on the moment the item was raised.
    router.push(
      item.eventSequence
        ? `/session/${item.sessionId}?at=${item.eventSequence}`
        : `/session/${item.sessionId}`,
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "Inbox",
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
          ...tabHeaderOptions(themed),
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
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
      >
        <NativeInboxList
          client={client}
          inbox={inbox}
          workspaceNames={workspaceNames}
          onOpenSession={open}
          onNotice={() => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)}
          onSwipeThreshold={() => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
        />
      </ScrollView>
    </>
  );
}
