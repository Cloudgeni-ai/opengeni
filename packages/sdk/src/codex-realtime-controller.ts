import { createCodexRealtimeV3Bridge } from "./codex-realtime-v3";
import type { CodexRealtimeV3Bridge, CodexRealtimeV3BridgeSnapshot } from "./codex-realtime-v3";
import type { SessionRealtimeLifecycleProjection } from "./codex-realtime-lifecycle";
import {
  acquireCodexRealtimeMicrophone,
  codexRealtimeMicrophoneHealthy,
  CodexRealtimeMicrophoneError,
  startCodexRealtimeWebrtc,
} from "./codex-realtime";
import type {
  CodexRealtimeAudibleOutputState,
  CodexRealtimeConnectionHealth,
  CodexRealtimeMicrophoneErrorCode,
  CodexRealtimeWebrtcSession,
} from "./codex-realtime";
import { OpenGeniApiError } from "./errors";
import type {
  ActivateCodexRealtimeConnectionRequest,
  BeginSessionRealtimeRequest,
  CodexRealtimeWebrtcRequest,
  CodexRealtimeWebrtcResponse,
  EndSessionRealtimeRequest,
  RenewSessionRealtimeRequest,
  SessionRealtimeMode,
  SessionRealtimeMutationResponse,
  SyncSessionRealtimeLedgerRequest,
  SyncSessionRealtimeLedgerResponse,
} from "./types";

export { projectSessionRealtimeLifecycle } from "./codex-realtime-lifecycle";
export type { SessionRealtimeLifecycleProjection } from "./codex-realtime-lifecycle";

const HEARTBEAT_INTERVAL_MS = 10_000;
const OUTBOUND_SYNC_INTERVAL_MS = 1_000;
// OpenGeni policy: rotate conservatively without asserting an upstream lifetime.
const DEFAULT_CONNECTION_ROTATION_INTERVAL_MS = 15 * 60_000;
const DEFAULT_RECONNECT_BACKOFF_MS = [250, 1_000, 2_000, 5_000] as const;
const OWNER_RECORD_VERSION = 1;

export type CodexRealtimeControllerStatus =
  | "idle"
  | "starting"
  | "active"
  | "stopping"
  | "recovering"
  | "lost_owner"
  | "error";

export type CodexRealtimeMicrophoneState =
  | "inactive"
  | "acquiring"
  | "active"
  | CodexRealtimeMicrophoneErrorCode;

export type CodexRealtimeDiagnosticKind =
  | "permission_failure"
  | "device_failure"
  | "autoplay_blocked"
  | "negotiation_failure"
  | "rotation"
  | "reconnect"
  | "lost_owner"
  | "terminal_stop";

export type CodexRealtimeDiagnostic = {
  kind: CodexRealtimeDiagnosticKind;
  message: string;
  recoverable: boolean;
  connectionGeneration: number;
  attempt: number;
};

export type CodexRealtimeControllerSnapshot = {
  status: CodexRealtimeControllerStatus;
  realtimeId: string | null;
  mode: SessionRealtimeMode | null;
  bridge: CodexRealtimeV3BridgeSnapshot | null;
  microphone: CodexRealtimeMicrophoneState;
  audibleOutput: CodexRealtimeAudibleOutputState;
  connectionGeneration: number;
  reconnectAttempt: number;
  diagnostic: CodexRealtimeDiagnostic | null;
  error: string | null;
};

