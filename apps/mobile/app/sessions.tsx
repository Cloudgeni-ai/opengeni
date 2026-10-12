import { groupSessionsByProject, sessionDisplayTitle } from "@opengeni/react/session-list-model";
import type { Channel, Session } from "@opengeni/sdk";
import {
  fontStyle,
  Icon,
  SessionRowList,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { cachedLists, rememberLists } from "@/session-list-cache";
import { EMPTY_SESSION_LISTS, useSessionPinToggle, type SessionLists } from "@/session-pins";
import { AppThemeProvider } from "@/theme";
import { WorkspaceSwitcherBlock } from "@/workspace-switcher";

export default function SessionsScreen() {
  return (
    <AppThemeProvider>
      <Sessions />
    </AppThemeProvider>
  );
}

/* The web rail's session list at phone width: search, the person's pinned
   chats, then the workspace's projects in their server order (running
   sessions first in each), then Default for unfiled sessions (shared grouping
   rules). A long press on a row pins or unpins it, as on the web. */
function Sessions() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { client, models, workspaceId } = useAccount();
  // The last list paints at once; refreshes run quietly behind it.
  const [lists, setLists] = useState<SessionLists>(
    () => cachedLists(workspaceId).sessions ?? EMPTY_SESSION_LISTS,
  );
  const [projects, setProjects] = useState<Channel[]>(
    () => cachedLists(workspaceId).projects ?? [],
  );
  const [loaded, setLoaded] = useState(() => cachedLists(workspaceId).sessions !== undefined);
  const [pulling, setPulling] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [page, channels] = await Promise.all([
        // Top-level conversations, as web's rail: sub-agents open from their
        // parent. The page also carries every pin, wherever it is.
        client.listSessionPage(workspaceId, { limit: 100, parentSessionId: null }),
        client.listChannels(workspaceId).catch(() => [] as Channel[]),
      ]);
      const next = { pinned: page.pinned, sessions: page.sessions };
      rememberLists(workspaceId, { sessions: next, projects: channels });
      setLists(next);
      setProjects(channels);
    } finally {
      setLoaded(true);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    const cached = cachedLists(workspaceId);
    setLists(cached.sessions ?? EMPTY_SESSION_LISTS);
    setProjects(cached.projects ?? []);
    setLoaded(cached.sessions !== undefined);
  }, [workspaceId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Keep the cache in step with pin changes, so returning shows them at once.
  useEffect(() => {
    if (workspaceId && loaded) rememberLists(workspaceId, { sessions: lists });
  }, [lists, loaded, workspaceId]);
  const togglePin = useSessionPinToggle({ client, workspaceId, setLists });

  const { pinned, sections } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (session: Session) =>
      !needle || sessionDisplayTitle(session).toLowerCase().includes(needle);
    return {
      pinned: lists.pinned.filter(matches),
      // As on web, projects show even when empty, so a new one is visible at once.
      sections: groupSessionsByProject(lists.sessions.filter(matches), projects, {
        keepEmpty: !needle,
      }),
    };
  }, [lists, projects, query]);
  const open = (sessionId: string) => router.push(`/session/${sessionId}`);
  const onTogglePin = (session: Session) => void togglePin(session);

  return (
    <>
      <Stack.Screen
        options={{
          title: "Sessions",
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: c.bg }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => {
              setPulling(true);
              void load().finally(() => setPulling(false));
            }}
          />
        }
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: insets.bottom + 24 }}
      >
        <View style={{ marginTop: 4, marginHorizontal: -4 }}>
          <WorkspaceSwitcherBlock />
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            height: 40,
            paddingHorizontal: 12,
            marginTop: 8,
            marginBottom: 12,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c["surface-1"],
          }}
        >
          <Icon name="search" size={14} color={c["fg-subtle"]} />
          <TextInput
            accessibilityLabel="Search sessions"
            value={query}
            onChangeText={setQuery}
            placeholder="Search sessions"
            placeholderTextColor={c["fg-subtle"]}
            autoCorrect={false}
            style={{ ...fontStyle(theme), flex: 1, fontSize: 14, color: c.fg }}
          />
        </View>
        {pinned.length > 0 ? (
          <View style={{ marginTop: 16 }}>
            <SectionHeader icon="pin" name="Pinned" count={pinned.length} />
            <SessionRowList
              sessions={pinned}
              models={models}
              onOpen={open}
              onTogglePin={onTogglePin}
            />
          </View>
        ) : null}
        {sections.map((section) => (
          <View key={section.key} style={{ marginTop: 16 }}>
            <SectionHeader icon="folder" name={section.name} count={section.sessions.length} />
            <SessionRowList
              sessions={section.sessions}
              models={models}
              onOpen={open}
              onTogglePin={onTogglePin}
            />
          </View>
        ))}
        {!loaded ? (
          <ActivityIndicator style={{ marginTop: 32 }} color={c["fg-muted"]} />
        ) : sections.length === 0 && pinned.length === 0 ? (
          <Text
            style={{
              ...fontStyle(theme),
              fontSize: 13,
              color: c["fg-muted"],
              textAlign: "center",
              marginTop: 32,
            }}
          >
            {query.trim() ? "No sessions match your search." : "No sessions yet."}
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}

function SectionHeader(props: { icon: "pin" | "folder"; name: string; count: number }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 4,
        marginBottom: 2,
      }}
    >
      <Icon name={props.icon} size={13} color={c["fg-subtle"]} />
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={{
          ...fontStyle(theme, 600),
          fontSize: 12,
          lineHeight: 16,
          color: c["fg-muted"],
          flexShrink: 1,
        }}
      >
        {props.name}
      </Text>
      <Text style={{ ...fontStyle(theme), fontSize: 11, color: c["fg-subtle"] }}>
        {props.count}
      </Text>
    </View>
  );
}
