import { groupSessionsByProject } from "@opengeni/react/session-list-model";
import type { Channel, Session, Workspace } from "@opengeni/sdk";
import {
  fontStyle,
  Icon,
  SessionRowList,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { appSessionPath } from "@/app-links";
import { rankChatSearch, workspacesToSearch } from "@/chat-search";
import { useServerChatSearch } from "@/use-server-chat-search";
import { cachedLists, rememberLists } from "@/session-list-cache";
import { isCapturing, useMeetingRecorder } from "@/meetings";
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
   rules). A long press on a row pins or unpins it, as on the web. Typing
   searches chat titles in all of the person's workspaces, as ⌘K does on the
   web: matching workspaces to switch to, then the chats, this workspace's
   first and the others labelled with their workspace. */
function Sessions() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { client, models, workspaceId, workspaces, organizations, setWorkspaceId, reload } =
    useAccount();
  // Home's search button opens this screen ready to type.
  const { search } = useLocalSearchParams<{ search?: string }>();
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

  const searching = query.trim().length > 0;
  const { pinned, sections } = useMemo(
    () =>
      searching
        ? { pinned: [], sections: [] }
        : {
            pinned: lists.pinned,
            // As on web, projects show even when empty, so a new one is visible at once.
            sections: groupSessionsByProject(lists.sessions, projects, { keepEmpty: true }),
          },
    [lists, projects, searching],
  );
  const searchedWorkspaces = useMemo(
    () => workspacesToSearch(workspaceId, workspaces),
    [workspaceId, workspaces],
  );
  const server = useServerChatSearch(client, searchedWorkspaces, query);
  const results = useMemo(
    () =>
      rankChatSearch({
        query,
        currentWorkspaceId: workspaceId,
        local: [...lists.pinned, ...lists.sessions],
        remote: server.query === query.trim() ? server.hits : [],
        workspaces,
      }),
    [query, workspaceId, lists, server, workspaces],
  );
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces],
  );
  const hitWorkspace = useMemo(
    () => new Map(results.chats.map((hit) => [hit.session.id, hit.workspaceId])),
    [results.chats],
  );
  const open = (sessionId: string) => router.push(`/session/${sessionId}`);
  const openResult = (sessionId: string) => {
    const target = hitWorkspace.get(sessionId) ?? workspaceId;
    if (!target) return open(sessionId);
    // A chat elsewhere opens in its own workspace, which becomes the current one.
    if (target !== workspaceId) setWorkspaceId(target);
    router.push(appSessionPath(sessionId, target, null));
  };
  const switchTo = (workspace: Workspace) => {
    setQuery("");
    setWorkspaceId(workspace.id);
  };
  const organizationOf = (workspace: Workspace) =>
    organizations.length > 1
      ? organizations.find((each) => each.accountId === workspace.accountId)?.label
      : undefined;
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
              // Pull to refresh covers the workspace switcher above the list too.
              void Promise.all([load(), reload()]).finally(() => setPulling(false));
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
            minHeight: 40,
            paddingVertical: 6,
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
            accessibilityLabel="Search chats in all workspaces"
            value={query}
            onChangeText={setQuery}
            placeholder="Search chats and workspaces"
            placeholderTextColor={c["fg-subtle"]}
            autoCorrect={false}
            autoCapitalize="none"
            autoFocus={search === "1"}
            clearButtonMode="while-editing"
            returnKeyType="search"
            onSubmitEditing={() => {
              const first = results.chats[0];
              if (first) openResult(first.session.id);
              else if (results.workspaces[0]) switchTo(results.workspaces[0]);
            }}
            style={{ ...fontStyle(theme), flex: 1, fontSize: 14, color: c.fg }}
          />
        </View>
        {searching ? null : <MeetingsRow />}
        {searching ? (
          <>
            {results.workspaces.length > 0 ? (
              <View style={{ marginTop: 4 }}>
                <SectionHeader icon="folder" name="Workspaces" count={results.workspaces.length} />
                {results.workspaces.map((workspace) => (
                  <WorkspaceResultRow
                    key={workspace.id}
                    name={workspace.name}
                    organization={organizationOf(workspace)}
                    onPress={() => switchTo(workspace)}
                  />
                ))}
              </View>
            ) : null}
            {results.chats.length > 0 ? (
              <View style={{ marginTop: results.workspaces.length > 0 ? 16 : 4 }}>
                <SectionHeader icon="message-square" name="Chats" count={results.chats.length} />
                <SessionRowList
                  sessions={results.chats.map((hit) => hit.session)}
                  models={models}
                  onOpen={openResult}
                  workspaceNameOf={(session) => {
                    const where = hitWorkspace.get(session.id);
                    return where && where !== workspaceId ? workspaceNames.get(where) : undefined;
                  }}
                />
              </View>
            ) : null}
            {results.chats.length === 0 && results.workspaces.length === 0 ? (
              server.loading || server.query !== query.trim() ? (
                <ActivityIndicator style={{ marginTop: 32 }} color={c["fg-muted"]} />
              ) : (
                <Text
                  style={{
                    ...fontStyle(theme),
                    fontSize: 13,
                    color: c["fg-muted"],
                    textAlign: "center",
                    marginTop: 32,
                  }}
                >
                  No chats or workspaces match.
                </Text>
              )
            ) : null}
          </>
        ) : null}
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
        {searching ? null : !loaded ? (
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
            No sessions yet.
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}

function WorkspaceResultRow(props: {
  name: string;
  organization: string | undefined;
  onPress: () => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Switch to ${props.name}`}
      onPress={props.onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 4,
        paddingVertical: 10,
        borderRadius: theme.radius.md,
        backgroundColor: pressed ? c.hover : "transparent",
      })}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: c["surface-2"],
        }}
      >
        <Text style={{ ...fontStyle(theme, 600), fontSize: 11, color: c["fg-muted"] }}>
          {props.name.trim().charAt(0).toUpperCase() || "W"}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ ...fontStyle(theme), fontSize: 14, lineHeight: 20, color: c.fg }}
        >
          {props.name}
        </Text>
        {props.organization ? (
          <Text
            numberOfLines={1}
            style={{ ...fontStyle(theme), fontSize: 11, lineHeight: 16, color: c["fg-subtle"] }}
          >
            {props.organization}
          </Text>
        ) : null}
      </View>
      <Text style={{ ...fontStyle(theme), fontSize: 11, color: c["fg-subtle"] }}>Switch</Text>
    </Pressable>
  );
}

/* The rail's Meetings entry, saying so while a recording is running. */
function MeetingsRow() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const recorder = useMeetingRecorder();
  const live = isCapturing(recorder);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={live ? "Meetings, recording now" : "Meetings"}
      onPress={() => router.push("/meetings")}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 40,
        paddingVertical: 8,
        paddingHorizontal: 8,
        marginBottom: 4,
        borderRadius: theme.radius.md,
        backgroundColor: pressed ? c.hover : "transparent",
      })}
    >
      <Icon name="audio-lines" size={16} color={c["fg-muted"]} />
      <Text style={{ ...fontStyle(theme, 500), flex: 1, fontSize: 15, color: c.fg }}>Meetings</Text>
      {live ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c.danger }} />
          <Text style={{ ...fontStyle(theme, 500), fontSize: 12, color: c.danger }}>Recording</Text>
        </View>
      ) : null}
      <Icon name="chevron-right" size={14} color={c["fg-subtle"]} />
    </Pressable>
  );
}

function SectionHeader(props: {
  icon: "pin" | "folder" | "message-square";
  name: string;
  count: number;
}) {
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
