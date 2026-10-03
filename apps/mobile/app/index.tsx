import { compactModelPill } from "@opengeni/react/model-policy";
import { partitionPinnedSessions, recentSessionsForHome } from "@opengeni/react/session-list-model";
import type { ReasoningEffort, Session } from "@opengeni/sdk";
import {
  ComposerPill,
  fontStyle,
  ModelMark,
  Icon,
  SectionLabel,
  SessionComposer,
  SessionRowList,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { AppThemeProvider } from "@/theme";

export default function HomeScreen() {
  return (
    <AppThemeProvider>
      <Home />
    </AppThemeProvider>
  );
}

/* The web home canvas at phone width: the question, the new-session composer
   and the quiet Recent sessions list under it. The rail lives behind the menu. */
function Home() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { client, config, models, workspaceId, error, reload } = useAccount();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    try {
      setSessions(await client.listSessions(workspaceId, { limit: 50 }));
      setListError(null);
    } catch (caught) {
      setListError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const model = process.env.EXPO_PUBLIC_OPENGENI_DEFAULT_MODEL ?? config?.defaultModel ?? null;
  const effort = (process.env.EXPO_PUBLIC_OPENGENI_DEFAULT_REASONING ??
    config?.defaultReasoningEffort ??
    null) as ReasoningEffort | null;
  const pill = model ? compactModelPill(models, model, effort) : null;
  const recent = useMemo(() => {
    const { pinned } = partitionPinnedSessions(sessions);
    return recentSessionsForHome(sessions, pinned, 6);
  }, [sessions]);

  const create = async () => {
    const text = draft.trim();
    if (!workspaceId || !text || creating) return;
    setCreating(true);
    try {
      const created = await client.createSession(workspaceId, {
        initialMessage: text,
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      });
      setDraft("");
      router.push(`/session/${created.id}`);
    } catch (caught) {
      setListError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  const problem = error?.message ?? listError;
  return (
    <>
      <Stack.Screen
        options={{
          headerStyle: { backgroundColor: c.bg },
          headerShadowVisible: true,
          headerTitle: HeaderWordmark,
          headerTitleAlign: "left",
          headerLeft: HeaderMenuButton,
        }}
      />
      <ScrollView
        style={{ flex: 1, backgroundColor: c.bg }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void reload().then(load)} />
        }
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: 40,
          paddingBottom: Math.max(insets.bottom, 16) + 48,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{
            ...fontStyle(theme, 600),
            fontSize: 24,
            lineHeight: 32,
            letterSpacing: -0.6,
            color: c.fg,
            textAlign: "center",
          }}
        >
          What should the agent do?
        </Text>
        <View style={{ marginTop: 28 }}>
          <SessionComposer
            value={draft}
            onChangeText={setDraft}
            onSend={() => void create()}
            canSend={Boolean(draft.trim()) && !creating && Boolean(workspaceId)}
            sending={creating}
            placeholder="Describe a task for the agent..."
            inset={0}
            liftWithKeyboard={false}
            bottomInset={0}
            options={
              pill ? (
                <ComposerPill
                  label={pill.effort ? `${pill.name} · ${pill.effort}` : pill.name}
                  leading={<ModelMark model={model ?? ""} size={14} color={c.fg} />}
                />
              ) : null
            }
          />
        </View>
        {problem ? (
          <Text
            style={{ ...fontStyle(theme), fontSize: 13, color: c["status-failed"], marginTop: 12 }}
          >
            {problem}
          </Text>
        ) : null}
        {recent.length > 0 ? (
          <View style={{ marginTop: 48 }}>
            <SectionLabel>Recent sessions</SectionLabel>
            <SessionRowList
              sessions={recent}
              models={models}
              onOpen={(sessionId) => router.push(`/session/${sessionId}`)}
            />
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

// Navigator chrome renders outside the screen tree, so it takes its own theme.
function HeaderWordmark() {
  return (
    <AppThemeProvider>
      <Wordmark />
    </AppThemeProvider>
  );
}

function HeaderMenuButton() {
  return (
    <AppThemeProvider>
      <MenuButton />
    </AppThemeProvider>
  );
}

function MenuButton() {
  const theme = useNativeTimelineTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open sessions"
      hitSlop={8}
      onPress={() => router.push("/sessions")}
      style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
    >
      <Icon name="menu" size={20} color={theme.colors.fg} />
    </Pressable>
  );
}

function Wordmark() {
  const theme = useNativeTimelineTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{
        ...fontStyle(theme, 600),
        fontSize: 18,
        letterSpacing: -0.3,
        color: theme.colors.fg,
      }}
    >
      Opengeni
    </Text>
  );
}
