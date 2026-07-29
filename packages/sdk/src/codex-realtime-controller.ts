import { createCodexRealtimeV3Bridge } from "./codex-realtime-v3";
import type { CodexRealtimeV3Bridge, CodexRealtimeV3BridgeSnapshot } from "./codex-realtime-v3";
import type { SessionRealtimeLifecycleProjection } from "./codex-realtime-lifecycle";
import { startCodexRealtimeWebrtc } from "./codex-realtime";
import type { CodexRealtimeWebrtcSession } from "./codex-realtime";
import type {
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
const OWNER_RECORD_VERSION = 1;

export type CodexRealtimeControllerStatus =
  | "idle"
  | "starting"
  | "active"
  | "stopping"
  | "recovering"
  | "lost_owner"
  | "error";

export type CodexRealtimeControllerSnapshot = {
  status: CodexRealtimeControllerStatus;
  realtimeId: string | null;
  mode: SessionRealtimeMode | null;
  bridge: CodexRealtimeV3BridgeSnapshot | null;
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
};

export type CodexRealtimeController = {
  snapshot(): CodexRealtimeControllerSnapshot;
  subscribe(listener: (snapshot: CodexRealtimeControllerSnapshot) => void): () => void;
  start(): Promise<void>;
  observeLifecycle(lifecycle: SessionRealtimeLifecycleProjection | null): Promise<void>;
  heartbeat(): Promise<void>;
  flush(): Promise<void>;
  ingestProviderEvent(payload: string): Promise<void>;
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

/**
 * Compose the existing lifecycle API, WebRTC transport, and V3 durable bridge
 * into one browser owner. The controller deliberately owns no provider
 * protocol or ledger semantics; those remain in the existing lower layers.
 */
export function createCodexRealtimeController(
  options: CreateCodexRealtimeControllerOptions,
): CodexRealtimeController {
  const storage = options.storage ?? defaultStorage();
  const storageKey = ownerStorageKey(options.workspaceId, options.sessionId);
  const randomUUID = options.randomUUID ?? defaultRandomUUID;
  const schedule =
    options.setInterval ?? ((callback, delay) => globalThis.setInterval(callback, delay));
  const unschedule =
    options.clearInterval ??
    ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  const listeners = new Set<(snapshot: CodexRealtimeControllerSnapshot) => void>();
  let owner: OwnerRecord | null = readOwnerRecord(storage, storageKey, options);
  let state: CodexRealtimeControllerSnapshot = {
    status: owner ? "recovering" : "idle",
    realtimeId: null,
    mode: null,
    bridge: null,
    error: null,
  };
  let transport: CodexRealtimeWebrtcSession | null = null;
  let bridge: CodexRealtimeV3Bridge | null = null;
  let abort: AbortController | null = null;
  let heartbeatTimer: unknown = null;
  let syncTimer: unknown = null;
  let closed = false;
  let mutationTail = Promise.resolve();

  const publish = (patch: Partial<CodexRealtimeControllerSnapshot>): void => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener({ ...state });
  };

  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = mutationTail.then(operation, operation);
    mutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  };

  const stopTimers = (): void => {
    if (heartbeatTimer !== null) unschedule(heartbeatTimer);
    if (syncTimer !== null) unschedule(syncTimer);
    heartbeatTimer = null;
    syncTimer = null;
  };

  const closeBrowserResources = (): void => {
    stopTimers();
    abort?.abort(new DOMException("Codex realtime browser owner closed", "AbortError"));
    abort = null;
    bridge?.close();
    bridge = null;
    transport?.stop();
    transport = null;
  };

  const clearOwner = (): void => {
    owner = null;
    storage?.removeItem(storageKey);
  };

  const transitionEnded = (): void => {
    closeBrowserResources();
    clearOwner();
    publish({ status: "idle", realtimeId: null, mode: null, bridge: null, error: null });
  };

  const markRecovering = (error: unknown): void => {
    publish({
      status: "recovering",
      error: safeError(error),
      realtimeId: state.mode?.id ?? state.realtimeId,
    });
  };

  const sync = async (
    realtimeId: string,
    request: SyncSessionRealtimeLedgerRequest,
  ): Promise<SyncSessionRealtimeLedgerResponse> =>
    await exclusive(async () => {
      const current = state.mode;
      if (!owner || !current || current.id !== realtimeId || current.state !== "active") {
        throw new Error("Codex realtime owner is no longer active");
      }
      return await options.client.syncSessionRealtimeLedger(
        options.workspaceId,
        options.sessionId,
        realtimeId,
        { ...request, expectedVersion: current.version },
      );
    });

  const connect = async (
    record: OwnerRecord,
    currentMode: SessionRealtimeMode,
    rotate: boolean,
  ): Promise<void> => {
    if (currentMode.state !== "active") {
      transitionEnded();
      return;
    }
    abort = new AbortController();
    publish({
      status: rotate ? "recovering" : "starting",
      realtimeId: currentMode.id,
      mode: currentMode,
      bridge: null,
      error: null,
    });
    const connected = await startCodexRealtimeWebrtc({
      realtimeId: currentMode.id,
      operationId: randomUUID(),
      browserInstanceId: record.browserInstanceId,
      ownerKey: record.ownerKey,
      expectedVersion: currentMode.version,
      expectedConnectionEpoch: currentMode.connectionEpoch,
      rotate,
      signal: abort.signal,
      remoteAudio: options.remoteAudio,
      createPeerConnection: options.createPeerConnection,
      getUserMedia: options.getUserMedia,
      negotiate: async (request, requestOptions) =>
        await options.client.negotiateCodexRealtimeWebrtc(
          options.workspaceId,
          options.sessionId,
          request,
          requestOptions,
        ),
    });
    transport = connected;
    const connectedMode = {
      ...currentMode,
      version: connected.modeVersion,
      connectionEpoch: connected.connectionEpoch,
    };
    publish({ mode: connectedMode, realtimeId: connectedMode.id });
    bridge = createCodexRealtimeV3Bridge({
      events: connected.events,
      connectionId: connected.connectionId,
      connectionEpoch: connected.connectionEpoch,
      startupFenceSequence: connected.startupFenceSequence,
      modeVersion: connected.modeVersion,
      owner: {
        browserInstanceId: record.browserInstanceId,
        ownerKey: record.ownerKey,
        expectedVersion: connected.modeVersion,
      },
      sync: async (request) => await sync(connectedMode.id, request),
      randomUUID,
      onSnapshot: (nextBridge) => publish({ bridge: nextBridge }),
    });
    await waitForDataChannelOpen(connected.events, abort.signal);
    if (closed) return;
    publish({ status: "active", error: null });
    heartbeatTimer = schedule(() => {
      void heartbeat().catch(markRecovering);
    }, HEARTBEAT_INTERVAL_MS);
    syncTimer = schedule(() => {
      void flush().catch((error) => publish({ error: safeError(error) }));
    }, OUTBOUND_SYNC_INTERVAL_MS);
  };

  const begin = async (record: OwnerRecord, recover: boolean): Promise<void> => {
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
      return;
    }
    await connect(record, response.mode, recover || response.replay);
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
      transitionEnded();
      return;
    }
    publish({ status: "active", mode: result.mode, realtimeId: result.mode.id, error: null });
  };

  const flush = async (): Promise<void> => {
    if (!bridge) return;
    await bridge.flush();
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
      if (!["idle", "error"].includes(state.status)) return;
      closed = false;
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
      publish({ status: "starting", error: null });
      try {
        await begin(record, false);
      } catch (error) {
        closeBrowserResources();
        if (state.mode?.state === "active") {
          markRecovering(error);
        } else {
          clearOwner();
          publish({ status: "error", realtimeId: null, mode: null, error: safeError(error) });
        }
        throw error;
      }
    },
    observeLifecycle: async (lifecycle) => {
      if (!lifecycle) {
        const record = readOwnerRecord(storage, storageKey, options);
        if (!record) {
          transitionEnded();
          return;
        }
        if (
          state.status === "starting" ||
          state.status === "active" ||
          (state.status === "recovering" && abort !== null)
        ) {
          return;
        }
        closed = false;
        owner = record;
        publish({ status: "recovering", error: null });
        try {
          await begin(record, true);
        } catch (error) {
          markRecovering(error);
          throw error;
        }
        return;
      }
      if (lifecycle.state === "ended") {
        const record = readOwnerRecord(storage, storageKey, options);
        if (record && record.operationId !== lifecycle.operationId) {
          if (state.status === "active" || (state.status === "recovering" && abort !== null)) {
            return;
          }
          closed = false;
          owner = record;
          publish({ status: "recovering", error: null });
          try {
            await begin(record, true);
          } catch (error) {
            markRecovering(error);
            throw error;
          }
          return;
        }
        if (state.realtimeId === null || lifecycle.realtimeId === state.realtimeId) {
          transitionEnded();
        }
        return;
      }
      if (state.status === "active" && state.realtimeId === lifecycle.realtimeId) return;
      const record = readOwnerRecord(storage, storageKey, options);
      if (!record || record.operationId !== lifecycle.operationId) {
        closeBrowserResources();
        owner = null;
        publish({
          status: "lost_owner",
          realtimeId: lifecycle.realtimeId,
          mode: null,
          bridge: null,
          error:
            "Realtime is active in another browser owner. It can resume after that owner stops or its lease expires.",
        });
        return;
      }
      if (state.status === "starting" || (state.status === "recovering" && abort !== null)) {
        return;
      }
      closed = false;
      owner = record;
      publish({ status: "recovering", realtimeId: lifecycle.realtimeId, error: null });
      try {
        await begin(record, true);
      } catch (error) {
        markRecovering(error);
        throw error;
      }
    },
    heartbeat,
    flush,
    ingestProviderEvent: async (payload) => {
      if (!bridge) throw new Error("Codex realtime provider channel is not connected");
      await bridge.ingest(payload);
    },
    stop: async () => {
      const current = state.mode;
      const currentOwner = owner;
      if (!current || !currentOwner) {
        if (state.status !== "lost_owner") transitionEnded();
        return;
      }
      publish({ status: "stopping", error: null });
      closeBrowserResources();
      try {
        const response = await exclusive(
          async () =>
            await options.client.endSessionRealtime(
              options.workspaceId,
              options.sessionId,
              current.id,
              {
                browserInstanceId: currentOwner.browserInstanceId,
                ownerKey: currentOwner.ownerKey,
                expectedVersion: state.mode?.version ?? current.version,
                reason: "user_stop",
              },
            ),
        );
        if (response.mode.state === "ended") transitionEnded();
      } catch (error) {
        owner = currentOwner;
        markRecovering(error);
        throw error;
      }
    },
    close: () => {
      closed = true;
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Codex realtime browser controller failed";
}
