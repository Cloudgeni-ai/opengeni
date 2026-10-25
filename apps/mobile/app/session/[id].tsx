import { compactModelPill } from "@opengeni/react/model-policy";
import { useOpenGeniText } from "@opengeni/react/messages";
import { NativeMenu, type MenuAction } from "@/native-menu";
import { sessionDisplayTitle } from "@opengeni/react/session-list-model";
import {
  ADMIN_ACCESS_DURATIONS,
  ADMIN_ACCESS_GRANT_DESCRIPTION,
  endsText,
  type AdminAccessDuration,
} from "@opengeni/react/session-admin-access-model";
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
  type NativeInChatConnectOptions,
} from "@opengeni/react-native/timeline";
import { createWebMarkdownRenderer } from "@opengeni/react-native/timeline/markdown";
import { createNativePreviewRenderers } from "@opengeni/react-native/timeline/previews";
import type { OpenGeniLinkTarget } from "@opengeni/sdk";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Linking, Pressable, Text, View } from "react-native";
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
import { useSessionFullAccess, type SessionFullAccess } from "@/session-full-access";
import { AppThemeProvider } from "@/theme";
import { useComposerVoice } from "@/voice";
import { openLinkFromApp } from "@/app-link-registry";
import { openOnWeb, webPaths } from "@/web-links";

/** The session menu item that sends outside calls (Siri, Phone, Shortcuts) to this session. */
const CALL_PIN_ACTION = "opengeni.take-calls-here";
/** The session menu item that opens this conversation in the web app. */
const OPEN_ON_WEB_ACTION = "opengeni.open-on-web";
/** The session menu item that mutes or unmutes this session's replies for the person. */
const MUTE_REPLIES_ACTION = "opengeni.mute-replies";
/** Session menu items for full access: a time limit to give it for, or turning it off. */
const FULL_ACCESS_ACTION = "opengeni.full-access";
const FULL_ACCESS_GRANT_PREFIX = "opengeni.full-access.grant:";
const FULL_ACCESS_REVOKE_ACTION = "opengeni.full-access.revoke";

/** The session menu's full access entry, as the web header's shield and ⋯ menu offer it. */
function fullAccessMenuAction(access: SessionFullAccess | null): MenuAction[] {
  if (!access) return [];
  const durations = ADMIN_ACCESS_DURATIONS.map((each) => ({
    id: `${FULL_ACCESS_GRANT_PREFIX}${each.value}`,
    title: each.label,
  }));
  const { state } = access;
  if (!state.active) {
    return state.canGrant
      ? [
          {
            id: FULL_ACCESS_ACTION,
            title: "Give full access",
            image: "checkmark.shield" as MenuAction["image"],
            subactions: durations,
          },
        ]
      : [];
  }
  const subactions: MenuAction[] = [
    ...(state.canGrant
      ? [{ id: `${FULL_ACCESS_ACTION}.change`, title: "Change time limit", subactions: durations }]
      : []),
    ...(state.canRevoke
      ? [
          {
            id: FULL_ACCESS_REVOKE_ACTION,
            title: "Turn off full access",
            image: "xmark.shield" as MenuAction["image"],
            attributes: { destructive: true },
          },
        ]
      : []),
  ];
  return subactions.length > 0
    ? [
        {
          id: FULL_ACCESS_ACTION,
          title: `Full access · ${endsText(state.expiresAt)}`,
          image: "checkmark.shield.fill" as MenuAction["image"],
          subactions,
        },
      ]
    : [];
}

export default function SessionScreen() {
  const { id, at, workspace } = useLocalSearchParams<{
    id: string;
    at?: string;
    workspace?: string;
  }>();
  // Opened from the inbox, a notification or a link: land on that moment.
  const focusSequence = at && /^[1-9][0-9]*$/u.test(at) ? Number(at) : undefined;
  const { account, client, models, workspaceId: currentWorkspaceId } = useAccount();
  // A session opened from elsewhere names its own workspace, so the screens
  // underneath keep theirs and Back returns to them unchanged.
  const workspaceId = workspace || currentWorkspaceId;
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
        baseUrl={account?.baseUrl ?? null}
        sessionId={id}
        workspaceId={workspaceId}
        focusSequence={focusSequence}
      />
    </AppThemeProvider>
  );
}

/** Where the system sign-in browser hands back to the app (app.json `scheme`). */
const CONNECT_RETURN_PREFIX = "opengeni://open";

/**
 * Connect requests in this conversation sign in through the system sign-in
 * browser. The provider returns to the deployment's hand-back page, which
 * opens this conversation in the app again.
 */
