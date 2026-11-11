import { useSession, useSessionEvents, useTurnQueue } from "@opengeni/react/session";
import type { ChatClient } from "@opengeni/sdk";
import { useRealtimeModelSelection } from "@opengeni/react/session-realtime";
import { OpenGeniApiError, type EffectiveSessionControl, type OpenGeniClient } from "@opengeni/sdk";
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
import { useNativeTimelineTheme } from "../timeline/theme";
import { nativeCallTitle } from "./call-title";
import {
  DEFAULT_OPENGENI_NATIVE_CALL_LABELS,
  OpenGeniNativeCallView,
  type OpenGeniNativeCallLabels,
} from "./call-view";
import {
  nativeCallHandle,
  nativeRealtimeModelSupported,
  useNativeRealtimeCall,
  type NativeCallAdapter,
} from "./native-call";
import type { NativeWebRtcAdapter } from "./native-realtime";
import { useNativeSessionRealtime } from "./use-native-session-realtime";
import { useIncomingAgentCalls } from "./incoming-agent-calls";
import { useOpenGeniText, type OpenGeniText } from "@opengeni/react/messages";

/** Copy the call surfaces draw outside the call screen itself. */
export type NativeAgentCallMessages = {
  untitledSession: string;
  couldNotStart: string;
  cannotCallSession: string;
  onCall: string;
  muted: string;
  connecting: string;
  returnToCall(status: string, title: string): string;
  call: Partial<OpenGeniNativeCallLabels>;
};

export const DEFAULT_NATIVE_AGENT_CALL_MESSAGES = (t: OpenGeniText): NativeAgentCallMessages => ({
  untitledSession: t("native.realtime.agentCall.newSession"),
  couldNotStart: t("native.realtime.agentCall.couldnTStartTheCall"),
  cannotCallSession: t("native.realtime.agentCall.canTCallThisSession"),
  onCall: t("native.realtime.agentCall.onCall"),
  muted: t("native.realtime.agentCall.muted"),
  connecting: t("native.realtime.agentCall.connecting"),
  returnToCall: (status, title) =>
    t("native.realtime.agentCall.statusTitleReturnToCall", { status, title }),
  call: DEFAULT_OPENGENI_NATIVE_CALL_LABELS(t),
});

export type NativeAgentCallContextValue = {
  /** The session on a call, if any. */
  sessionId: string | null;
  /**
   * Call the agent in this session (or bring its call back to the front).
   * `workspaceId` names the session's workspace when it is not the provider's
   * current one, for example a session opened from a link.
   */
  callSession(sessionId: string, workspaceId?: string): void;
  /**
   * A call from outside the app: `sessionId`, or wherever the host sends
   * outside calls. `workspaceId` names the session's workspace when it may not
   * be the current one (a voice command, a link); it must belong to the
   * signed-in account, whose client makes every request.
   */
  callFromOutside(sessionId: string | null, workspaceId?: string | null): Promise<void>;
  /**
   * Hide the on-call pill while a screen shows this session's conversation
   * (its own call button already returns to the call). Returns the release.
   */
  hidePillFor: (sessionId: string) => () => void;
};

export type NativeOutsideCallContext = {
  client: ChatClient<OpenGeniClient>;
  /** The workspace the call runs in: the one the request named, else the current one. */
  workspaceId: string;
  /** The session the request named (Phone recents, a voice command), or null (Siri, a control, a shortcut). */
  requested: string | null;
  /**
   * The workspace the request named with its session (a voice command, a
   * recent call, a link), or null when it named none and the current one applies.
   */
  requestedWorkspaceId?: string | null;
  /** Whether a session still exists in `workspaceId` (deleted sessions answer false). */
  sessionExists(sessionId: string): Promise<boolean>;
  /** Optional host policy: the newest top-level session, or a new voice-first session. */
  latestOrNew(): Promise<string>;
};

export type NativeAgentCallProviderProps = {
  client: ChatClient<OpenGeniClient>;
  /**
   * The workspace calls start in. No calls start until the host has one, so
   * pass null until `client` can make requests (for example while the saved
   * sign-in is still being read at launch): start requests wait until then.
   */
  workspaceId: string | null;
  /** Whether the user's workspace can use Codex voice models. */
  codexConnected: boolean;
  /** The system call integration (CallKit), or null where there is none. */
  callAdapter: NativeCallAdapter | null;
  webrtc: NativeWebRtcAdapter;
  /** Where a call from outside the app goes; defaults to the requested or a fresh session. */
  resolveOutsideCall?(context: NativeOutsideCallContext): Promise<string>;
  /** Runs as a call starts (for example a haptic). */
  onCallStarting?(): void;
  /** Shows a failure; defaults to an alert. */
  onError?(title: string, message?: string): void;
  /** Wraps the call screen and on-call pill (for example in the host's theme). */
  renderSurface?(surface: ReactNode): ReactNode;
  /**
   * Distance of the on-call pill below the top safe area. The default (56)
   * keeps it under a standard navigation bar, clear of its buttons.
   */
  pillTopOffset?: number;
  messages?: Partial<NativeAgentCallMessages>;
  children?: ReactNode;
};

