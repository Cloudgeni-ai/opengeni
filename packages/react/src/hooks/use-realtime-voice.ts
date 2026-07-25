import type {
  OpenGeniClient,
  RealtimeVoiceAdapter,
  RealtimeVoiceAdapterEvent,
  RealtimeVoiceAdapterSession,
  SessionStatus,
  SessionVoiceCapability,
} from "@opengeni/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

export type RealtimeVoiceStatus =
  | "idle"
  | "authorizing"
  | "connecting"
  | "listening"
  | "speaking"
  | "executing"
  | "awaiting-approval"
  | "reconnecting"
  | "closing"
  | "closed"
  | "error"
  | "unavailable";

export type RealtimeVoiceState = {
  status: RealtimeVoiceStatus;
  capability: SessionVoiceCapability | null;
  partial: string;
  /** A final whose durable Send outcome is unknown and requires an explicit retry. */
  pendingTranscript: string | null;
  errorCode: "permission_denied" | "not_supported" | "network" | "provider" | "unknown" | null;
};

/** Optional SDK refinement required only by the experimental voice hook. */
export type RealtimeVoiceClientLike = Pick<
  OpenGeniClient,
  "getSessionVoiceCapability" | "createSessionVoiceGrant"
>;

export type RealtimeVoiceFinalContext = {
  providerAcceptanceId: string;
  /** Stable ordinary Send idempotency key for this target + provider acceptance. */
  clientEventId: string;
};

export type UseRealtimeVoiceOptions = {
  client: RealtimeVoiceClientLike;
  workspaceId: string;
  sessionId: string;
  adapter: RealtimeVoiceAdapter;
  sessionStatus: SessionStatus;
  onFinalTranscript: (text: string, context: RealtimeVoiceFinalContext) => Promise<boolean>;
  completedAssistantMessage?: { id: string; text: string } | null | undefined;
  /** Time allowed for one gateway transport generation. @default 10000 */
  connectTimeoutMs?: number | undefined;
  /** Fresh-grant reconnect attempts after a recoverable transport failure. @default 3 */
  maxReconnectAttempts?: number | undefined;
  /** Base delay before a reconnect; later attempts use bounded linear backoff. @default 250 */
  reconnectDelayMs?: number | undefined;
};

export type RealtimeVoiceController = RealtimeVoiceState & {
  /** Starts voice, or explicitly retries one outcome-unknown final before reconnecting. */
  start: () => Promise<void>;
  stop: () => Promise<void>;
  interrupt: () => Promise<void>;
  refreshCapability: () => Promise<void>;
};

type FinalQueueEntry = {
  targetKey: string;
  providerAcceptanceId: string;
  clientEventId: string;
  text: string;
  submit: UseRealtimeVoiceOptions["onFinalTranscript"];
  state: "queued" | "submitting" | "outcome-unknown";
};

type RealtimeVoiceTarget = {
  key: string;
  workspaceId: string;
  sessionId: string;
};

const MAX_PROVIDER_ACCEPTANCE_ID_CHARS = 128;
const MAX_PENDING_FINALS = 64;
const MAX_ACCEPTED_FINALS = 256;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 2_000;

const initialState: RealtimeVoiceState = {
  status: "authorizing",
  capability: null,
  partial: "",
  pendingTranscript: null,
  errorCode: null,
};

/** Deterministic and bounded so a replay/remount reaches ordinary Send idempotency. */
export function realtimeVoiceClientEventId(
  workspaceId: string,
  sessionId: string,
  providerAcceptanceId: string,
): string {
  return `realtime-voice:${workspaceId}:${sessionId}:${providerAcceptanceId}`;
}

/**
 * Exact-session voice controller. Every reconnect obtains a fresh target-bound
 * grant; accepted finals serialize through the caller's ordinary composer Send.
 */