function inChatConnectOptions(
  baseUrl: string | null,
  workspaceId: string,
  sessionId: string,
): NativeInChatConnectOptions | undefined {
  if (!baseUrl) return undefined;
  const origin = baseUrl.replace(/\/+$/u, "");
  const conversation = `${origin}/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`;
  return {
    browser: {
      openAuthSession: (url) => WebBrowser.openAuthSessionAsync(url, CONNECT_RETURN_PREFIX),
      dismiss: () => WebBrowser.dismissAuthSession(),
    },
    returnUrl: `${origin}/desktop-return?url=${encodeURIComponent(conversation)}`,
    openUrl: (url) => void Linking.openURL(url),
  };
}

function LiveSession(props: {
  focusSequence?: number | undefined;
  client: ReturnType<typeof useAccount>["client"];
  models: ReturnType<typeof useAccount>["models"];
  baseUrl: string | null;
  sessionId: string;
  workspaceId: string;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const insets = useSafeAreaInsets();
  const inChatConnect = useMemo(
    () => inChatConnectOptions(props.baseUrl, props.workspaceId, props.sessionId),
    [props.baseUrl, props.workspaceId, props.sessionId],
  );
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
      // Opengeni conversations open in the app; anything else in the browser.
      onLinkPress: (url) => {
        openLinkFromApp(url);
        return false;
      },
      onCopy: (text) => void copyText(text),
      onOpenGeniLink: openLink,
      ...createNativePreviewRenderers(t, {
        client: props.client,
        workspaceId: props.workspaceId,
        onOpenLink: openLink,
      }),
    });
  }, [props.client, props.workspaceId, webBaseUrl, t]);
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
  const pill = model ? compactModelPill(t, props.models, model, effort ?? undefined) : null;
  // A session the runtime could not start reads as stuck, never "Waiting on you".
  const status = controller.displayStatus;
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
  const fullAccess = useSessionFullAccess(props.client, props.workspaceId, props.sessionId);
  const fullAccessOn = fullAccess?.state.active === true;
  const onFullAccessAction = useCallback(
    (event: string) => {
      if (!fullAccess) return;
      const done = (ok: boolean, failure: string) => {
        if (ok) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        else Alert.alert(failure, "Try again in a moment.");
      };
      if (event === FULL_ACCESS_REVOKE_ACTION) {
        void fullAccess.revoke().then((ok) => done(ok, "Couldn't turn off full access"));
        return;
      }
      const duration = event.slice(FULL_ACCESS_GRANT_PREFIX.length) as AdminAccessDuration;
      const give = () =>
        void fullAccess
          .grant(duration)
          .then((ok) =>
            done(
              ok,
              fullAccess.state.active
                ? "Couldn't change the time limit"
                : "Couldn't give full access",
            ),
          );
      // Changing the time limit needs no second confirmation; turning it on does.
      if (fullAccess.state.active) {
        give();
        return;
      }
      Alert.alert(
        "Give this session your full access?",
        `${ADMIN_ACCESS_GRANT_DESCRIPTION} You can turn it off at any time from this menu.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Give full access", onPress: give },
        ],
      );
    },
    [fullAccess],
  );
  const headerTitle = useCallback(
    () => (
      <AppThemeProvider>
        <SessionHeaderTitle
          title={title}
          status={paused ? "queued" : status}
          statusLabel={paused ? "Paused" : undefined}
          fullAccess={fullAccessOn}
        />
      </AppThemeProvider>
    ),
    [fullAccessOn, paused, status, title],
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
                agentCall.callSession(props.sessionId, workspaceId);
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
                    ...fullAccessMenuAction(fullAccess),
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
                    if (
                      nativeEvent.event === FULL_ACCESS_REVOKE_ACTION ||
                      nativeEvent.event.startsWith(FULL_ACCESS_GRANT_PREFIX)
                    ) {
                      void Haptics.selectionAsync();
                      onFullAccessAction(nativeEvent.event);
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
      fullAccess,
      onCall,
      onFullAccessAction,
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
        inChatConnect={inChatConnect}
        computeLabel={computeLabel}
        feedback={feedback}
        composer={{
          onActionFeedback: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
          voice,
          // An empty composer calls this session, as its header button does.
          call: {
            active: onCall,
            onPress: () => {
              void Haptics.selectionAsync();
              agentCall.callSession(props.sessionId, workspaceId);
            },
          },
          renderLeading: () => attachMenu,
          options: pill ? (
            <ComposerPill
              label={pill.name}
              detail={pill.effort}
              fast={(policy?.latencyMode ?? session?.latencyMode) === "fast"}
              ultrafast={(policy?.latencyMode ?? session?.latencyMode) === "ultrafast"}
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
