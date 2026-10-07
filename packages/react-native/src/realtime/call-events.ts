import type { NativeCallAudioRoute, NativeCallEvent } from "./native-call";

/** A call event as the native module sends it. */
export type RawNativeCallEvent = {
  type: string;
  callId?: string;
  muted?: boolean;
  route?: string;
  target?: string | null;
};

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
    default:
      return null;
  }
}
