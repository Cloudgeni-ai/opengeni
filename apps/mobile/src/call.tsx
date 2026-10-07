import { useSession, useSessionEvents, useTurnQueue } from "@opengeni/react/session";
import { sessionDisplayTitle } from "@opengeni/react/session-list-model";
import { useRealtimeModelSelection } from "@opengeni/react/session-realtime";
import {
  nativeRealtimeModelSupported,
  OpenGeniNativeCallView,
  useNativeRealtimeCall,
  useNativeSessionRealtime,
  type NativeCallAdapter,
} from "@opengeni/react-native";
import { createExpoCallAdapter } from "@opengeni/react-native/expo";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import {
  connectCallAudioToWebRtc,
  createReactNativeWebRtcAdapter,
} from "@opengeni/react-native/webrtc";
import { OpenGeniApiError, type EffectiveSessionControl } from "@opengeni/sdk";
import * as Haptics from "expo-haptics";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import { getOutsideCallTarget, getPinnedCallSession, unpinCallSession } from "@/call-preferences";
import { AppThemeProvider } from "@/theme";

type CallTarget = { workspaceId: string; sessionId: string };

type AgentCallContextValue = {
  /** The session on a call, if any. */
  sessionId: string | null;
  /** Call the agent in this session (or bring its call back to the front). */
  callSession(sessionId: string): void;
  /** A call from outside the app: `sessionId`, or the outside-call setting's target. */
  callFromOutside(sessionId: string | null): Promise<void>;
};

const AgentCallContext = createContext<AgentCallContextValue>({
  sessionId: null,
  callSession: () => undefined,
  callFromOutside: async () => undefined,
});

export function useAgentCall(): AgentCallContextValue {
  return useContext(AgentCallContext);
}

const webrtc = createReactNativeWebRtcAdapter();

// Starting is blocked until the session's real control state has loaded.
const LOADING_CONTROL: EffectiveSessionControl = {
  state: "paused",
  controlVersion: 0,
  controlEtag: "",
  directState: "active",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
} as unknown as EffectiveSessionControl;

/**
 * One call with an agent at a time, above navigation: it keeps talking while
 * you read the chat, leave the app or lock the phone. Calls start from a
 * session, or from outside the app (Phone recents, Siri, the home-screen
 * action, the opengeni://call link) into a new or the latest session.
 */
export function CallProvider({ children }: { children: ReactNode }) {
  const { client, workspaceId } = useAccount();
  const [target, setTarget] = useState<CallTarget | null>(null);
  const [expanded, setExpanded] = useState(false);
  const callAdapter = useMemo(() => createExpoCallAdapter(), []);

  useEffect(() => (callAdapter ? connectCallAudioToWebRtc(callAdapter) : undefined), [callAdapter]);

  const callSession = useCallback(
    (sessionId: string) => {
      if (!workspaceId) return;
      setTarget((current) =>
        current?.sessionId === sessionId ? current : { workspaceId, sessionId },
      );
      setExpanded(true);
    },
    [workspaceId],
  );

  const callFromOutside = useCallback(
    async (requested: string | null) => {
      if (!workspaceId) return;
      if (requested) return callSession(requested);
      try {
        const pinned = getPinnedCallSession();
        if (getOutsideCallTarget() === "pinned" && pinned?.workspaceId === workspaceId) {
          const gone = await client.getSession(workspaceId, pinned.sessionId).then(
            () => false,
            (error: unknown) => error instanceof OpenGeniApiError && error.status === 404,
          );
          if (!gone) return callSession(pinned.sessionId);
          // The chosen session is gone: forget it and start fresh rather than fail the call.
          unpinCallSession();
        }
        if (getOutsideCallTarget() === "latest") {
          const [latest] = await client.listSessions(workspaceId, { limit: 1 });
          if (latest) return callSession(latest.id);
        }
        // An idle session shell: voice is its first interaction, as on the web.
        const created = await client.createSession(workspaceId, { startMode: "realtime" });
        callSession(created.id);
      } catch (error) {
        Alert.alert("Couldn't start the call", error instanceof Error ? error.message : undefined);
      }
    },
    [callSession, client, workspaceId],
  );

  const outsideRef = useRef(callFromOutside);
  outsideRef.current = callFromOutside;
  useEffect(() => {
    if (!callAdapter || !workspaceId) return;
    const unsubscribe = callAdapter.subscribe((event) => {
      if (event.type === "startRequested") void outsideRef.current(event.target);
    });
    void callAdapter.takePendingStartRequest().then((pending) => {
      if (pending) void outsideRef.current(pending.target);
    });
    return unsubscribe;
  }, [callAdapter, workspaceId]);

  const value = useMemo(
    () => ({ sessionId: target?.sessionId ?? null, callSession, callFromOutside }),
    [callFromOutside, callSession, target?.sessionId],
  );

  return (
    <AgentCallContext.Provider value={value}>
      {children}
      {target ? (
        <ActiveCall
          key={target.sessionId}
          target={target}
          callAdapter={callAdapter}
          expanded={expanded}
          onExpand={() => setExpanded(true)}
          onMinimize={() => setExpanded(false)}
          onFinished={() => {
            setTarget(null);
            setExpanded(false);
          }}
        />
      ) : null}
    </AgentCallContext.Provider>
  );
}

