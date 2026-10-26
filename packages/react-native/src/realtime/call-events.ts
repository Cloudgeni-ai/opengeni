import type { NativeCallAudioRoute, NativeCallEvent, NativeIncomingCall } from "./native-call";

/** A call event as the native module sends it. */
export type RawNativeCallEvent = {
  type: string;
  callId?: string;
  muted?: boolean;
  route?: string;
  target?: string | null;
  token?: string | null;
  reason?: string;
  sessionId?: string;
  workspaceId?: string;
  subjectId?: string;
  title?: string;
  ringUntil?: string;
  state?: string;
};

function incomingCall(raw: RawNativeCallEvent): NativeIncomingCall | null {
  if (!raw.callId || !raw.sessionId || !raw.workspaceId) return null;
  const state =
    raw.state === "answered" || raw.state === "declined" ? raw.state : ("ringing" as const);
  return {
    callId: raw.callId.toLowerCase(),
    sessionId: raw.sessionId,
    workspaceId: raw.workspaceId,
    subjectId: raw.subjectId ?? null,
    title: raw.title ?? null,
    reason: raw.reason ?? null,
    ringUntil: raw.ringUntil ?? null,
    state,
  };
}

/** A call the native module kept until JavaScript took it. */
export function parseNativeIncomingCall(raw: RawNativeCallEvent): NativeIncomingCall | null {
  return incomingCall(raw);
}

const ROUTES = new Set<NativeCallAudioRoute>([
  "receiver",
  "speaker",
  "bluetooth",
  "headphones",
  "other",
]);

/** Map a raw native event onto the typed call event, dropping anything unknown. */
export function parseNativeCallEvent(raw: RawNativeCallEvent): NativeCallEvent | null {
  switch (raw.type) {
    case "ended":
      return raw.callId ? { type: "ended", callId: raw.callId } : null;
    case "muteChanged":
      return raw.callId
        ? { type: "muteChanged", callId: raw.callId, muted: Boolean(raw.muted) }
        : null;
    case "routeChanged": {
      const route = raw.route as NativeCallAudioRoute;
      return { type: "routeChanged", route: ROUTES.has(route) ? route : "other" };
    }
    case "audioSessionActivated":
    case "audioSessionDeactivated":
      return { type: raw.type };
    case "startRequested":
      return { type: "startRequested", target: raw.target ?? null };
    case "voipToken":
      return { type: "voipToken", token: raw.token ?? null };
    case "incoming":
    case "incomingAnswered":
    case "incomingDeclined": {
      const call = incomingCall(raw);
      return call ? { type: raw.type, call } : null;
    }
    case "incomingEnded":
      return raw.callId
        ? {
            type: "incomingEnded",
            callId: raw.callId.toLowerCase(),
            reason: "unanswered",
          }
        : null;
    default:
      return null;
  }
}
