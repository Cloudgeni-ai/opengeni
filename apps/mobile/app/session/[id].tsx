import { compactModelPill } from "@opengeni/react/model-policy";
import { NativeMenu, type MenuAction } from "@/native-menu";
import { sessionDisplayTitle } from "@opengeni/react/session-list-model";
import { useOpenGeniNativeSession } from "@opengeni/react-native";
import {
  ComposerPill,
  Icon,
  ModelMark,
  ModelPickerSheet,
  NativeSessionScreen,
  SessionActionsButton,
  SessionHeaderTitle,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import { createWebMarkdownRenderer } from "@opengeni/react-native/timeline/markdown";
import { createNativePreviewRenderers } from "@opengeni/react-native/timeline/previews";
import type { OpenGeniLinkTarget } from "@opengeni/sdk";
import * as Haptics from "expo-haptics";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { BrandMark } from "@/brand-mark";
import { useAgentCall } from "@/call";
import {
  pinCallSession,
  rememberOpenedSession,
  unpinCallSession,
  useOutsideCallPreferences,
} from "@/call-preferences";
import { copyText } from "@/clipboard";
import { markSessionInboxRead, useSessionRepliesMute } from "@/notifications";
import { useSessionComputeLabel } from "@/compute-label";
import { useWorkspaceModelCatalog } from "@/model-catalog";
import { ComposerPlusMenu } from "@/new-session-options";
import { AppThemeProvider } from "@/theme";
import { useComposerVoice } from "@/voice";
import { openOnWeb, webPaths } from "@/web-links";

/** The session menu item that sends outside calls (Siri, Phone, Shortcuts) to this session. */
const CALL_PIN_ACTION = "opengeni.take-calls-here";
/** The session menu item that opens this conversation in the web app. */
const OPEN_ON_WEB_ACTION = "opengeni.open-on-web";
/** The session menu item that mutes or unmutes this session's replies for the person. */
const MUTE_REPLIES_ACTION = "opengeni.mute-replies";

export default function SessionScreen() {
  const { id, at } = useLocalSearchParams<{ id: string; at?: string }>();
  // Opened from the inbox or a notification: land on that moment.
  const focusSequence = at && /^[1-9][0-9]*$/u.test(at) ? Number(at) : undefined;
  const { client, models, workspaceId } = useAccount();
  if (!workspaceId || !id) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>No workspace selected</Text>
      </View>
    );
  }
  return (
    <AppThemeProvider>
      <LiveSession
        client={client}
        models={models}
        sessionId={id}
        workspaceId={workspaceId}
        focusSequence={focusSequence}
      />
    </AppThemeProvider>
  );
}