const NativeAgentCallContext = createContext<NativeAgentCallContextValue>({
  sessionId: null,
  callSession: () => undefined,
  callFromOutside: async () => undefined,
  hidePillFor: () => () => undefined,
});

/** The app's call: who is on it, and starting one from a session or from outside. */
export function useNativeAgentCall(): NativeAgentCallContextValue {
  return useContext(NativeAgentCallContext);
}

// Starting is blocked until the session's real control state has loaded.
const LOADING_CONTROL = {
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

function defaultError(title: string, message?: string): void {
  Alert.alert(title, message);
}

type CallTarget = {
  workspaceId: string;
  sessionId: string;
  systemTarget: string | null;
  /** An agent's call the person answered: voice runs on that system call. */
  answeredCallId?: string | undefined;
  /** Mounted silently; provider preconnection additionally requires the native audio gate. */
  ringing?: boolean | undefined;
  incomingDevice?: string | undefined;
};

/**
 * One call with an agent at a time, above navigation: it keeps talking while the
 * user reads the chat, leaves the app or locks the phone. Calls start from a
 * session (`useNativeAgentCall().callSession`) or from outside the app (Phone
 * recents, Siri, App Shortcuts, a Control Center control, a home-screen
 * action), which the system call adapter reports here.
 */
export function NativeAgentCallProvider(props: NativeAgentCallProviderProps) {
  const t = useOpenGeniText();
  const { client, workspaceId, callAdapter, resolveOutsideCall } = props;
  const messages = useMemo(
    () => ({ ...DEFAULT_NATIVE_AGENT_CALL_MESSAGES(t), ...props.messages }),
    [props.messages, t],
  );
  const onError = props.onError ?? defaultError;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [target, setTarget] = useState<CallTarget | null>(null);
  const [expanded, setExpanded] = useState(false);

  const callSession = useCallback(
    (sessionId: string, sessionWorkspaceId?: string) => {
      const callWorkspaceId = sessionWorkspaceId || workspaceId;
      if (!callWorkspaceId) return;
      setTarget((current) =>
        current?.sessionId === sessionId && current.workspaceId === callWorkspaceId
          ? current
          : {
              workspaceId: callWorkspaceId,
              sessionId,
              systemTarget: nativeCallHandle(callWorkspaceId, sessionId),
            },
      );
      setExpanded(true);
    },
    [workspaceId],
  );

  const callFromOutside = useCallback(
    async (requested: string | null, requestedWorkspace?: string | null) => {
      if (!workspaceId) return;
      // A workspace means nothing without the session it holds.
      const requestedWorkspaceId = (requested && requestedWorkspace) || null;
      const callWorkspaceId = requestedWorkspaceId ?? workspaceId;
      try {
        const sessionExists = (sessionId: string) =>
          client.getSession(callWorkspaceId, sessionId).then(
            () => true,
            (error: unknown) => {
              if (error instanceof OpenGeniApiError && error.status === 404) return false;
              throw error;
            },
          );
        const latestOrNew = async () => {
          // Sub-agent sessions are not conversations.
          const [latest] = await client.listSessions(callWorkspaceId, {
            limit: 1,
            parentSessionId: null,
          });
          if (latest) return latest.id;
          // An idle session shell: voice is its first interaction.
          const created = await client.createSession(callWorkspaceId, {
            startMode: "realtime",
          });
          return created.id;
        };
        const context: NativeOutsideCallContext = {
          client,
          workspaceId: callWorkspaceId,
          requested,
          requestedWorkspaceId,
          sessionExists,
          latestOrNew,
        };
        const sessionId = resolveOutsideCall
          ? await resolveOutsideCall(context)
          : (requested ??
            (await client.createSession(callWorkspaceId, { startMode: "realtime" })).id);
        // Generic Phone recents must remain generic on the next call. Only
        // explicit session calls record a session handle with CallKit.
        setTarget((current) =>
          current?.sessionId === sessionId && current.workspaceId === callWorkspaceId
            ? current
            : {
                workspaceId: callWorkspaceId,
                sessionId,
                systemTarget: requested ? nativeCallHandle(callWorkspaceId, sessionId) : null,
              },
        );
        setExpanded(true);
      } catch (error) {
        onErrorRef.current(
          messages.couldNotStart,
          error instanceof Error ? error.message : undefined,
        );
      }
    },
    [client, messages.couldNotStart, resolveOutsideCall, workspaceId],
  );

  // An agent calling this phone: answering on the ring screen opens its chat's call.
  useIncomingAgentCalls({
    client,
    callAdapter,
    onRinging: (call, device) => {
      setTarget(
        (current) =>
          current ?? {
            workspaceId: call.workspaceId,
            sessionId: call.sessionId,
            systemTarget: call.sessionId,
            answeredCallId: call.callId,
            ringing: true,
            incomingDevice: device,
          },
      );
    },
    onEnded: (callId) => {
      setTarget((current) => (current?.answeredCallId === callId ? null : current));
    },
    onAnswered: (call, device) => {
      setTarget({
        workspaceId: call.workspaceId,
        sessionId: call.sessionId,
        systemTarget: call.sessionId,
        answeredCallId: call.callId,
        incomingDevice: device,
      });
      setExpanded(true);
    },
    onError: (error) =>
      onErrorRef.current(
        messages.couldNotStart,
        error instanceof Error ? error.message : undefined,
      ),
  });

  const outsideRef = useRef(callFromOutside);
  outsideRef.current = callFromOutside;
  useEffect(() => {
    if (!callAdapter || !workspaceId) return;
    const take = () =>
      void callAdapter.takePendingStartRequest().then((pending) => {
        if (pending) void outsideRef.current(pending.target, pending.workspaceId);
      });
    const unsubscribe = callAdapter.subscribe((event) => {
      if (event.type !== "startRequested") return;
      // A request that waits natively is taken, so it starts exactly once:
      // whichever of this event and the take below comes first gets it.
      if (event.requestId) take();
      else void outsideRef.current(event.target, event.workspaceId);
    });
    take();
    return unsubscribe;
  }, [callAdapter, workspaceId]);

  const [pillHiddenFor, setPillHiddenFor] = useState<readonly string[]>([]);
  const hidePillFor = useCallback((sessionId: string) => {
    setPillHiddenFor((current) => [...current, sessionId]);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setPillHiddenFor((current) => {
        const index = current.indexOf(sessionId);
        return index < 0 ? current : [...current.slice(0, index), ...current.slice(index + 1)];
      });
    };
  }, []);
  const value = useMemo(
    () => ({
      sessionId: target?.ringing ? null : (target?.sessionId ?? null),
      callSession,
      callFromOutside,
      hidePillFor,
    }),
    [callFromOutside, callSession, hidePillFor, target?.sessionId, target?.ringing],
  );
  const finish = useCallback(() => {
    setTarget(null);
    setExpanded(false);
  }, []);

  return (
    <NativeAgentCallContext.Provider value={value}>
      {props.children}
      {target?.workspaceId || workspaceId ? (
        <AgentCallHost
          key={target?.workspaceId ?? workspaceId}
          {...props}
          workspaceId={(target?.workspaceId ?? workspaceId)!}
          target={target}
          messages={messages}
          onError={onError}
          expanded={expanded}
          pillHidden={target ? pillHiddenFor.includes(target.sessionId) : false}
          onExpand={() => setExpanded(true)}
          onMinimize={() => setExpanded(false)}
          onFinished={finish}
        />
      ) : null}
    </NativeAgentCallContext.Provider>
  );
}

