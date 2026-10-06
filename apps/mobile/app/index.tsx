import { compactModelPill } from "@opengeni/react/model-policy";
import { partitionPinnedSessions, recentSessionsForHome } from "@opengeni/react/session-list-model";
import type { LatencyMode, ReasoningEffort, Session } from "@opengeni/sdk";
import { useNativeFileAttachments } from "@opengeni/react-native";
import {
  AttachmentChips,
  Button,
  ComposerPill,
  ModelPickerSheet,
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
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useAccount } from "@/account";
import { BrandMark } from "@/brand-mark";
import { useWorkspaceModelCatalog } from "@/model-catalog";
import {
  ComposerPlusMenu,
  NewSessionOptionChips,
  useNewSessionOptions,
} from "@/new-session-options";
import { SignInScreen } from "@/sign-in-screen";
import { AppThemeProvider } from "@/theme";
import { useComposerVoice } from "@/voice";
import { AccountMenuButton, WorkspaceSwitcherTitle } from "@/workspace-switcher";
import { openOnWeb, webPaths } from "@/web-links";

export default function HomeScreen() {
  return (
    <AppThemeProvider>
      <Gate />
    </AppThemeProvider>
  );
}

/* Signed out: the web sign-in. Signed in: the home canvas. */
function Gate() {
  const { status } = useAccount();
  const theme = useNativeTimelineTheme();
  if (status === "signedOut") {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <SignInScreen />
      </>
    );
  }
  if (status === "loading") {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.colors.bg,
          }}
        >
          <ActivityIndicator />
        </View>
      </>
    );
  }
  return <Home />;
}

/* The web home canvas at phone width: the question, the new-session composer
   and the quiet Recent sessions list under it. The rail lives behind the menu. */