export function useRealtimeVoice(options: UseRealtimeVoiceOptions): RealtimeVoiceController {
  const targetKey = `${options.workspaceId}\u0000${options.sessionId}`;
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  const targetKeyRef = useRef(targetKey);
  const transportGeneration = useRef(0);
  const pendingConnection = useRef<AbortController | null>(null);
  const session = useRef<RealtimeVoiceAdapterSession | null>(null);
  const revocation = useRef<Promise<void>>(Promise.resolve());
  const desiredActive = useRef(false);
  const reconnectAttempt = useRef(0);
  const finalQueue = useRef<FinalQueueEntry[]>([]);
  const drainingFinals = useRef(false);
  const acceptedFinals = useRef(new Set<string>());
  const spokenMessages = useRef(new Set<string>());
  const client = useRef(options.client);
  const adapter = useRef(options.adapter);
  const onFinalTranscript = useRef(options.onFinalTranscript);
  const connectFreshRef = useRef<(reconnecting: boolean) => Promise<void>>(async () => undefined);
  const scheduleReconnectRef = useRef<
    (owned: number, code: RealtimeVoiceState["errorCode"]) => Promise<void>
  >(async () => undefined);
  const connectTimeoutMs = useRef(DEFAULT_CONNECT_TIMEOUT_MS);
  const maxReconnectAttempts = useRef(DEFAULT_MAX_RECONNECT_ATTEMPTS);
  const reconnectDelayMs = useRef(DEFAULT_RECONNECT_DELAY_MS);

  client.current = options.client;
  adapter.current = options.adapter;
  onFinalTranscript.current = options.onFinalTranscript;
  connectTimeoutMs.current = boundedInteger(
    options.connectTimeoutMs,
    DEFAULT_CONNECT_TIMEOUT_MS,
    1,
    60_000,
  );
  maxReconnectAttempts.current = boundedInteger(
    options.maxReconnectAttempts,
    DEFAULT_MAX_RECONNECT_ATTEMPTS,
    0,
    10,
  );
  reconnectDelayMs.current = boundedInteger(
    options.reconnectDelayMs,
    DEFAULT_RECONNECT_DELAY_MS,
    0,
    MAX_RECONNECT_DELAY_MS,
  );
  stateRef.current = state;
  targetKeyRef.current = targetKey;

  const revokeMedia = useCallback(async (reason: string) => {
    const acquisition = pendingConnection.current;
    pendingConnection.current = null;
    acquisition?.abort(reason);

    const active = session.current;
    session.current = null;
    let activeClose: Promise<void> = Promise.resolve();
    if (active) {
      try {
        activeClose = Promise.resolve(active.close()).then(
          () => undefined,
          () => undefined,
        );
      } catch {
        activeClose = Promise.resolve();
      }
    }
    const complete = Promise.all([revocation.current, activeClose]).then(() => undefined);
    revocation.current = complete;
    await complete;
  }, []);

  const terminalError = useCallback(
    async (code: RealtimeVoiceState["errorCode"], pendingTranscript: string | null = null) => {
      desiredActive.current = false;
      const terminalGeneration = ++transportGeneration.current;
      const ownedTarget = targetKeyRef.current;
      await revokeMedia("realtime-voice-terminal-error");
      if (
        transportGeneration.current !== terminalGeneration ||
        targetKeyRef.current !== ownedTarget
      ) {
        return;
      }
      setState((current) => ({
        ...current,
        status: "error",
        partial: "",
        pendingTranscript,
        errorCode: code,
      }));
    },
    [revokeMedia],
  );

  const rememberAcceptedFinal = useCallback((providerAcceptanceId: string) => {
    acceptedFinals.current.add(providerAcceptanceId);
    while (acceptedFinals.current.size > MAX_ACCEPTED_FINALS) {
      const oldest = acceptedFinals.current.values().next().value as string | undefined;
      if (!oldest) break;
      acceptedFinals.current.delete(oldest);
    }
  }, []);

  const drainFinalQueue = useCallback(
    async (retryOutcomeUnknown = false): Promise<void> => {
      if (drainingFinals.current) return;
      const ownedTarget = targetKeyRef.current;
      const first = finalQueue.current[0];
      if (retryOutcomeUnknown && first?.state === "outcome-unknown") first.state = "queued";
      drainingFinals.current = true;
      try {
        while (targetKeyRef.current === ownedTarget) {
          const entry = finalQueue.current[0];
          if (!entry || entry.targetKey !== ownedTarget || entry.state === "outcome-unknown")
            return;
          entry.state = "submitting";
          let accepted = false;
          try {
            accepted = await entry.submit(entry.text, {
              providerAcceptanceId: entry.providerAcceptanceId,
              clientEventId: entry.clientEventId,
            });
          } catch {
            accepted = false;
          }
          if (targetKeyRef.current !== ownedTarget) return;
          if (!accepted) {
            entry.state = "outcome-unknown";
            await terminalError("unknown", entry.text);
            return;
          }
          finalQueue.current.shift();
          rememberAcceptedFinal(entry.providerAcceptanceId);
          setState((current) => ({
            ...current,
            status: "executing",
            partial: "",
            pendingTranscript: finalQueue.current[0]?.text ?? null,
            errorCode: null,
          }));
        }
      } finally {
        drainingFinals.current = false;
      }
    },
    [rememberAcceptedFinal, terminalError],
  );

  const enqueueFinal = useCallback(
    (
      ownedTarget: RealtimeVoiceTarget,
      event: Extract<RealtimeVoiceAdapterEvent, { type: "transcript.final" }>,
    ) => {
      if (targetKeyRef.current !== ownedTarget.key) return;
      const text = event.text.trim();
      const providerAcceptanceId = event.providerAcceptanceId;
      if (!text) return;
      if (!providerAcceptanceId || providerAcceptanceId.length > MAX_PROVIDER_ACCEPTANCE_ID_CHARS) {
        void terminalError("provider");
        return;
      }
      if (
        acceptedFinals.current.has(providerAcceptanceId) ||
        finalQueue.current.some((entry) => entry.providerAcceptanceId === providerAcceptanceId)
      ) {
        return;
      }
      if (finalQueue.current.length >= MAX_PENDING_FINALS) {
        void terminalError("provider");
        return;
      }
      finalQueue.current.push({
        targetKey: ownedTarget.key,
        providerAcceptanceId,
        clientEventId: realtimeVoiceClientEventId(
          ownedTarget.workspaceId,
          ownedTarget.sessionId,
          providerAcceptanceId,
        ),
        text,
        submit: onFinalTranscript.current,
        state: "queued",
      });
      setState((current) => ({
        ...current,
        status: "executing",
        partial: "",
        pendingTranscript: finalQueue.current[0]?.text ?? null,
      }));
      void drainFinalQueue();
    },
    [drainFinalQueue, terminalError],
  );

  const scheduleReconnect = useCallback(
    async (owned: number, code: RealtimeVoiceState["errorCode"]): Promise<void> => {
      if (transportGeneration.current !== owned || !desiredActive.current) return;
      const fenced = ++transportGeneration.current;
      await revokeMedia("realtime-voice-reconnecting");
      if (transportGeneration.current !== fenced || !desiredActive.current) return;
      if (reconnectAttempt.current >= maxReconnectAttempts.current) {
        desiredActive.current = false;
        setState((current) => ({ ...current, status: "error", partial: "", errorCode: code }));
        return;
      }
      reconnectAttempt.current += 1;
      const attempt = reconnectAttempt.current;
      setState((current) => ({
        ...current,
        status: "reconnecting",
        partial: "",
        errorCode: code,
      }));
      const delay = Math.min(reconnectDelayMs.current * attempt, MAX_RECONNECT_DELAY_MS);
      if (delay > 0) await wait(delay);
      if (transportGeneration.current !== fenced || !desiredActive.current) return;
      await connectFreshRef.current(true);
    },
    [revokeMedia],
  );
  scheduleReconnectRef.current = scheduleReconnect;

  const onAdapterEvent = useCallback(
    (owned: number, ownedTarget: RealtimeVoiceTarget, event: RealtimeVoiceAdapterEvent) => {
      if (transportGeneration.current !== owned || targetKeyRef.current !== ownedTarget.key) {
        return;
      }
      switch (event.type) {
        case "connected":
        case "listening":
          setState((current) => ({ ...current, status: "listening", errorCode: null }));
          return;
        case "transcript.partial":
          setState((current) => ({ ...current, partial: event.text }));
          return;
        case "transcript.final":
          enqueueFinal(ownedTarget, event);
          return;
        case "speaking.started":
          setState((current) => ({ ...current, status: "speaking" }));
          return;
        case "speaking.stopped":
          setState((current) => ({ ...current, status: "listening" }));
          return;
        case "reconnecting":
          void scheduleReconnectRef.current(owned, "network");
          return;
        case "error":
          if (event.recoverable) void scheduleReconnectRef.current(owned, event.code);
          else void terminalError(event.code);
          return;
        case "closed":
          if (event.reason === "error") {
            void scheduleReconnectRef.current(owned, "network");
          } else {
            desiredActive.current = false;
            const terminalGeneration = ++transportGeneration.current;
            const terminalTargetKey = ownedTarget.key;
            void revokeMedia("realtime-voice-closed").then(() => {
              if (
                transportGeneration.current !== terminalGeneration ||
                targetKeyRef.current !== terminalTargetKey
              ) {
                return;
              }
              setState((current) => ({ ...current, status: "closed", partial: "" }));
            });
          }
      }
    },
    [enqueueFinal, revokeMedia, terminalError],
  );

  const connectFresh = useCallback(
    async (reconnecting: boolean): Promise<void> => {
      if (!desiredActive.current) return;
      const ownedTarget: RealtimeVoiceTarget = {
        key: targetKeyRef.current,
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
      };
      const owned = ++transportGeneration.current;
      await revokeMedia(reconnecting ? "realtime-voice-new-generation" : "realtime-voice-start");
      if (
        transportGeneration.current !== owned ||
        targetKeyRef.current !== ownedTarget.key ||
        !desiredActive.current
      ) {
        return;
      }
      setState((current) => ({
        ...current,
        status: reconnecting ? "reconnecting" : "authorizing",
        partial: "",
        pendingTranscript: null,
        errorCode: null,
      }));
      let connectionController: AbortController | null = null;
      try {
        const response = await client.current.createSessionVoiceGrant(
          options.workspaceId,
          options.sessionId,
        );
        if (
          transportGeneration.current !== owned ||
          targetKeyRef.current !== ownedTarget.key ||
          !desiredActive.current
        ) {
          return;
        }
        if (!response.grant || response.capability.status !== "available") {
          desiredActive.current = false;
          setState({
            status: "unavailable",
            capability: response.capability,
            partial: "",
            pendingTranscript: null,
            errorCode: null,
          });
          return;
        }
        setState((current) => ({
          ...current,
          status: reconnecting ? "reconnecting" : "connecting",
          capability: response.capability,
          partial: "",
          errorCode: null,
        }));
        const controller = new AbortController();
        connectionController = controller;
        pendingConnection.current = controller;
        const connection = adapter.current.connect(
          response.grant,
          (event) => onAdapterEvent(owned, ownedTarget, event),
          { signal: controller.signal },
        );
        void connection.then(
          (late) => {
            if (controller.signal.aborted || transportGeneration.current !== owned) {
              void late.close().catch(() => undefined);
            }
          },
          () => undefined,
        );
        const connected = await raceConnectionTimeout(
          connection,
          controller,
          connectTimeoutMs.current,
        );
        if (
          transportGeneration.current !== owned ||
          targetKeyRef.current !== ownedTarget.key ||
          controller.signal.aborted ||
          !desiredActive.current
        ) {
          await connected.close().catch(() => undefined);
          return;
        }
        session.current = connected;
        reconnectAttempt.current = 0;
      } catch (error) {
        if (
          transportGeneration.current !== owned ||
          targetKeyRef.current !== ownedTarget.key ||
          controllerWasDeliberatelyAborted(error)
        ) {
          return;
        }
        const permissionDenied =
          error instanceof DOMException &&
          ["NotAllowedError", "SecurityError"].includes(error.name);
        if (permissionDenied) {
          await terminalError("permission_denied");
        } else {
          void scheduleReconnectRef.current(owned, "network");
        }
      } finally {
        if (pendingConnection.current === connectionController) {
          pendingConnection.current = null;
        }
      }
    },
    [onAdapterEvent, options.sessionId, options.workspaceId, revokeMedia, terminalError],
  );
  connectFreshRef.current = connectFresh;

  const refreshCapability = useCallback(async () => {
    desiredActive.current = false;
    const owned = ++transportGeneration.current;
    const ownedTarget = targetKeyRef.current;
    await revokeMedia("realtime-voice-capability-refresh");
    if (transportGeneration.current !== owned || targetKeyRef.current !== ownedTarget) return;
    setState((current) => ({
      ...current,
      status: "authorizing",
      partial: "",
      errorCode: null,
    }));
    try {
      const capability = await client.current.getSessionVoiceCapability(
        options.workspaceId,
        options.sessionId,
      );
      if (transportGeneration.current !== owned || targetKeyRef.current !== ownedTarget) return;
      setState({
        status: capability.status === "available" ? "idle" : "unavailable",
        capability,
        partial: "",
        pendingTranscript: finalQueue.current[0]?.text ?? null,
        errorCode: null,
      });
    } catch {
      if (transportGeneration.current !== owned || targetKeyRef.current !== ownedTarget) return;
      setState((current) => ({ ...current, status: "error", errorCode: "network" }));
    }
  }, [options.sessionId, options.workspaceId, revokeMedia]);

  useEffect(() => {
    desiredActive.current = false;
    reconnectAttempt.current = 0;
    finalQueue.current = [];
    acceptedFinals.current.clear();
    spokenMessages.current.clear();
    void refreshCapability();
    return () => {
      desiredActive.current = false;
      transportGeneration.current += 1;
      void revokeMedia("realtime-voice-target-changed-or-unmounted");
    };
  }, [refreshCapability, revokeMedia, targetKey]);

  const start = useCallback(async () => {
    if (
      desiredActive.current ||
      ["authorizing", "connecting", "closing"].includes(stateRef.current.status)
    ) {
      return;
    }
    if (finalQueue.current[0]?.state === "outcome-unknown") {
      await drainFinalQueue(true);
      if (finalQueue.current[0]?.state === "outcome-unknown") return;
    }
    desiredActive.current = true;
    reconnectAttempt.current = 0;
    await connectFreshRef.current(false);
  }, [drainFinalQueue]);

  const stop = useCallback(async () => {
    desiredActive.current = false;
    const owned = ++transportGeneration.current;
    setState((current) => ({ ...current, status: "closing", partial: "" }));
    await revokeMedia("realtime-voice-stopped");
    if (transportGeneration.current !== owned) return;
    setState((current) => ({ ...current, status: "closed" }));
  }, [revokeMedia]);

  const interrupt = useCallback(async () => {
    await session.current?.interrupt().catch(() => undefined);
    // Barge-in stops playback only. Any accepted turn remains durable/running.
    setState((current) => ({ ...current, status: "listening" }));
  }, []);

  useEffect(() => {
    if (!session.current) return;
    if (options.sessionStatus === "requires_action") {
      setState((current) => ({ ...current, status: "awaiting-approval" }));
    } else if (
      ["queued", "running", "recovering", "waiting_capacity"].includes(options.sessionStatus)
    ) {
      setState((current) =>
        current.status === "speaking" ? current : { ...current, status: "executing" },
      );
    } else if (options.sessionStatus === "idle") {
      setState((current) =>
        ["executing", "awaiting-approval"].includes(current.status)
          ? { ...current, status: "listening" }
          : current,
      );
    }
  }, [options.sessionStatus]);

  useEffect(() => {
    const message = options.completedAssistantMessage;
    const active = session.current;
    if (!message || !active || !message.text.trim() || spokenMessages.current.has(message.id))
      return;
    spokenMessages.current.add(message.id);
    void active.speak({ messageId: message.id, text: message.text }).catch(() => {
      spokenMessages.current.delete(message.id);
    });
  }, [options.completedAssistantMessage]);

  return { ...state, start, stop, interrupt, refreshCapability };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function raceConnectionTimeout(
  connection: Promise<RealtimeVoiceAdapterSession>,
  controller: AbortController,
  timeoutMs: number,
): Promise<RealtimeVoiceAdapterSession> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      connection,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Realtime voice gateway connection timed out");
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function controllerWasDeliberatelyAborted(error: unknown): boolean {
  return typeof error === "string" && error.startsWith("realtime-voice-");
}
