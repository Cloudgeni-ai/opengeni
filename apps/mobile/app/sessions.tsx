import { groupSessionsForRail, sessionDisplayTitle } from "@opengeni/react/session-list-model";
import type { Session } from "@opengeni/sdk";
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

export default function SessionsScreen() {
  return (
    <AppThemeProvider>
      <Sessions />
    </AppThemeProvider>
  );
}

/* The web rail's session list at phone width: search, running sessions on top,
   then Today / Yesterday / Previous 7 days / Older (shared grouping rules). */
function Sessions() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { client, models, workspaceId, workspaces } = useAccount();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setSessions(await client.listSessions(workspaceId, { limit: 100 }));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = needle
      ? sessions.filter((session) => sessionDisplayTitle(session).toLowerCase().includes(needle))
      : sessions;
    return groupSessionsForRail(visible);
  }, [query, sessions]);
  const workspaceName = workspaces.find((workspace) => workspace.id === workspaceId)?.name;
  const open = (sessionId: string) => router.push(`/session/${sessionId}`);

  return (
    <>
      <Stack.Screen
        options={{
          title: workspaceName ?? "Sessions",
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
        {groups.running.length > 0 ? (
          <SessionRowList sessions={groups.running} models={models} onOpen={open} />
        ) : null}
        {groups.grouped.map((bucket) => (
          <View key={bucket.group} style={{ marginTop: 16 }}>
            <Text
              accessibilityRole="header"
              style={{
                ...fontStyle(theme, 500),
                fontSize: 11,
                lineHeight: 16,
                color: c["fg-subtle"],
                paddingHorizontal: 4,
                marginBottom: 2,
              }}
            >
              {bucket.label}
            </Text>
            <SessionRowList sessions={bucket.sessions} models={models} onOpen={open} />
          </View>
        ))}
        {!loading && groups.running.length === 0 && groups.grouped.length === 0 ? (
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
