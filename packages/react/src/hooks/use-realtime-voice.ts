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
  errorCode: "permission_denied" | "not_supported" | "network" | "provider" | "unknown" | null;
};

type RealtimeVoiceClient = Pick<
  OpenGeniClient,
  "getSessionVoiceCapability" | "createSessionVoiceGrant"
>;

export type UseRealtimeVoiceOptions = {
  client: RealtimeVoiceClient;
  workspaceId: string;
  sessionId: string;
  adapter: RealtimeVoiceAdapter;
  sessionStatus: SessionStatus;
  onFinalTranscript: (text: string) => Promise<boolean>;
  completedAssistantMessage?: { id: string; text: string } | null | undefined;
};

export type RealtimeVoiceController = RealtimeVoiceState & {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  interrupt: () => Promise<void>;
  refreshCapability: () => Promise<void>;
};

const initialState: RealtimeVoiceState = {
  status: "authorizing",
  capability: null,
  partial: "",
  errorCode: null,
};

/** Session-bound controller. Finals use the caller's ordinary composer Send. */
export function useRealtimeVoice(options: UseRealtimeVoiceOptions): RealtimeVoiceController {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const session = useRef<RealtimeVoiceAdapterSession | null>(null);
  const revocation = useRef<Promise<void>>(Promise.resolve());
  const acceptedFinals = useRef(new Set<string>());
  const spokenMessages = useRef(new Set<string>());
  const client = useRef(options.client);
  const onFinalTranscript = useRef(options.onFinalTranscript);
  client.current = options.client;
  onFinalTranscript.current = options.onFinalTranscript;
  stateRef.current = state;

  const revokeMedia = useCallback(async (reason: string) => {
    const acquisition = pending.current;
    pending.current = null;
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

  const refreshCapability = useCallback(async () => {
    const owned = ++generation.current;
    await revokeMedia("realtime-voice-capability-refresh");
    if (generation.current !== owned) return;
    setState((current) => ({ ...current, status: "authorizing", errorCode: null }));
    try {
      const capability = await client.current.getSessionVoiceCapability(
        options.workspaceId,
        options.sessionId,
      );
      if (generation.current !== owned) return;
      setState({
        status: capability.status === "available" ? "idle" : "unavailable",
        capability,
        partial: "",
        errorCode: null,
      });
    } catch {
      if (generation.current !== owned) return;
      setState((current) => ({ ...current, status: "error", errorCode: "network" }));
    }
  }, [options.sessionId, options.workspaceId, revokeMedia]);

  useEffect(() => {
    void refreshCapability();
    return () => {
      generation.current += 1;
      void revokeMedia("realtime-voice-unmounted");
    };
  }, [refreshCapability, revokeMedia]);

  const onAdapterEvent = useCallback((owned: number, event: RealtimeVoiceAdapterEvent) => {
    if (generation.current !== owned) return;
    switch (event.type) {
      case "connected":
      case "listening":
        setState((current) => ({ ...current, status: "listening", errorCode: null }));
        return;
      case "transcript.partial":
        setState((current) => ({ ...current, partial: event.text }));
        return;
      case "transcript.final": {
        const text = event.text.trim();
        if (!text || acceptedFinals.current.has(event.providerAcceptanceId)) return;
        acceptedFinals.current.add(event.providerAcceptanceId);
        setState((current) => ({ ...current, status: "executing", partial: "" }));
        void onFinalTranscript
          .current(text)
          .then((accepted) => {
            if (!accepted) acceptedFinals.current.delete(event.providerAcceptanceId);
          })
          .catch(() => {
            acceptedFinals.current.delete(event.providerAcceptanceId);
            if (generation.current === owned) {
              setState((current) => ({ ...current, status: "error", errorCode: "unknown" }));
            }
          });
        return;
      }
      case "speaking.started":
        setState((current) => ({ ...current, status: "speaking" }));
        return;
      case "speaking.stopped":
        setState((current) => ({ ...current, status: "listening" }));
        return;
      case "reconnecting":
        setState((current) => ({ ...current, status: "reconnecting" }));
        return;
      case "error":
        setState((current) => ({
          ...current,
          status: event.recoverable ? "reconnecting" : "error",
          errorCode: event.code,
        }));
        return;
      case "closed":
        session.current = null;
        setState((current) => ({ ...current, status: "closed", partial: "" }));
    }
  }, []);

  const start = useCallback(async () => {
    if (
      session.current ||
      ["authorizing", "connecting", "closing"].includes(stateRef.current.status)
    ) {
      return;
    }
    const owned = ++generation.current;
    const controller = new AbortController();
    pending.current?.abort("realtime-voice-replaced");
    pending.current = controller;
    acceptedFinals.current.clear();
    spokenMessages.current.clear();
    setState((current) => ({ ...current, status: "authorizing", partial: "", errorCode: null }));
    try {
      const response = await client.current.createSessionVoiceGrant(
        options.workspaceId,
        options.sessionId,
      );
      if (generation.current !== owned) return;
      if (!response.grant || response.capability.status !== "available") {
        setState({
          status: "unavailable",
          capability: response.capability,
          partial: "",
          errorCode: null,
        });
        return;
      }
      setState({
        status: "connecting",
        capability: response.capability,
        partial: "",
        errorCode: null,
      });
      const connected = await options.adapter.connect(
        response.grant,
        (event) => onAdapterEvent(owned, event),
        { signal: controller.signal },
      );
      if (generation.current !== owned || controller.signal.aborted) {
        await connected.close().catch(() => undefined);
        return;
      }
      session.current = connected;
    } catch (error) {
      if (generation.current !== owned || controller.signal.aborted) return;
      const permissionDenied =
        error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name);
      setState((current) => ({
        ...current,
        status: "error",
        errorCode: permissionDenied ? "permission_denied" : "network",
      }));
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, [onAdapterEvent, options.adapter, options.sessionId, options.workspaceId]);

  const stop = useCallback(async () => {
    const owned = ++generation.current;
    setState((current) => ({ ...current, status: "closing", partial: "" }));
    await revokeMedia("realtime-voice-stopped");
    if (generation.current !== owned) return;
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
