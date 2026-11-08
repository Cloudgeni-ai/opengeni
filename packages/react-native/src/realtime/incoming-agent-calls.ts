import type { AgentCall, OpenGeniClient } from "@opengeni/sdk";
import { useEffect, useRef, useState } from "react";
import type {
  NativeCallAdapter,
  NativeIncomingCall,
  NativeIncomingCallEndReason,
} from "./native-call";

/** How often a ringing phone checks whether the call was settled elsewhere. */
const WATCH_INTERVAL_MS = 1_500;

/** The ring to stop when the server settled a call this phone did not answer. */
export function incomingEndReason(call: Pick<AgentCall, "state">): NativeIncomingCallEndReason {
  switch (call.state) {
    case "answered":
      return "answeredElsewhere";
    case "declined":
      return "declinedElsewhere";
    case "missed":
      return "unanswered";
    default:
      return "remoteEnded";
  }
}

export type IncomingAgentCallsOptions = {
  client: OpenGeniClient;
  callAdapter: NativeCallAdapter | null;
  /** Prepare local call data/transport while ringing; never claim or start voice here. */
  onRinging?(call: NativeIncomingCall): void;
  /** Release preparation when the ring or system call ends. */
  onEnded?(callId: string): void;
  /** The person answered and the server gave the call to this phone: start voice. */
  onAnswered(call: NativeIncomingCall): void;
  /** Answering failed (offline, or the server refused). */
  onError?(error: unknown): void;
};

/**
 * Agents calling this phone. While a call rings, the phone follows it on the
 * server, so a call answered or declined on another phone, or cancelled by the
 * agent, stops ringing here. Answering claims it (the first phone wins) and
 * hands it to `onAnswered`; declining tells the server, which tells the agent.
 */
export function useIncomingAgentCalls(options: IncomingAgentCallsOptions): void {
  const { client, callAdapter } = options;
  const incoming = callAdapter?.incoming;
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!callAdapter || !incoming) return;
    let disposed = false;
    const watchers = new Map<string, ReturnType<typeof setInterval>>();
    /** The last state each call was handled in, so a replay does nothing. */
    const handled = new Map<string, NativeIncomingCall["state"]>();
    const preparations = new Set<string>();
    const prepare = (call: NativeIncomingCall) => {
      if (preparations.has(call.callId)) return;
      preparations.add(call.callId);
      latest.current.onRinging?.(call);
    };
    const release = (callId: string) => {
      if (preparations.delete(callId)) latest.current.onEnded?.(callId);
    };

    const stopWatching = (callId: string) => {
      const timer = watchers.get(callId);
      if (timer !== undefined) clearInterval(timer);
      watchers.delete(callId);
    };

    const ringing = (call: NativeIncomingCall) => {
      if (handled.has(call.callId) || watchers.has(call.callId)) return;
      handled.set(call.callId, "ringing");
      prepare(call);
      const check = async () => {
        try {
          const current = await client.getAgentCall(call.workspaceId, call.callId);
          if (disposed || !watchers.has(call.callId) || current.state === "ringing") return;
          stopWatching(call.callId);
          handled.set(call.callId, "declined");
          release(call.callId);
          incoming.endIncomingCall(call.callId, incomingEndReason(current));
        } catch {
          // Offline for a moment: keep ringing; the ring ends on its own deadline.
        }
      };
      watchers.set(
        call.callId,
        setInterval(() => void check(), WATCH_INTERVAL_MS),
      );
      void check();
    };

    const answered = async (call: NativeIncomingCall) => {
      if (handled.get(call.callId) === "answered" || handled.get(call.callId) === "declined")
        return;
      handled.set(call.callId, "answered");
      stopWatching(call.callId);
      // Cold launch can deliver Answer without the earlier ringing event.
      prepare(call);
      try {
        // Names this answer, so a phone that lost the race to another learns it did.
        const device = `${call.callId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
        const result = await client.answerAgentCall(call.workspaceId, call.callId, { device });
        if (disposed || handled.get(call.callId) !== "answered") return;
        if (result.state === "answered" && result.answeredHere === true) {
          preparations.delete(call.callId);
          latest.current.onAnswered(call);
          return;
        }
        incoming.endIncomingCall(call.callId, incomingEndReason(result));
        release(call.callId);
      } catch (error) {
        if (disposed || handled.get(call.callId) !== "answered") return;
        incoming.endIncomingCall(call.callId, "failed");
        release(call.callId);
        latest.current.onError?.(error);
      }
    };

    const declined = (call: NativeIncomingCall) => {
      if (handled.get(call.callId) === "declined") return;
      handled.set(call.callId, "declined");
      stopWatching(call.callId);
      release(call.callId);
      void client.declineAgentCall(call.workspaceId, call.callId).catch(() => undefined);
    };

    const handle = (call: NativeIncomingCall) => {
      if (call.state === "answered") void answered(call);
      else if (call.state === "declined") declined(call);
      else ringing(call);
    };

    const unsubscribe = callAdapter.subscribe((event) => {
      if (event.type === "incoming") ringing(event.call);
      else if (event.type === "incomingAnswered") void answered(event.call);
      else if (event.type === "incomingDeclined") declined(event.call);
      else if (event.type === "incomingEnded" || event.type === "ended") {
        stopWatching(event.callId);
        handled.set(event.callId, "declined");
        if (preparations.has(event.callId)) release(event.callId);
        else latest.current.onEnded?.(event.callId);
      }
    });
    // A push can launch the app into a ringing (or already answered) call.
    void incoming.takeIncomingCalls().then((calls) => {
      if (!disposed) calls.forEach(handle);
    });
    return () => {
      disposed = true;
      unsubscribe();
      for (const timer of watchers.values()) clearInterval(timer);
      for (const callId of preparations) release(callId);
      watchers.clear();
    };
  }, [callAdapter, client, incoming]);
}

/**
 * The PushKit token agent calls ring this phone with, kept current. Null where
 * the platform cannot ring the app, or until iOS issues one.
 */
export function useNativeVoipToken(callAdapter: NativeCallAdapter | null): string | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const incoming = callAdapter?.incoming;
    if (!callAdapter || !incoming) return;
    let disposed = false;
    const unsubscribe = callAdapter.subscribe((event) => {
      if (event.type === "voipToken") setToken(event.token);
    });
    void incoming
      .getVoipToken()
      .then((value) => {
        if (!disposed && value) setToken(value);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [callAdapter]);
  return token;
}
