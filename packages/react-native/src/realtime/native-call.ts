import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionRealtimeControllerSnapshot } from "@opengeni/sdk/realtime";
import { sessionRealtimeTransportKind } from "@opengeni/sdk/realtime";
import type { SessionRealtimeModel } from "@opengeni/sdk";

/** System events from the platform call service (CallKit on iOS). */
export type NativeCallEvent =
  /** The person ended the call from the system UI, lock screen or headset. */
  | { type: "ended"; callId: string }
  /** The person muted or unmuted from the system UI. */
  | { type: "muteChanged"; callId: string; muted: boolean }
  /** The audio route changed (speaker, receiver, AirPods, CarPlay). */
  | { type: "routeChanged"; route: NativeCallAudioRoute }
  /** The system activated or released the call audio session (forwarded to WebRTC). */
  | { type: "audioSessionActivated" }
  | { type: "audioSessionDeactivated" }
  /**
   * The system asked the app to start a call from outside it (Siri, the Phone
   * app's recents, an App Intent or a shortcut). `target` is the host's own
   * call target, for example a session id, or absent for the default.
   */
  | { type: "startRequested"; target: string | null };

export type NativeCallAudioRoute = "receiver" | "speaker" | "bluetooth" | "headphones" | "other";

/**
 * The platform call service seam. The OpenGeni Expo module implements it with
 * CallKit; hosts on other platforms can implement it or omit it, in which case
 * the realtime session runs without a system call.
 */
export interface NativeCallAdapter {
  /** Report an outgoing call to the system and activate the call audio session. */
  startCall(call: { callId: string; title: string; target: string | null }): Promise<void>;
  /** The voice connection is live: the system call shows as connected. */
  reportConnected(callId: string): void;
  /** End the system call. `failed` reports a failure rather than a normal hang-up. */
  endCall(callId: string, reason?: "ended" | "failed"): Promise<void>;
  setMuted(callId: string, muted: boolean): Promise<void>;
  /** Route call audio to the loudspeaker, or back to the default route. */
  setSpeaker(on: boolean): Promise<void>;
  subscribe(listener: (event: NativeCallEvent) => void): () => void;
  /** A start request that launched the app before JavaScript subscribed. */
  takePendingStartRequest(): Promise<{ target: string | null } | null>;
}

/** Native hosts can stream voice over WebRTC; WebSocket audio transports need a browser. */
export function nativeRealtimeModelSupported(model: SessionRealtimeModel): boolean {
  const transport = sessionRealtimeTransportKind(model);
  return transport === "codex" || transport === "azure-live";
}

/** The slice of `useSessionRealtime` a call drives. */
export type NativeCallRealtime = {
  snapshot: SessionRealtimeControllerSnapshot;
  canStart: boolean;
  admissionBlocker: string | null;
  start(): Promise<void>;
  stop(): Promise<void>;
  setInputMuted(muted: boolean): void;
};

export type NativeCallPhase = "idle" | "connecting" | "active" | "reconnecting" | "ending";

export type NativeRealtimeCall = {
  phase: NativeCallPhase;
  muted: boolean;
  speaker: boolean;
  route: NativeCallAudioRoute | null;
  error: string | null;
  canStart: boolean;
  start(): Promise<void>;
  end(): Promise<void>;
  setMuted(muted: boolean): void;
  setSpeaker(on: boolean): void;
};

function randomCallId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  // RFC 4122 v4 layout; CallKit only needs a unique UUID string.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

/**
 * Keep one system call and one shared realtime session in lockstep: starting
 * reports an outgoing call and starts voice; the call shows connected once
 * voice is live; hanging up anywhere (app, lock screen, headset) stops voice,
 * and voice ending or failing ends the call. Mute is mirrored both ways.
 */