function ActiveCall(props: {
  target: CallTarget;
  callAdapter: NativeCallAdapter | null;
  expanded: boolean;
  onExpand(): void;
  onMinimize(): void;
  onFinished(): void;
}) {
  const { client, models } = useAccount();
  const { workspaceId, sessionId } = props.target;
  // Always live, also in the background: a call keeps running with the phone locked.
  const feed = useSessionEvents(sessionId, { client, workspaceId, enabled: true });
  const session = useSession(sessionId, {
    client,
    workspaceId,
    enabled: true,
    events: feed.events,
  });
  const queue = useTurnQueue(sessionId, {
    client,
    workspaceId,
    enabled: true,
    events: feed.events,
  });
  const codexConnected = models.some(
    (model) => model.provider === "codex" || model.id.startsWith("codex/"),
  );
  const selection = useRealtimeModelSelection({ client, workspaceId, codexConnected });
  // Native voice streams over WebRTC; fall back from a browser-only voice model.
  const voice = nativeRealtimeModelSupported(selection.selectedModel.id)
    ? selection.selectedModel
    : (selection.models.find(
        (model) => model.available && nativeRealtimeModelSupported(model.id),
      ) ?? selection.selectedModel);
  const realtime = useNativeSessionRealtime({
    client,
    workspaceId,
    sessionId,
    sessionStatus: session.session?.status ?? feed.sessionStatus ?? "idle",
    effectiveControl: queue.effectiveControl ?? LOADING_CONTROL,
    events: feed.events,
    eventsReady: !feed.initialLoading,
    codexConnected,
    model: voice.id,
    modelAvailable: voice.available,
    modelUnavailableReason: voice.unavailableReason,
    webrtc,
  });
  const title = session.session ? sessionDisplayTitle(session.session) : "New session";
  const call = useNativeRealtimeCall({
    realtime,
    call: props.callAdapter,
    title,
    target: sessionId,
  });

  // Start once, as soon as the session and voice model are ready.
  const startedRef = useRef(false);
  const { canStart, start } = call;
  const { onFinished } = props;
  useEffect(() => {
    if (startedRef.current || !canStart) return;
    startedRef.current = true;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void start().catch((error: unknown) => {
      Alert.alert("Couldn't start the call", error instanceof Error ? error.message : undefined);
      onFinished();
    });
  }, [canStart, onFinished, start]);
  // A call that ran and ended (here, on the lock screen or by the agent) closes.
  useEffect(() => {
    if (startedRef.current && call.phase === "idle" && !call.error) onFinished();
  }, [call.error, call.phase, onFinished]);
  // Surface a blocker that will never clear (for example voice not connected).
  const blocker = realtime.admissionBlocker;
  useEffect(() => {
    if (startedRef.current || !blocker || feed.initialLoading || !queue.effectiveControl) return;
    const timer = setTimeout(() => {
      if (startedRef.current) return;
      Alert.alert("Can't call this session", blocker);
      onFinished();
    }, 4000);
    return () => clearTimeout(timer);
  }, [blocker, feed.initialLoading, onFinished, queue.effectiveControl]);

  return (
    <>
      <Modal
        visible={props.expanded}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={props.onMinimize}
      >
        <AppThemeProvider>
          <CallScreen
            call={call}
            title={title}
            subtitle={voice.label}
            onMinimize={props.onMinimize}
            onClose={call.error ? onFinished : undefined}
          />
        </AppThemeProvider>
      </Modal>
      {!props.expanded ? (
        <AppThemeProvider>
          <OnCallPill
            title={title}
            phase={call.phase}
            muted={call.muted}
            onPress={props.onExpand}
          />
        </AppThemeProvider>
      ) : null}
    </>
  );
}

function CallScreen(props: {
  call: ReturnType<typeof useNativeRealtimeCall>;
  title: string;
  subtitle: string;
  onMinimize(): void;
  onClose?: (() => void) | undefined;
}) {
  const insets = useSafeAreaInsets();
  const theme = useNativeTimelineTheme();
  return (
    <View
      style={{
        flex: 1,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        backgroundColor: theme.colors.canvas,
      }}
    >
      <OpenGeniNativeCallView
        call={props.call}
        title={props.title}
        subtitle={props.subtitle}
        onMinimize={props.onClose ?? props.onMinimize}
      />
    </View>
  );
}

/** While minimized: a pill above the content that returns to the call. */
function OnCallPill(props: { title: string; phase: string; muted: boolean; onPress(): void }) {
  const insets = useSafeAreaInsets();
  const theme = useNativeTimelineTheme();
  const status = props.phase === "active" ? (props.muted ? "Muted" : "On call") : "Connecting…";
  return (
    <View pointerEvents="box-none" style={[styles.pillLayer, { top: insets.top + 6 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${status}: ${props.title}. Return to call`}
        onPress={props.onPress}
        style={({ pressed }) => [
          styles.pill,
          { backgroundColor: theme.colors.fg, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <View style={[styles.pillDot, { backgroundColor: "#34C759" }]} />
        <Text numberOfLines={1} style={[styles.pillText, { color: theme.colors.bg }]}>
          {status} · {props.title}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  pillLayer: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    maxWidth: "80%",
    paddingHorizontal: 14,
    height: 34,
    borderRadius: 17,
  },
  pillDot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontSize: 14, fontWeight: "600" },
});