function LiveSession(props: {
  focusSequence?: number | undefined;
  client: ReturnType<typeof useAccount>["client"];
  models: ReturnType<typeof useAccount>["models"];
  sessionId: string;
  workspaceId: string;
}) {
  const theme = useNativeTimelineTheme();
  const insets = useSafeAreaInsets();
  // Reading the session reads its replies in the inbox, on arrival and on leaving.
  const { client: inboxClient, sessionId: readSessionId } = props;
  useFocusEffect(
    useCallback(() => {
      void markSessionInboxRead(inboxClient, readSessionId);
      return () => void markSessionInboxRead(inboxClient, readSessionId);
    }, [inboxClient, readSessionId]),
  );
  useEffect(() => {
    rememberOpenedSession({ workspaceId: props.workspaceId, sessionId: props.sessionId });
  }, [props.workspaceId, props.sessionId]);
  const controller = useOpenGeniNativeSession({
    client: props.client,
    sessionId: props.sessionId,
    workspaceId: props.workspaceId,
  });
  const session = controller.session.session;
  const feedback = useMemo(
    () => ({ client: props.client, workspaceId: props.workspaceId, sessionId: props.sessionId }),
    [props.client, props.workspaceId, props.sessionId],
  );
  const { account } = useAccount();
  const webBaseUrl = account?.baseUrl ?? null;
  // Agent images and previews resolve through this workspace; artifacts and Sites open on web.
  const renderMarkdown = useMemo(() => {
    const openLink = (target: OpenGeniLinkTarget) => {
      if (!webBaseUrl) return;
      const workspace = encodeURIComponent(props.workspaceId);
      if (target.kind === "site")
        openOnWeb(
          webBaseUrl,
          `/workspaces/${workspace}/artifacts/${encodeURIComponent(target.artifactId)}`,
        );
      else if (target.kind === "file")
        openOnWeb(
          webBaseUrl,
          `/workspaces/${workspace}/artifacts/files/${encodeURIComponent(target.fileId)}`,
        );
      else if (target.kind === "editable-artifact")
        openOnWeb(
          webBaseUrl,
          `/workspaces/${workspace}/artifacts/editable/${encodeURIComponent(target.artifactId)}`,
        );
    };
    return createWebMarkdownRenderer({
      onCopy: (text) => void copyText(text),
      onOpenGeniLink: openLink,
      ...createNativePreviewRenderers({
        client: props.client,
        workspaceId: props.workspaceId,
        onOpenLink: openLink,
      }),
    });
  }, [props.client, props.workspaceId, webBaseUrl]);
  const catalog = useWorkspaceModelCatalog(props.workspaceId);
  const computeLabel = useSessionComputeLabel(props.workspaceId, props.sessionId);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The composer owns the next turn's policy, exactly as the web picker edits it.
  const composer = controller.composer;
  const voice = useComposerVoice({
    workspaceId: props.workspaceId,
    value: composer.value,
    setValue: composer.setValue,
    scope: props.sessionId,
  });
  const policy = composer.policy ?? null;
  const model = policy?.model ?? session?.model ?? null;
  const effort = policy?.reasoningEffort ?? session?.reasoningEffort ?? null;
  // The web composer's phone-width pill: compact model name, effort when it is a choice.
  const pill = model ? compactModelPill(props.models, model, effort ?? undefined) : null;
  const status = controller.sessionStatus;
  const paused = controller.queue.effectiveControl?.state === "paused";
  // Web header: the status badge beside the title (a paused workstream says so).
  const refreshSession = controller.session.refresh;
  const title = session ? sessionDisplayTitle(session) : "";
  const agentCall = useAgentCall();
  const onCall = agentCall.sessionId === props.sessionId;
  // In the call's own conversation the green phone button returns to the call,
  // so the floating on-call pill would only cover the header.
  const { hidePillFor } = agentCall;
  useFocusEffect(
    useCallback(
      () => (onCall ? hidePillFor(props.sessionId) : undefined),
      [hidePillFor, onCall, props.sessionId],
    ),
  );
  const callPreferences = useOutsideCallPreferences();
  const takesCalls =
    callPreferences.target === "pinned" && callPreferences.pinned?.sessionId === props.sessionId;
  const workspaceId = props.workspaceId;
  const repliesMute = useSessionRepliesMute(
    props.client,
    props.workspaceId,
    props.sessionId,
    session ? session.parentSessionId === null : false,
  );
  const headerTitle = useCallback(
    () => (
      <AppThemeProvider>
        <SessionHeaderTitle
          title={title}
          status={paused ? "queued" : status}
          statusLabel={paused ? "Paused" : undefined}
        />
      </AppThemeProvider>
    ),
    [paused, status, title],
  );
  const headerRight = useCallback(
    () =>
      session ? (
        <AppThemeProvider>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={onCall ? "Return to call" : "Call this session"}
              hitSlop={8}
              onPress={() => {
                void Haptics.selectionAsync();
                agentCall.callSession(props.sessionId);
              }}
              style={({ pressed }) => ({
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: "center",
                justifyContent: "center",
                opacity: pressed ? 0.6 : 1,
                backgroundColor: onCall ? "#34C759" : "transparent",
              })}
            >
              <Icon name="phone" size={20} color={onCall ? "#FFFFFF" : theme.colors.fg} />
            </Pressable>
            <SessionActionsButton
              session={session}
              client={props.client}
              onChanged={() => void refreshSession()}
              onActionFeedback={() => void Haptics.selectionAsync()}
              renderMenu={({ actions, trigger }) => (
                <NativeMenu
                  actions={[
                    ...(webBaseUrl
                      ? [
                          {
                            id: OPEN_ON_WEB_ACTION,
                            title: "Open in web",
                            image: "safari" as MenuAction["image"],
                          },
                        ]
                      : []),
                    {
                      id: CALL_PIN_ACTION,
                      title: takesCalls ? "Stop taking calls here" : "Take calls here",
                      image: (takesCalls
                        ? "phone.down"
                        : "phone.arrow.down.left") as MenuAction["image"],
                    },
                    ...(repliesMute
                      ? [
                          {
                            id: MUTE_REPLIES_ACTION,
                            title: repliesMute.muted ? "Unmute replies" : "Mute replies",
                            image: (repliesMute.muted
                              ? "bell"
                              : "bell.slash") as MenuAction["image"],
                          },
                        ]
                      : []),
                    ...actions.map((action) => ({
                      id: action.key,
                      title: action.label,
                      ...(action.systemImage
                        ? { image: action.systemImage as MenuAction["image"] }
                        : {}),
                      ...(action.destructive ? { attributes: { destructive: true } } : {}),
                    })),
                  ]}
                  onPressAction={({ nativeEvent }) => {
                    if (nativeEvent.event === OPEN_ON_WEB_ACTION) {
                      if (webBaseUrl)
                        openOnWeb(webBaseUrl, webPaths.session(workspaceId, props.sessionId));
                      return;
                    }
                    if (nativeEvent.event === CALL_PIN_ACTION) {
                      void Haptics.selectionAsync();
                      if (takesCalls) unpinCallSession();
                      else if (workspaceId)
                        pinCallSession({ workspaceId, sessionId: props.sessionId, title });
                      return;
                    }
                    if (nativeEvent.event === MUTE_REPLIES_ACTION) {
                      void Haptics.selectionAsync();
                      void repliesMute?.toggle().then((muted) => {
                        if (muted === null) {
                          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                        }
                      });
                      return;
                    }
                    actions.find((action) => action.key === nativeEvent.event)?.onPress();
                  }}
                >
                  {trigger}
                </NativeMenu>
              )}
            />
          </View>
        </AppThemeProvider>
      ) : null,
    [
      agentCall,
      onCall,
      props.client,
      props.sessionId,
      refreshSession,
      repliesMute,
      session,
      takesCalls,
      theme.colors.fg,
      title,
      webBaseUrl,
      workspaceId,
    ],
  );
  // Camera, photos and files, as the web composer's + offers them.
  const takePhoto = controller.attachments.takePhoto;
  const attachMenu = (
    <ComposerPlusMenu
      onTakePhoto={takePhoto ? () => void takePhoto() : undefined}
      onPickImages={() => void controller.attachments.pickImages()}
      onPickFiles={() => void controller.attachments.pickDocuments()}
    />
  );
  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerTitle,
          headerRight,
          headerStyle: { backgroundColor: theme.colors.bg },
          headerTintColor: theme.colors.fg,
          headerShadowVisible: false,
        }}
      />
      <NativeSessionScreen
        controller={controller}
        focusSequence={props.focusSequence}
        client={props.client}
        models={props.models}
        renderMarkdown={renderMarkdown}
        onCopy={(text) => void copyText(text)}
        onOpenSession={(sessionId) => router.push(`/session/${sessionId}`)}
        bottomInset={insets.bottom}
        computeLabel={computeLabel}
        feedback={feedback}
        composer={{
          onActionFeedback: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
          voice,
          renderLeading: () => attachMenu,
          options: pill ? (
            <ComposerPill
              label={pill.name}
              detail={pill.effort}
              fast={(policy?.latencyMode ?? session?.latencyMode) === "fast"}
              leading={<ModelMark model={model ?? ""} size={14} color={theme.colors.fg} />}
              onPress={
                policy
                  ? () => {
                      catalog.refresh();
                      setPickerOpen(true);
                    }
                  : undefined
              }
            />
          ) : null,
        }}
      />
      {policy ? (
        <ModelPickerSheet
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          rows={catalog.rows}
          loading={catalog.loading && catalog.rows.length === 0}
          error={catalog.error}
          model={policy.model}
          effort={policy.reasoningEffort}
          latencyMode={policy.latencyMode}
          hasImageAttachments={controller.attachments.attachments.some(
            (file) => file.status !== "failed" && file.contentType.startsWith("image/"),
          )}
          codexOnly={session?.codexCompactionMode === "remote_v2"}
          groupPresentation={{
            opengeni_credits: {
              label: "Opengeni",
              icon: <BrandMark width={15} color={theme.colors["fg-subtle"]} />,
            },
          }}
          onModelChange={composer.setModel}
          onEffortChange={composer.setReasoningEffort}
          onLatencyModeChange={composer.setLatencyMode}
          onSelectionFeedback={() => void Haptics.selectionAsync()}
        />
      ) : null}
    </>
  );
}