function Home() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const {
    account,
    adapters,
    client,
    config,
    models,
    workspaceId,
    workspaces,
    accessContext,
    error,
    reload,
  } = useAccount();
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

  // The new session's model: the person's pick in this workspace, else the
  // deployment default when this workspace can use it, else its first usable one.
  const catalog = useWorkspaceModelCatalog(workspaceId);
  const [picked, setPicked] = useState<{
    workspaceId: string | null;
    model: string | null;
    effort: ReasoningEffort | null;
    latencyMode: LatencyMode;
  }>({ workspaceId: null, model: null, effort: null, latencyMode: "standard" });
  const [pickerOpen, setPickerOpen] = useState(false);
  const selectable = catalog.rows.filter((row) => row.selectable);
  const preset = catalog.defaultSelection;
  const fallbackModel =
    selectable.find((row) => row.id === preset?.model)?.id ??
    selectable.find((row) => row.id === config?.defaultModel)?.id ??
    selectable[0]?.id ??
    null;
  const ownPick = picked.workspaceId === workspaceId ? picked : null;
  const model = ownPick?.model ?? fallbackModel;
  const effort =
    ownPick?.effort ??
    (preset && preset.model === model ? preset.reasoningEffort : null) ??
    ((config?.defaultReasoningEffort ?? null) as ReasoningEffort | null);
  const latencyMode = ownPick?.latencyMode ?? "standard";
  const pick = (patch: Partial<Omit<typeof picked, "workspaceId">>) =>
    setPicked({ workspaceId, model, effort, latencyMode, ...patch });
  const pill = model ? compactModelPill(models, model, effort) : null;
  const recent = useMemo(() => {
    const { pinned } = partitionPinnedSessions(sessions);
    return recentSessionsForHome(sessions, pinned, 6);
  }, [sessions]);

  // The new chat's photos and files upload to the workspace as they are picked.
  const attachments = useNativeFileAttachments({
    client,
    workspaceId: workspaceId ?? "",
    sessionId: "new-session",
    files: adapters.files,
    crypto: adapters.crypto,
  });
  const options = useNewSessionOptions(workspaceId);
  const voice = useComposerVoice({ workspaceId, value: draft, setValue: setDraft, scope: "home" });
  const attached = attachments.readyResources.length > 0;
  const canCreate =
    Boolean(workspaceId) &&
    !creating &&
    (Boolean(draft.trim()) || attached) &&
    !attachments.uploading &&
    !attachments.hasUnresolved;

  const create = async () => {
    const text = draft.trim();
    if (!workspaceId || !canCreate) return;
    setCreating(true);
    try {
      const chosen = options.request();
      const created = await client.createSession(workspaceId, {
        // A file-only message still says what it carries, as the web composer does.
        initialMessage: text || "See the attached files.",
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
        ...(latencyMode !== "standard" ? { latencyMode } : {}),
        ...(chosen.visibility ? { visibility: chosen.visibility } : {}),
        ...(chosen.targetSandboxId ? { targetSandboxId: chosen.targetSandboxId } : {}),
        resources: [...chosen.resources, ...attachments.readyResources],
      });
      setDraft("");
      attachments.clear();
      options.reset();
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
          headerShown: true,
          headerStyle: { backgroundColor: c.bg },
          headerShadowVisible: true,
          headerTitle: HeaderWorkspaceTitle,
          headerTitleAlign: "center",
          headerLeft: HeaderMenuButton,
          headerRight: HeaderAccountButton,
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
            canSend={canCreate}
            sending={creating}
            placeholder="Describe a task for the agent..."
            voice={voice}
            renderLeading={() => (
              <ComposerPlusMenu
                onPickImages={() => void attachments.pickImages()}
                onPickFiles={() => void attachments.pickDocuments()}
                options={options}
              />
            )}
            header={
              <>
                <NewSessionOptionChips options={options} />
                <AttachmentChips attachments={attachments} />
              </>
            }
            inset={0}
            liftWithKeyboard={false}
            bottomInset={0}
            options={
              pill ? (
                <ComposerPill
                  label={pill.effort ? `${pill.name} · ${pill.effort}` : pill.name}
                  leading={<ModelMark model={model ?? ""} size={14} color={c.fg} />}
                  onPress={() => {
                    catalog.refresh();
                    setPickerOpen(true);
                  }}
                />
              ) : null
            }
          />
        </View>
        {accessContext && workspaces.length === 0 && account ? (
          <View style={{ marginTop: 16, alignItems: "center", gap: 12 }}>
            <Text
              style={{
                ...fontStyle(theme),
                fontSize: 14,
                lineHeight: 20,
                color: c["fg-muted"],
                textAlign: "center",
              }}
            >
              You aren't in a workspace yet. Create an organization on the web, then pull to
              refresh.
            </Text>
            <Button
              label="Open Opengeni on the web"
              icon="external-link"
              onPress={() => openOnWeb(account.baseUrl, webPaths.home())}
            />
          </View>
        ) : null}
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
      <ModelPickerSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        rows={catalog.rows}
        loading={catalog.loading && catalog.rows.length === 0}
        error={catalog.error}
        model={model ?? ""}
        effort={effort ?? "medium"}
        latencyMode={latencyMode}
        groupPresentation={{
          opengeni_credits: {
            label: "Opengeni",
            icon: <BrandMark width={15} color={c["fg-subtle"]} />,
          },
        }}
        onModelChange={(next) => pick({ model: next })}
        onEffortChange={(next) => pick({ effort: next })}
        onLatencyModeChange={(next) => pick({ latencyMode: next })}
        onSelectionFeedback={() => void Haptics.selectionAsync()}
      />
    </>
  );
}

// Navigator chrome renders outside the screen tree, so it takes its own theme.
// The title names where a new chat goes (web's phone header shows the workspace
// in its rail); it falls back to the wordmark before workspaces load.
function HeaderWorkspaceTitle() {
  return (
    <AppThemeProvider>
      <WorkspaceTitleOrWordmark />
    </AppThemeProvider>
  );
}

function WorkspaceTitleOrWordmark() {
  const { workspace } = useAccount();
  return workspace ? <WorkspaceSwitcherTitle /> : <Wordmark />;
}

function HeaderMenuButton() {
  return (
    <AppThemeProvider>
      <MenuButton />
    </AppThemeProvider>
  );
}

function HeaderAccountButton() {
  return (
    <AppThemeProvider>
      <AccountButton />
    </AppThemeProvider>
  );
}

function AccountButton() {
  return <AccountMenuButton />;
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
