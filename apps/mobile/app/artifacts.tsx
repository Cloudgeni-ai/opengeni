import { useOpenGeniText } from "@opengeni/react/messages";
import { fontStyle, Icon, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAccount } from "@/account";
import { TabScreen, tabHeaderOptions } from "@/app-tab-bar";
import { ArtifactCard } from "@/artifact-card";
import { useArtifactCatalog } from "@/artifact-library";
import {
  ARTIFACT_KIND_FILTERS,
  artifactKey,
  emptyListWords,
  viewerPath,
  type ArtifactKindFilter,
} from "@/artifacts";
import { WorkspaceGate } from "@/meetings";
import { AppThemeProvider } from "@/theme";

export default function ArtifactsScreen() {
  return (
    <AppThemeProvider>
      <TabScreen tab="artifacts">
        <WorkspaceGate title="Artifacts" message="Choose a workspace to see its artifacts.">
          {(workspaceId) => <Artifacts workspaceId={workspaceId} />}
        </WorkspaceGate>
      </TabScreen>
    </AppThemeProvider>
  );
}

const themed = (node: React.ReactNode) => <AppThemeProvider>{node}</AppThemeProvider>;

/* The web Artifacts library at phone width: search, type chips, then one large
   card per artifact, newest change first. A card opens the viewer. */
function Artifacts({ workspaceId }: { workspaceId: string }) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { client } = useAccount();
  const [kind, setKind] = useState<ArtifactKindFilter>("all");
  const [query, setQuery] = useState("");
  const [pulling, setPulling] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const catalog = useArtifactCatalog(client, workspaceId, kind, query);
  const { refresh } = catalog;
  // Read live, so a new filter (a new refresh) doesn't count as coming back.
  const refreshLatest = useRef(refresh);
  refreshLatest.current = refresh;
  // Fresh each time the screen comes back to the front (after the viewer, too).
  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
      if (focusedOnce.current) void refreshLatest.current();
      focusedOnce.current = true;
    }, []),
  );
  const open = useCallback(
    (item: ArtifactCatalogItem) =>
      router.push(viewerPath({ id: item.id, kind: item.kind, workspaceId, title: item.title })),
    [workspaceId],
  );
  const empty = emptyListWords(kind, query);

  const header = (
    <View style={{ paddingTop: 4, paddingBottom: 12, gap: 10 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 40,
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c["surface-1"],
        }}
      >
        <Icon name="search" size={14} color={c["fg-subtle"]} />
        <TextInput
          accessibilityLabel="Search artifacts"
          value={query}
          onChangeText={setQuery}
          placeholder="Search artifacts"
          placeholderTextColor={c["fg-subtle"]}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          returnKeyType="search"
          style={{ ...fontStyle(theme), flex: 1, fontSize: 14, color: c.fg }}
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        style={{ marginHorizontal: -16 }}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
      >
        {ARTIFACT_KIND_FILTERS.map((filter) => {
          const selected = filter.kind === kind;
          return (
            <Pressable
              key={filter.kind}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => setKind(filter.kind)}
              style={({ pressed }) => ({
                height: 32,
                paddingHorizontal: 14,
                borderRadius: 16,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: selected ? c.fg : c.border,
                backgroundColor: selected ? c.fg : pressed ? c.hover : c["surface-1"],
              })}
            >
              <Text
                style={{
                  ...fontStyle(theme, selected ? 600 : 500),
                  fontSize: 13,
                  color: selected ? c.bg : c.fg,
                }}
              >
                {filter.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: "Artifacts",
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
          ...tabHeaderOptions(themed),
        }}
      />
      <FlatList
        style={{ flex: 1, backgroundColor: c.bg }}
        data={catalog.items}
        keyExtractor={artifactKey}
        // A Site's still is a small web view: keep only a few screens of
        // cards mounted so a long library stays light on memory and data.
        initialNumToRender={5}
        maxToRenderPerBatch={4}
        windowSize={5}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={header}
        ItemSeparatorComponent={Separator}
        renderItem={({ item }) => (
          <ArtifactCard
            t={t}
            client={client}
            workspaceId={workspaceId}
            item={item}
            now={now}
            onOpen={open}
          />
        )}
        onEndReachedThreshold={0.6}
        onEndReached={catalog.loadMore}
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            onRefresh={() => {
              setPulling(true);
              setNow(new Date());
              void refresh().finally(() => setPulling(false));
            }}
          />
        }
        ListEmptyComponent={
          catalog.loading ? (
            <ActivityIndicator style={{ marginTop: 32 }} color={c["fg-muted"]} />
          ) : (
            <View style={{ alignItems: "center", gap: 6, marginTop: 40, paddingHorizontal: 24 }}>
              <Text
                style={{
                  ...fontStyle(theme, 600),
                  fontSize: 15,
                  color: c.fg,
                  textAlign: "center",
                }}
              >
                {catalog.error ? "Couldn't load artifacts" : empty.title}
              </Text>
              {catalog.error || empty.body ? (
                <Text
                  style={{
                    ...fontStyle(theme),
                    fontSize: 13,
                    color: c["fg-muted"],
                    textAlign: "center",
                  }}
                >
                  {catalog.error ? "Pull to try again." : empty.body}
                </Text>
              ) : null}
            </View>
          )
        }
        ListFooterComponent={
          catalog.hasMore ? (
            <ActivityIndicator style={{ marginTop: 16 }} color={c["fg-muted"]} />
          ) : null
        }
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingBottom: 24,
        }}
      />
    </>
  );
}

function Separator() {
  return <View style={{ height: 12 }} />;
}