type AgentCallSurfaceProps = NativeAgentCallProviderProps & {
  messages: NativeAgentCallMessages;
  onError(title: string, message?: string): void;
  expanded: boolean;
  pillHidden: boolean;
  onExpand(): void;
  onMinimize(): void;
  onFinished(): void;
};

/** Resolve the workspace's voice choice before a call, retaining the loaded catalog. */
function AgentCallHost(
  props: AgentCallSurfaceProps & { workspaceId: string; target: CallTarget | null },
) {
  const selection = useRealtimeModelSelection({
    client: props.client,
    workspaceId: props.workspaceId,
    codexConnected: props.codexConnected,
  });
  return props.target ? (
    <ActiveAgentCall
      key={`${props.target.sessionId}:${props.target.answeredCallId ?? ""}`}
      {...props}
      target={props.target}
      selection={selection}
    />
  ) : null;
}

function ActiveAgentCall(
  props: AgentCallSurfaceProps & {
    target: CallTarget;
    selection: ReturnType<typeof useRealtimeModelSelection>;
  },
) {
  const { client, codexConnected, messages, onError, onFinished } = props;
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
  const selection = props.selection;
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
    // Observing lifecycle can recover a stored owner. Ring preparation must
    // not recover/start another provider call before this phone wins Answer.
    eventsReady: !props.target.ringing && !feed.initialLoading,
    codexConnected,
    model: voice.id,
    modelAvailable: voice.available,
    modelUnavailableReason: voice.unavailableReason,
    webrtc: props.webrtc,
  });
  const title = nativeCallTitle(session.session, messages.untitledSession);
  const call = useNativeRealtimeCall({
    realtime,
    call: props.callAdapter,
    title,
    target: props.target.systemTarget,
    answeredCallId: props.target.answeredCallId,
  });

  // Start once, as soon as the session and voice model are ready. The voice
  // catalog must have loaded: a model chosen from the placeholder catalog would
  // be replaced right after the start, which aborts the connection.
  const startedRef = useRef(false);
  const { canStart, start } = call;
  const ready = canStart && selection.catalogReady && !props.target.ringing;
  const { prepare, prepareIncoming } = realtime;
  const incomingPreparationAttempted = useRef(false);
  useEffect(() => {
    if (!canStart || !selection.catalogReady) return;
    if (
      props.callAdapter?.incoming?.connectsBeforeAnswer === true &&
      voice.incomingPreparation &&
      props.target.ringing &&
      props.target.answeredCallId &&
      props.target.incomingDevice
    ) {
      if (incomingPreparationAttempted.current) return;
      incomingPreparationAttempted.current = true;
      void prepareIncoming({
        callId: props.target.answeredCallId,
        device: props.target.incomingDevice,
      }).catch(() => undefined);
    } else void prepare().catch(() => undefined);
  }, [
    canStart,
    prepare,
    prepareIncoming,
    selection.catalogReady,
    props.target.ringing,
    props.target.answeredCallId,
    props.target.incomingDevice,
    voice.incomingPreparation,
    props.callAdapter?.incoming?.connectsBeforeAnswer,
  ]);
  const onCallStartingRef = useRef(props.onCallStarting);
  onCallStartingRef.current = props.onCallStarting;
  useEffect(() => {
    if (startedRef.current || !ready) return;
    startedRef.current = true;
    onCallStartingRef.current?.();
    void start().catch((error: unknown) => {
      onError(messages.couldNotStart, error instanceof Error ? error.message : undefined);
      onFinished();
    });
  }, [messages.couldNotStart, onError, onFinished, ready, start]);
  // A call that ran and ended (here, on the lock screen or by the agent) closes.
  const observedStartedCall = useRef(false);
  useEffect(() => {
    if (call.phase !== "idle") observedStartedCall.current = true;
    else if (startedRef.current && observedStartedCall.current && !call.error) onFinished();
  }, [call.error, call.phase, onFinished]);
  // Surface a blocker that will never clear (for example voice not connected).
  const blocker = realtime.admissionBlocker;
  useEffect(() => {
    if (
      props.target.ringing ||
      startedRef.current ||
      !blocker ||
      feed.initialLoading ||
      !queue.effectiveControl
    )
      return;
    const timer = setTimeout(() => {
      if (startedRef.current) return;
      onError(messages.cannotCallSession, blocker);
      onFinished();
    }, 4000);
    return () => clearTimeout(timer);
  }, [
    blocker,
    feed.initialLoading,
    messages.cannotCallSession,
    onError,
    onFinished,
    queue.effectiveControl,
    props.target.ringing,
  ]);

  const surface = (node: ReactNode) => (props.renderSurface ? props.renderSurface(node) : node);
  if (props.target.ringing) return null;
  return (
    <>
      <Modal
        visible={props.expanded}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={props.onMinimize}
      >
        {surface(
          <CallScreen
            call={call}
            title={title}
            labels={messages.call}
            onMinimize={call.error ? onFinished : props.onMinimize}
          />,
        )}
      </Modal>
      {!props.expanded && !props.pillHidden
        ? surface(
            <OnCallPill
              title={title}
              topOffset={props.pillTopOffset ?? 56}
              status={
                call.phase === "active"
                  ? call.muted
                    ? messages.muted
                    : messages.onCall
                  : messages.connecting
              }
              accessibilityLabel={messages.returnToCall}
              onPress={props.onExpand}
            />,
          )
        : null}
    </>
  );
}

function CallScreen(props: {
  call: ReturnType<typeof useNativeRealtimeCall>;
  title: string;
  labels: Partial<OpenGeniNativeCallLabels>;
  onMinimize(): void;
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
        labels={props.labels}
        onMinimize={props.onMinimize}
      />
    </View>
  );
}

/** While minimized: a pill above the content that returns to the call. */
function OnCallPill(props: {
  title: string;
  status: string;
  topOffset: number;
  accessibilityLabel(status: string, title: string): string;
  onPress(): void;
}) {
  const insets = useSafeAreaInsets();
  const theme = useNativeTimelineTheme();
  return (
    <View
      pointerEvents="box-none"
      style={[styles.pillLayer, { top: insets.top + props.topOffset }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel(props.status, props.title)}
        onPress={props.onPress}
        style={({ pressed }) => [
          styles.pill,
          { backgroundColor: theme.colors.fg, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <View style={[styles.pillDot, { backgroundColor: "#34C759" }]} />
        <Text numberOfLines={1} style={[styles.pillText, { color: theme.colors.bg }]}>
          {props.status} · {props.title}
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
