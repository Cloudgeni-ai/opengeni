import { requireOptionalNativeModule } from "expo-modules-core";
import {
  parseNativeCallEvent,
  parseNativeIncomingCall,
  type RawNativeCallEvent,
} from "./call-events";
import type { NativeCallAdapter } from "./native-call";

type OpenGeniCallNativeModule = {
  configure(includeInRecents: boolean): void;
  startCall(callId: string, title: string, target: string | null): Promise<void>;
  reportConnected(callId: string): void;
  endCall(callId: string, failed: boolean): Promise<void>;
  setMuted(callId: string, muted: boolean): Promise<void>;
  setSpeaker(on: boolean): Promise<void>;
  takePendingStartRequest(): Promise<{ target: string | null } | null>;
  // Agent calls (absent in builds before them).
  getVoipToken?(): Promise<string | null>;
  takeIncomingCalls?(): Promise<RawNativeCallEvent[]>;
  endIncomingCall?(callId: string, reason: string): void;
  addListener(
    eventName: "onCallEvent",
    listener: (event: RawNativeCallEvent) => void,
  ): { remove(): void };
};

export { parseNativeCallEvent };

/**
 * CallKit for Expo hosts, from the native module this package ships (linked by
 * Expo autolinking). Returns null where it is unavailable (Android, web, or a
 * build without the module), so voice still works without a system call.
 */
export function createExpoCallAdapter(
  options: { includeInRecents?: boolean } = {},
): NativeCallAdapter | null {
  const native = requireOptionalNativeModule<OpenGeniCallNativeModule>("OpenGeniCall");
  if (!native) return null;
  native.configure(options.includeInRecents ?? true);
  // Call ids are UUIDs; CallKit reports them upper-case, the hook compares lower-case.
  const id = (callId: string) => callId.toLowerCase();
  return {
    startCall: ({ callId, title, target }) => native.startCall(id(callId), title, target),
    reportConnected: (callId) => native.reportConnected(id(callId)),
    endCall: (callId, reason = "ended") => native.endCall(id(callId), reason === "failed"),
    setMuted: (callId, muted) => native.setMuted(id(callId), muted),
    setSpeaker: (on) => native.setSpeaker(on),
    takePendingStartRequest: () => native.takePendingStartRequest(),
    incoming:
      native.getVoipToken && native.takeIncomingCalls && native.endIncomingCall
        ? {
            getVoipToken: () => native.getVoipToken!(),
            takeIncomingCalls: async () =>
              (await native.takeIncomingCalls!()).flatMap((raw) => {
                const call = parseNativeIncomingCall(raw);
                return call ? [call] : [];
              }),
            endIncomingCall: (callId, reason) => native.endIncomingCall!(id(callId), reason),
          }
        : undefined,
    subscribe(listener) {
      const subscription = native.addListener("onCallEvent", (raw) => {
        const event = parseNativeCallEvent(raw);
        if (event) listener(event);
      });
      return () => subscription.remove();
    },
  };
}