export type CodexRealtimeControllerClient = {
  beginSessionRealtime(
    workspaceId: string,
    sessionId: string,
    request: BeginSessionRealtimeRequest,
  ): Promise<SessionRealtimeMutationResponse>;
  heartbeatSessionRealtime(
    workspaceId: string,
    sessionId: string,
    realtimeId: string,
    request: RenewSessionRealtimeRequest,
  ): Promise<SessionRealtimeMutationResponse>;
  negotiateCodexRealtimeWebrtc(
    workspaceId: string,
    sessionId: string,
    request: CodexRealtimeWebrtcRequest,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<CodexRealtimeWebrtcResponse>;
  activateCodexRealtimeConnection(
    workspaceId: string,
    sessionId: string,
    realtimeId: string,
    connectionId: string,
    request: ActivateCodexRealtimeConnectionRequest,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<SessionRealtimeMutationResponse>;
  syncSessionRealtimeLedger(
    workspaceId: string,
    sessionId: string,
    realtimeId: string,
    request: SyncSessionRealtimeLedgerRequest,
  ): Promise<SyncSessionRealtimeLedgerResponse>;
  endSessionRealtime(
    workspaceId: string,
    sessionId: string,
    realtimeId: string,
    request: EndSessionRealtimeRequest,
  ): Promise<SessionRealtimeMutationResponse>;
};

export type CodexRealtimeOwnerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type CreateCodexRealtimeControllerOptions = {
  client: CodexRealtimeControllerClient;
  workspaceId: string;
  sessionId: string;
  storage?: CodexRealtimeOwnerStorage | undefined;
  remoteAudio?: HTMLAudioElement | undefined;
  createPeerConnection?: (() => RTCPeerConnection) | undefined;
  getUserMedia?: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | undefined;
  randomUUID?: (() => string) | undefined;
  setInterval?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  clearInterval?: ((handle: unknown) => void) | undefined;
  setTimeout?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  clearTimeout?: ((handle: unknown) => void) | undefined;
  connectionRotationIntervalMs?: number | undefined;
  reconnectBackoffMs?: readonly number[] | undefined;
};

export type CodexRealtimeController = {
  snapshot(): CodexRealtimeControllerSnapshot;
  subscribe(listener: (snapshot: CodexRealtimeControllerSnapshot) => void): () => void;
  start(): Promise<void>;
  observeLifecycle(lifecycle: SessionRealtimeLifecycleProjection | null): Promise<void>;
  heartbeat(): Promise<void>;
  flush(): Promise<void>;
  ingestProviderEvent(payload: string): Promise<void>;
  retry(): Promise<void>;
  retryAudibleOutput(): Promise<boolean>;
  stop(): Promise<void>;
  /** Close browser resources but retain owner proof for truthful reload recovery. */
  close(): void;
};

type OwnerRecord = {
  version: typeof OWNER_RECORD_VERSION;
  workspaceId: string;
  sessionId: string;
  operationId: string;
  browserInstanceId: string;
  ownerKey: string;
};

type ConnectionRuntime = {
  generation: number;
  transport: CodexRealtimeWebrtcSession;
  bridge: CodexRealtimeV3Bridge;
};

type RecoveryCause = "rotation" | "reconnect" | "microphone" | "reload" | "manual";

/**
 * Compose the existing lifecycle API, WebRTC transport, and durable V3 bridge
 * into one indefinitely rotating browser owner. Provider protocol semantics stay
 * below this seam; this controller owns only browser resources and connection
 * generations.
 */
export function createCodexRealtimeController(
  options: CreateCodexRealtimeControllerOptions,
): CodexRealtimeController {
  const storage = options.storage ?? defaultStorage();
  const storageKey = ownerStorageKey(options.workspaceId, options.sessionId);
  const randomUUID = options.randomUUID ?? defaultRandomUUID;
  const scheduleInterval =
    options.setInterval ?? ((callback, delay) => globalThis.setInterval(callback, delay));
  const unscheduleInterval =
    options.clearInterval ??
    ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  const scheduleTimeout =
    options.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const unscheduleTimeout =
    options.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const rotationInterval = positiveDuration(
    options.connectionRotationIntervalMs ?? DEFAULT_CONNECTION_ROTATION_INTERVAL_MS,
    "connection rotation interval",
  );
  const reconnectBackoff = validateReconnectBackoff(
    options.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS,
  );
  const listeners = new Set<(snapshot: CodexRealtimeControllerSnapshot) => void>();
  let owner: OwnerRecord | null = readOwnerRecord(storage, storageKey, options);
  let state: CodexRealtimeControllerSnapshot = {
    status: owner ? "recovering" : "idle",
    realtimeId: null,
    mode: null,
    bridge: null,
    microphone: "inactive",
    audibleOutput: "inactive",
    connectionGeneration: 0,
    reconnectAttempt: 0,
    diagnostic: null,
    error: null,
  };
  let active: ConnectionRuntime | null = null;
  let pendingAbort: AbortController | null = null;
  let pendingGeneration: number | null = null;
  let microphone: MediaStream | null = null;
  let heartbeatTimer: unknown = null;
  let syncTimer: unknown = null;
  let rotationTimer: unknown = null;
  let reconnectTimer: unknown = null;
  let closed = false;
  let stopping = false;
  let generation = 0;
  let reconnectAttempt = 0;
  let recoveryTerminal = false;
  let mutationTail = Promise.resolve();
  let connectionTask: Promise<void> | null = null;

  const publish = (patch: Partial<CodexRealtimeControllerSnapshot>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener({ ...state });
  };

  const diagnostic = (
    kind: CodexRealtimeDiagnosticKind,
    message: string,
    recoverable: boolean,
    targetGeneration = state.connectionGeneration,
  ): CodexRealtimeDiagnostic => ({
    kind,
    message,
    recoverable,
    connectionGeneration: targetGeneration,
    attempt: reconnectAttempt,
  });

  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = mutationTail.then(operation, operation);
    mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  };

  const stopTimers = (): void => {
    if (heartbeatTimer !== null) unscheduleInterval(heartbeatTimer);
    if (syncTimer !== null) unscheduleInterval(syncTimer);
    if (rotationTimer !== null) unscheduleTimeout(rotationTimer);
    if (reconnectTimer !== null) unscheduleTimeout(reconnectTimer);
    heartbeatTimer = null;
    syncTimer = null;
    rotationTimer = null;
    reconnectTimer = null;
  };

  const stopNegotiationTimers = (): void => {
    if (heartbeatTimer !== null) unscheduleInterval(heartbeatTimer);
    if (rotationTimer !== null) unscheduleTimeout(rotationTimer);
    if (reconnectTimer !== null) unscheduleTimeout(reconnectTimer);
    heartbeatTimer = null;
    rotationTimer = null;
    reconnectTimer = null;
  };

  const releaseMicrophone = (): void => {
    const current = microphone;
    microphone = null;
    current?.getTracks().forEach((track) => track.stop());
    publish({ microphone: "inactive" });
  };

  const closeActive = (): void => {
    const current = active;
    active = null;
    current?.bridge.close();
    current?.transport.stop();
    publish({ bridge: null, audibleOutput: "inactive" });
  };

  const closeBrowserResources = (releaseMedia = true): void => {
    stopTimers();
    pendingAbort?.abort(new DOMException("Codex realtime browser owner closed", "AbortError"));
    pendingAbort = null;
    pendingGeneration = null;
    closeActive();
    if (releaseMedia) releaseMicrophone();
  };

  const clearOwner = (): void => {
    owner = null;
    storage?.removeItem(storageKey);
  };

  const transitionEnded = (message = "Realtime mode ended"): void => {
    stopping = false;
    connectionTask = null;
    closeBrowserResources();
    clearOwner();
    reconnectAttempt = 0;
    recoveryTerminal = false;
    publish({
      status: "idle",
      realtimeId: null,
      mode: null,
      bridge: null,
      reconnectAttempt: 0,
      diagnostic: diagnostic("terminal_stop", message, false),
      error: null,
    });
  };

  const ensureMicrophone = async (replace: boolean, signal: AbortSignal): Promise<MediaStream> => {
    if (!replace && codexRealtimeMicrophoneHealthy(microphone)) return microphone!;
    releaseMicrophone();
    publish({ microphone: "acquiring" });
    try {
      const acquired = await acquireCodexRealtimeMicrophone({
        signal,
        getUserMedia: options.getUserMedia,
      });
      if (closed || stopping || signal.aborted) {
        acquired.getTracks().forEach((track) => track.stop());
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      microphone = acquired;
      publish({ microphone: "active" });
      return acquired;
    } catch (error) {
      if (error instanceof CodexRealtimeMicrophoneError) {
        const kind = error.code === "permission_denied" ? "permission_failure" : "device_failure";
        publish({
          microphone: error.code,
          status: state.mode?.state === "active" ? "recovering" : "error",
          diagnostic: diagnostic(kind, error.message, true),
          error: error.message,
        });
      }
      throw error;
    }
  };

  const syncForGeneration = async (
    targetGeneration: number,
    realtimeId: string,
    request: SyncSessionRealtimeLedgerRequest,
  ): Promise<SyncSessionRealtimeLedgerResponse> =>
    await exclusive(async () => {
      const current = state.mode;
      if (
        !owner ||
        !current ||
        current.id !== realtimeId ||
        current.state !== "active" ||
        active?.generation !== targetGeneration
      ) {
        throw new Error("Codex realtime connection generation is no longer active");
      }
      return await options.client.syncSessionRealtimeLedger(
        options.workspaceId,
        options.sessionId,
        realtimeId,
        { ...request, expectedVersion: current.version },
      );
    });

  const onAudibleOutput = (
    targetGeneration: number,
    next: CodexRealtimeAudibleOutputState,
  ): void => {
    if (active?.generation !== targetGeneration || closed || stopping) return;
    if (next === "blocked") {
      const message =
        "Browser blocked audible realtime output. Use Resume audio to continue listening.";
      publish({
        audibleOutput: next,
        diagnostic: diagnostic("autoplay_blocked", message, true),
        error: message,
      });
      return;
    }
    publish({ audibleOutput: next, ...(next === "audible" ? { error: null } : {}) });
  };

  const startActiveIntervals = (): void => {
    if (heartbeatTimer === null) {
      heartbeatTimer = scheduleInterval(() => {
        void heartbeat().catch((error) => {
          if (!closed && !stopping) {
            publish({ error: safeError(error) });
            scheduleRecovery("reconnect", false);
          }
        });
      }, HEARTBEAT_INTERVAL_MS);
    }
    if (syncTimer === null) {
      syncTimer = scheduleInterval(() => {
        void flush().catch((error) => {
          if (!closed && !stopping) publish({ error: safeError(error) });
        });
      }, OUTBOUND_SYNC_INTERVAL_MS);
    }
  };

  const scheduleRecovery = (
    cause: RecoveryCause,
    replaceMicrophone: boolean,
    immediate = false,
  ): void => {
    if (closed || stopping || recoveryTerminal || !owner || state.mode?.state !== "active") return;
    if (connectionTask || reconnectTimer !== null) return;
    if (rotationTimer !== null) unscheduleTimeout(rotationTimer);
    rotationTimer = null;
    startActiveIntervals();
    const kind =
      cause === "rotation" ? "rotation" : cause === "microphone" ? "device_failure" : "reconnect";
    const message =
      cause === "rotation"
        ? "Rotating the finite provider connection"
        : cause === "microphone"
          ? "Recovering microphone and realtime connection"
          : "Recovering the realtime provider connection";
    publish({
      status: "recovering",
      reconnectAttempt,
      diagnostic: diagnostic(kind, message, true),
      error: cause === "rotation" ? null : message,
    });
    const delay = immediate
      ? 0
      : reconnectBackoff[Math.min(reconnectAttempt, reconnectBackoff.length - 1)]!;
    reconnectTimer = scheduleTimeout(() => {
      reconnectTimer = null;
      const record = owner;
      const mode = state.mode;
      if (connectionTask || !record || !mode || closed || stopping || mode.state !== "active") {
        return;
      }
      connectionTask = establish(record, mode, cause, true, replaceMicrophone)
        .then(() => {
          reconnectAttempt = 0;
          publish({ reconnectAttempt: 0 });
        })
        .catch(async (error: unknown) => {
          connectionTask = null;
          await handleConnectionFailure(error, cause, replaceMicrophone);
        })
        .finally(() => {
          connectionTask = null;
        });
    }, delay);
  };

  const handleConnectionFailure = async (
    error: unknown,
    cause: RecoveryCause,
    replaceMicrophone: boolean,
  ): Promise<void> => {
    if (closed || stopping || isAbortError(error)) return;
    const message = safeError(error);
    if (error instanceof CodexRealtimeMicrophoneError) {
      if (error.code === "track_ended" && state.mode?.state === "active") {
        reconnectAttempt += 1;
        publish({
          status: "recovering",
          microphone: error.code,
          reconnectAttempt,
          diagnostic: diagnostic("device_failure", error.message, true),
          error: error.message,
        });
        scheduleRecovery("microphone", true);
      } else if (state.mode?.state === "active") {
        // Keep the owned mode alive while an explicit permission/device retry
        // waits for a user gesture; no provider connection is claimed healthy.
        startActiveIntervals();
      }
      return;
    }
    if (error instanceof OpenGeniApiError && error.status === 404) {
      transitionEnded("Realtime owner no longer exists");
      return;
    }
    if (error instanceof OpenGeniApiError && error.status === 409 && error.retryable && owner) {
      try {
        const reconciled = await begin(owner, true, false);
        if (!reconciled || reconciled.state === "ended") return;
      } catch (reconcileError) {
        if (reconcileError instanceof OpenGeniApiError && !reconcileError.retryable) {
          stopTimers();
          if (!active) releaseMicrophone();
          recoveryTerminal = true;
          publish({
            status: "error",
            diagnostic: diagnostic("negotiation_failure", safeError(reconcileError), false),
            error: safeError(reconcileError),
          });
          return;
        }
      }
    } else if (error instanceof OpenGeniApiError && !error.retryable) {
      stopTimers();
      if (!active) releaseMicrophone();
      recoveryTerminal = true;
      publish({
        status: "error",
        diagnostic: diagnostic("negotiation_failure", message, false),
        error: message,
      });
      return;
    }
    reconnectAttempt += 1;
    publish({
      status: "recovering",
      reconnectAttempt,
      diagnostic: diagnostic("negotiation_failure", message, true),
      error: message,
    });
    scheduleRecovery(cause === "rotation" ? "reconnect" : cause, replaceMicrophone);
  };

  const onConnectionHealth = (
    targetGeneration: number,
    health: CodexRealtimeConnectionHealth,
  ): void => {
    if (closed || stopping) return;
    if (pendingGeneration === targetGeneration && health !== "connected") {
      pendingAbort?.abort(new Error(`Codex realtime replacement ${health} before activation`));
      return;
    }
    if (active?.generation !== targetGeneration || health === "connected") return;
    scheduleRecovery("reconnect", false);
  };

  const onMicrophoneEnded = (targetGeneration: number): void => {
    if (closed || stopping) return;
    const error = new CodexRealtimeMicrophoneError(
      "track_ended",
      "The microphone device was disconnected",
    );
    publish({
      microphone: "track_ended",
      diagnostic: diagnostic("device_failure", error.message, true),
      error: error.message,
    });
    if (pendingGeneration === targetGeneration) {
      pendingAbort?.abort(error);
      return;
    }
    if (active?.generation !== targetGeneration) return;
    scheduleRecovery("microphone", true, true);
  };

  const startTimers = (): void => {
    stopTimers();
    startActiveIntervals();
    rotationTimer = scheduleTimeout(() => {
      rotationTimer = null;
      scheduleRecovery("rotation", false, true);
    }, rotationInterval);
  };

  const establish = async (
    record: OwnerRecord,
    currentMode: SessionRealtimeMode,
    cause: RecoveryCause,
    rotate: boolean,
    replaceMicrophone: boolean,
  ): Promise<void> => {
    if (currentMode.state !== "active") {
      transitionEnded();
      return;
    }
    // Freeze lease-version changes while this exact negotiation/activation
    // proof is in flight, but keep flushing the old active bridge so durable
    // updates are not suppressed while its replacement is prepared.
    stopNegotiationTimers();
    const targetGeneration = ++generation;
    pendingGeneration = targetGeneration;
    const abort = new AbortController();
    pendingAbort = abort;
    publish({
      status: rotate ? "recovering" : "starting",
      realtimeId: currentMode.id,
      mode: currentMode,
      connectionGeneration: targetGeneration,
      diagnostic:
        cause === "rotation"
          ? diagnostic(
              "rotation",
              "Rotating the finite provider connection",
              true,
              targetGeneration,
            )
          : cause === "reload" || cause === "reconnect"
            ? diagnostic("reconnect", "Reconnecting the same realtime mode", true, targetGeneration)
            : state.diagnostic,
      error: null,
    });
    let connected: CodexRealtimeWebrtcSession;
    try {
      const media = await ensureMicrophone(replaceMicrophone, abort.signal);
      connected = await startCodexRealtimeWebrtc({
        realtimeId: currentMode.id,
        operationId: randomUUID(),
        browserInstanceId: record.browserInstanceId,
        ownerKey: record.ownerKey,
        expectedVersion: currentMode.version,
        expectedConnectionEpoch: currentMode.connectionEpoch,
        rotate,
        signal: abort.signal,
        media,
        remoteAudio: options.remoteAudio,
        activateRemoteAudio: false,
        createPeerConnection: options.createPeerConnection,
        getUserMedia: options.getUserMedia,
        onAudibleOutputState: (next) => onAudibleOutput(targetGeneration, next),
        onMicrophoneEnded: () => onMicrophoneEnded(targetGeneration),
        onConnectionHealth: (health) => onConnectionHealth(targetGeneration, health),
        negotiate: async (request, requestOptions) =>
          await options.client.negotiateCodexRealtimeWebrtc(
            options.workspaceId,
            options.sessionId,
            request,
            requestOptions,
          ),
      });
    } catch (error) {
      if (pendingGeneration === targetGeneration) {
        pendingGeneration = null;
        pendingAbort = null;
      }
      throw error;
    }
    let buffering = true;
    const bufferedPayloads: string[] = [];
    const bufferMessage = (message: MessageEvent): void => {
      if (buffering && typeof message.data === "string") bufferedPayloads.push(message.data);
    };
    connected.events.addEventListener("message", bufferMessage);
    try {
      await waitForDataChannelOpen(connected.events, abort.signal);
      if (
        closed ||
        stopping ||
        abort.signal.aborted ||
        pendingGeneration !== targetGeneration ||
        !connected.microphoneHealthy()
      ) {
        if (!connected.microphoneHealthy() && !abort.signal.aborted) {
          abort.abort(
            new CodexRealtimeMicrophoneError(
              "track_ended",
              "The microphone audio track ended before realtime activation",
            ),
          );
        }
        throw abort.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const activated = await options.client.activateCodexRealtimeConnection(
        options.workspaceId,
        options.sessionId,
        currentMode.id,
        connected.connectionId,
        {
          operationId: connected.operationId,
          browserInstanceId: record.browserInstanceId,
          ownerKey: record.ownerKey,
          connectionEpoch: connected.connectionEpoch,
          expectedVersion: currentMode.version,
          expectedConnectionEpoch: currentMode.connectionEpoch,
        },
        { signal: abort.signal },
      );
      if (activated.mode.state !== "active") {
        transitionEnded();
        return;
      }
      if (
        closed ||
        stopping ||
        abort.signal.aborted ||
        pendingGeneration !== targetGeneration ||
        !connected.microphoneHealthy()
      ) {
        if (!connected.microphoneHealthy() && !abort.signal.aborted) {
          abort.abort(
            new CodexRealtimeMicrophoneError(
              "track_ended",
              "The microphone audio track ended during realtime activation",
            ),
          );
        }
        throw abort.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const previous = active;
      const bridge = createCodexRealtimeV3Bridge({
        events: connected.events,
        connectionId: connected.connectionId,
        connectionEpoch: connected.connectionEpoch,
        startupFenceSequence: connected.startupFenceSequence,
        modeVersion: activated.mode.version,
        owner: {
          browserInstanceId: record.browserInstanceId,
          ownerKey: record.ownerKey,
          expectedVersion: activated.mode.version,
        },
        sync: async (request) =>
          await syncForGeneration(targetGeneration, activated.mode.id, request),
        randomUUID,
        onSnapshot: (nextBridge) => {
          if (active?.generation === targetGeneration) publish({ bridge: nextBridge });
        },
      });
      active = { generation: targetGeneration, transport: connected, bridge };
      recoveryTerminal = false;
      pendingAbort = null;
      pendingGeneration = null;
      publish({
        status: "active",
        realtimeId: activated.mode.id,
        mode: activated.mode,
        microphone: "active",
        audibleOutput: connected.audibleOutputState(),
        bridge: bridge.snapshot(),
        connectionGeneration: targetGeneration,
        reconnectAttempt: 0,
        diagnostic:
          cause === "rotation"
            ? diagnostic(
                "rotation",
                "Provider connection rotation completed",
                true,
                targetGeneration,
              )
            : cause === "reload" || cause === "reconnect" || cause === "microphone"
              ? diagnostic("reconnect", "Realtime connection recovered", true, targetGeneration)
              : null,
        error: null,
      });
      connected.activateRemoteAudio();
      previous?.bridge.close();
      previous?.transport.stop();
      buffering = false;
      connected.events.removeEventListener("message", bufferMessage);
      for (const payload of bufferedPayloads) await bridge.ingest(payload);
      startTimers();
    } catch (error) {
      buffering = false;
      connected.events.removeEventListener("message", bufferMessage);
      connected.stop();
      if (pendingGeneration === targetGeneration) {
        pendingGeneration = null;
        pendingAbort = null;
      }
      throw error;
    }
  };

  const begin = async (
    record: OwnerRecord,
    recover: boolean,
    connectAfterBegin = true,
  ): Promise<SessionRealtimeMode | null> => {
    const response = await options.client.beginSessionRealtime(
      options.workspaceId,
      options.sessionId,
      {
        operationId: record.operationId,
        browserInstanceId: record.browserInstanceId,
        ownerKey: record.ownerKey,
        model: "gpt-live-1-boulder-alpha",
      },
    );
    if (response.mode.state !== "active") {
      transitionEnded();
      return null;
    }
    publish({ mode: response.mode, realtimeId: response.mode.id });
    if (connectAfterBegin) {
      await establish(
        record,
        response.mode,
        recover ? "reload" : "manual",
        recover || response.replay,
        false,
      );
    }
    return response.mode;
  };

  const heartbeat = async (): Promise<void> => {
    const result = await exclusive(async () => {
      const current = state.mode;
      if (!owner || !current || current.state !== "active") {
        throw new Error("Codex realtime owner is not active");
      }
      return await options.client.heartbeatSessionRealtime(
        options.workspaceId,
        options.sessionId,
        current.id,
        {
          browserInstanceId: owner.browserInstanceId,
          ownerKey: owner.ownerKey,
          expectedVersion: current.version,
        },
      );
    });
    if (result.mode.state === "ended") {
      transitionEnded("Realtime lease ended");
      return;
    }
    publish({ mode: result.mode, realtimeId: result.mode.id, error: null });
  };

  const flush = async (): Promise<void> => {
    await active?.bridge.flush();
  };

  const retry = async (): Promise<void> => {
    if (!owner || state.mode?.state !== "active") {
      throw new Error("Codex realtime owner is not recoverable");
    }
    if (recoveryTerminal || state.diagnostic?.recoverable === false) {
      throw new Error("Codex realtime recovery is terminal; stop the mode before retrying");
    }
    if (reconnectTimer !== null) unscheduleTimeout(reconnectTimer);
    reconnectTimer = null;
    const replace = !codexRealtimeMicrophoneHealthy(microphone);
    scheduleRecovery(replace ? "microphone" : "manual", replace, true);
  };

  const retryAudibleOutput = async (): Promise<boolean> => {
    if (!active || state.audibleOutput !== "blocked") return false;
    const target = active;
    const resumed = await target.transport.retryAudibleOutput();
    if (active?.generation !== target.generation) return false;
    return resumed;
  };

  const controller: CodexRealtimeController = {
    snapshot: () => ({ ...state }),
    subscribe: (listener) => {
      listeners.add(listener);
      listener({ ...state });
      return () => listeners.delete(listener);
    },
    start: async () => {
      if (state.status === "lost_owner") {
        throw new Error("Realtime mode belongs to another browser owner");
      }
      if (!["idle", "error"].includes(state.status) || state.mode?.state === "active") return;
      closed = false;
      stopping = false;
      recoveryTerminal = false;
      const record: OwnerRecord = {
        version: OWNER_RECORD_VERSION,
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        browserInstanceId: randomUUID(),
        ownerKey: `opengeni-realtime-owner:${randomUUID()}`,
        operationId: randomUUID(),
      };
      owner = record;
      storage?.setItem(storageKey, JSON.stringify(record));
      publish({ status: "starting", error: null, diagnostic: null });
      try {
        await begin(record, false);
      } catch (error) {
        closeBrowserResources(false);
        const failedMode = state.mode as SessionRealtimeMode | null;
        if (failedMode?.state === "active") {
          await handleConnectionFailure(error, "reconnect", false);
        } else {
          clearOwner();
          publish({ status: "error", realtimeId: null, mode: null, error: safeError(error) });
        }
        throw error;
      }
    },
    observeLifecycle: async (lifecycle) => {
      if (!lifecycle) {
        if (recoveryTerminal && state.mode?.state === "active") return;
        const record = readOwnerRecord(storage, storageKey, options);
        if (!record) {
          transitionEnded();
          return;
        }
        if (connectionTask || state.status === "starting" || state.status === "active") return;
        closed = false;
        stopping = false;
        owner = record;
        publish({ status: "recovering", error: null });
        connectionTask = begin(record, true)
          .then(() => undefined)
          .catch(async (error) => {
            connectionTask = null;
            await handleConnectionFailure(error, "reload", false);
          })
          .finally(() => {
            connectionTask = null;
          });
        await connectionTask;
        return;
      }
      if (lifecycle.state === "ended") {
        const record = readOwnerRecord(storage, storageKey, options);
        if (record && record.operationId !== lifecycle.operationId) {
          if (connectionTask || state.status === "active") return;
          closed = false;
          stopping = false;
          owner = record;
          connectionTask = begin(record, true)
            .then(() => undefined)
            .catch(async (error) => {
              connectionTask = null;
              await handleConnectionFailure(error, "reload", false);
            })
            .finally(() => {
              connectionTask = null;
            });
          await connectionTask;
          return;
        }
        if (state.realtimeId === null || lifecycle.realtimeId === state.realtimeId) {
          transitionEnded(`Realtime ended: ${lifecycle.reason}`);
        }
        return;
      }
      if (recoveryTerminal && state.realtimeId === lifecycle.realtimeId) return;
      if (state.status === "active" && state.realtimeId === lifecycle.realtimeId) return;
      const record = readOwnerRecord(storage, storageKey, options);
      if (!record || record.operationId !== lifecycle.operationId) {
        closeBrowserResources();
        owner = null;
        const message =
          "Realtime is active in another browser owner. It can resume after that owner stops or its lease expires.";
        publish({
          status: "lost_owner",
          realtimeId: lifecycle.realtimeId,
          mode: null,
          bridge: null,
          diagnostic: diagnostic("lost_owner", message, false),
          error: message,
        });
        return;
      }
      if (connectionTask || state.status === "starting") return;
      closed = false;
      stopping = false;
      owner = record;
      publish({ status: "recovering", realtimeId: lifecycle.realtimeId, error: null });
      connectionTask = begin(record, true)
        .then(() => undefined)
        .catch(async (error) => {
          connectionTask = null;
          await handleConnectionFailure(error, "reload", false);
        })
        .finally(() => {
          connectionTask = null;
        });
      await connectionTask;
    },
    heartbeat,
    flush,
    ingestProviderEvent: async (payload) => {
      if (!active) throw new Error("Codex realtime provider channel is not connected");
      await active.bridge.ingest(payload);
    },
    retry,
    retryAudibleOutput,
    stop: async () => {
      const currentOwner = owner;
      if (!currentOwner || !state.mode) {
        if (state.status !== "lost_owner") transitionEnded();
        return;
      }
      stopping = true;
      publish({
        status: "stopping",
        diagnostic: diagnostic("terminal_stop", "Stopping realtime and releasing media", false),
        error: null,
      });
      stopTimers();
      pendingAbort?.abort(new DOMException("Realtime stopped", "AbortError"));
      await connectionTask?.catch(() => undefined);
      closeBrowserResources();
      let current = state.mode;
      try {
        let response: SessionRealtimeMutationResponse;
        try {
          response = await exclusive(
            async () =>
              await options.client.endSessionRealtime(
                options.workspaceId,
                options.sessionId,
                current.id,
                {
                  browserInstanceId: currentOwner.browserInstanceId,
                  ownerKey: currentOwner.ownerKey,
                  expectedVersion: current.version,
                  reason: "user_stop",
                },
              ),
          );
        } catch (error) {
          if (!(error instanceof OpenGeniApiError) || error.status !== 409) throw error;
          const reconciled = await begin(currentOwner, true, false);
          if (!reconciled || reconciled.state === "ended") return;
          current = reconciled;
          response = await exclusive(
            async () =>
              await options.client.endSessionRealtime(
                options.workspaceId,
                options.sessionId,
                current.id,
                {
                  browserInstanceId: currentOwner.browserInstanceId,
                  ownerKey: currentOwner.ownerKey,
                  expectedVersion: current.version,
                  reason: "user_stop",
                },
              ),
          );
        }
        if (response.mode.state === "ended") transitionEnded("Realtime stopped by this browser");
      } catch (error) {
        stopping = false;
        owner = currentOwner;
        publish({
          status: "recovering",
          diagnostic: diagnostic("terminal_stop", safeError(error), true),
          error: safeError(error),
        });
        throw error;
      }
    },
    close: () => {
      closed = true;
      stopping = false;
      closeBrowserResources();
      listeners.clear();
    },
  };
  return controller;
}

function ownerStorageKey(workspaceId: string, sessionId: string): string {
  return `opengeni:codex-realtime-owner:${workspaceId}:${sessionId}`;
}

function readOwnerRecord(
  storage: CodexRealtimeOwnerStorage | undefined,
  key: string,
  scope: Pick<CreateCodexRealtimeControllerOptions, "workspaceId" | "sessionId">,
): OwnerRecord | null {
  const raw = storage?.getItem(key);
  if (!raw) return null;
  try {
    const parsed = recordValue(JSON.parse(raw));
    if (
      parsed?.version !== OWNER_RECORD_VERSION ||
      parsed.workspaceId !== scope.workspaceId ||
      parsed.sessionId !== scope.sessionId ||
      !stringValue(parsed.operationId) ||
      !stringValue(parsed.browserInstanceId) ||
      !stringValue(parsed.ownerKey) ||
      String(parsed.ownerKey).length < 32
    ) {
      storage?.removeItem(key);
      return null;
    }
    return parsed as OwnerRecord;
  } catch {
    storage?.removeItem(key);
    return null;
  }
}

function defaultStorage(): CodexRealtimeOwnerStorage | undefined {
  return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
}

function defaultRandomUUID(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("crypto.randomUUID is unavailable");
  return globalThis.crypto.randomUUID();
}

function waitForDataChannelOpen(events: RTCDataChannel, signal: AbortSignal): Promise<void> {
  if (events.readyState === "open") return Promise.resolve();
  if (events.readyState === "closing" || events.readyState === "closed") {
    return Promise.reject(new Error("Codex realtime data channel closed before opening"));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      events.removeEventListener("open", onOpen);
      events.removeEventListener("close", onClose);
      events.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Codex realtime data channel closed before opening"));
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Codex realtime data channel failed before opening"));
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    events.addEventListener("open", onOpen, { once: true });
    events.addEventListener("close", onClose, { once: true });
    events.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Codex realtime ${name} is invalid`);
  return value;
}

function validateReconnectBackoff(values: readonly number[]): readonly number[] {
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 60_000)
  ) {
    throw new Error("Codex realtime reconnect backoff is invalid");
  }
  return [...values];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Codex realtime browser controller failed";
}
