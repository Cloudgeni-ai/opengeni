import { groupSessionsByProject, sessionDisplayTitle } from "@opengeni/react/session-list-model";
import type { Channel, Session } from "@opengeni/sdk";
import {
  fontStyle,
  Icon,
  SessionRowList,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { AppThemeProvider } from "@/theme";
import { WorkspaceSwitcherBlock } from "@/workspace-switcher";

export default function SessionsScreen() {
  return (
    <AppThemeProvider>
      <Sessions />
    </AppThemeProvider>
  );
}

/* The web rail's session list at phone width: search, then the workspace's
   projects in their server order (running sessions first in each), then
   Default for unfiled sessions (shared grouping rules). */
function Sessions() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { client, models, workspaceId } = useAccount();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      const [list, channels] = await Promise.all([
        client.listSessions(workspaceId, { limit: 100 }),
        client.listChannels(workspaceId).catch(() => [] as Channel[]),
      ]);
      setSessions(list);
      setProjects(channels);
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = needle
      ? sessions.filter((session) => sessionDisplayTitle(session).toLowerCase().includes(needle))
      : sessions;
    // As on web, projects show even when empty, so a new one is visible at once.
    return groupSessionsByProject(visible, projects, { keepEmpty: !needle });
  }, [projects, query, sessions]);
  const open = (sessionId: string) => router.push(`/session/${sessionId}`);

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
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
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
        {sections.map((section) => (
          <View key={section.key} style={{ marginTop: 16 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 4,
                marginBottom: 2,
              }}
            >
              <Icon name="folder" size={13} color={c["fg-subtle"]} />
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
                {section.name}
              </Text>
              <Text style={{ ...fontStyle(theme), fontSize: 11, color: c["fg-subtle"] }}>
                {section.sessions.length}
              </Text>
            </View>
            <SessionRowList sessions={section.sessions} models={models} onOpen={open} />
          </View>
        ))}
        {!loading && sections.length === 0 ? (
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