export function useNativeRealtimeCall(options: {
  realtime: NativeCallRealtime;
  call?: NativeCallAdapter | null | undefined;
  title: string;
  target?: string | null | undefined;
}): NativeRealtimeCall {
  const { realtime, call } = options;
  const [callId, setCallId] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const [speaker, setSpeakerState] = useState(false);
  const [route, setRoute] = useState<NativeCallAudioRoute | null>(null);
  const [error, setError] = useState<string | null>(null);
  const callIdRef = useRef<string | null>(null);
  const connectedRef = useRef<string | null>(null);
  const realtimeRef = useRef(realtime);
  realtimeRef.current = realtime;
  const status = realtime.snapshot.status;
  const muted = realtime.snapshot.inputMuted;

  const finish = useCallback(
    async (reason: "ended" | "failed") => {
      const id = callIdRef.current;
      if (!id) return;
      callIdRef.current = null;
      connectedRef.current = null;
      setCallId(null);
      setEnding(false);
      setSpeakerState(false);
      await call?.endCall(id, reason).catch(() => undefined);
    },
    [call],
  );

  useEffect(() => {
    if (!call) return;
    return call.subscribe((event) => {
      if (event.type === "routeChanged") {
        setRoute(event.route);
        setSpeakerState(event.route === "speaker");
        return;
      }
      if (
        event.type === "startRequested" ||
        event.type === "audioSessionActivated" ||
        event.type === "audioSessionDeactivated"
      )
        return;
      if (event.callId !== callIdRef.current) return;
      if (event.type === "ended") {
        callIdRef.current = null;
        connectedRef.current = null;
        setCallId(null);
        setEnding(false);
        void realtimeRef.current.stop().catch(() => undefined);
      } else if (event.type === "muteChanged") {
        realtimeRef.current.setInputMuted(event.muted);
      }
    });
  }, [call]);

  // The system call shows connected exactly once, when voice first goes live.
  useEffect(() => {
    const id = callIdRef.current;
    if (id && status === "active" && connectedRef.current !== id) {
      connectedRef.current = id;
      call?.reportConnected(id);
    }
  }, [call, status, callId]);

  // Voice ending or failing ends the call; a reconnect keeps it.
  useEffect(() => {
    if (!callIdRef.current) return;
    if (status === "error" || status === "lost_owner") {
      setError(realtime.snapshot.error ?? "Voice disconnected.");
      void finish("failed");
    } else if (status === "idle" && connectedRef.current === callIdRef.current) {
      void finish("ended");
    }
  }, [finish, realtime.snapshot.error, status]);

  const start = useCallback(async () => {
    if (callIdRef.current) return;
    const current = realtimeRef.current;
    if (!current.canStart) {
      throw new Error(current.admissionBlocker ?? "Voice is not ready yet.");
    }
    const id = randomCallId();
    callIdRef.current = id;
    setCallId(id);
    setError(null);
    try {
      await call?.startCall({ callId: id, title: options.title, target: options.target ?? null });
      await current.start();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the call.");
      await finish("failed");
      throw cause;
    }
  }, [call, finish, options.target, options.title]);

  const end = useCallback(async () => {
    if (!callIdRef.current) return;
    setEnding(true);
    await realtimeRef.current.stop().catch(() => undefined);
    await finish("ended");
  }, [finish]);

  const setMuted = useCallback(
    (next: boolean) => {
      realtimeRef.current.setInputMuted(next);
      const id = callIdRef.current;
      if (id) void call?.setMuted(id, next).catch(() => undefined);
    },
    [call],
  );

  const setSpeaker = useCallback(
    (on: boolean) => {
      setSpeakerState(on);
      void call?.setSpeaker(on).catch(() => setSpeakerState(!on));
    },
    [call],
  );

  const phase: NativeCallPhase = !callId
    ? "idle"
    : ending || status === "stopping"
      ? "ending"
      : status === "active"
        ? "active"
        : status === "recovering" && connectedRef.current === callId
          ? "reconnecting"
          : "connecting";

  return {
    phase,
    muted,
    speaker,
    route,
    error,
    canStart: !callId && realtime.canStart,
    start,
    end,
    setMuted,
    setSpeaker,
  };
}
